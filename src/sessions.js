'use strict';

// Watches Claude Code activity on this machine and reports one status per session.
//
// Sources (all local, read-only):
//   - Claude desktop's session index: <appData>/Claude/claude-code-sessions/<account>/<org>/local_*.json
//     (title, archived flag, when you last looked at the session, end-of-turn summary)
//   - Claude Code transcripts: ~/.claude/projects/<project>/<cliSessionId>.jsonl
//     For SSH (and WSL) sessions the desktop app copies the remote transcript to ssh-<id>/,
//     but only when a turn ends or you open the session. While a turn runs, the desktop
//     index (which it saves as prompts and replies arrive) shows what the copy is missing.
//   - The other transcripts (Claude Code in VS Code, or `claude` in a terminal) are reported as
//     kind "cli", with `client` 'vscode' or 'terminal' (clientOf): all of them in the sidebar, the
//     last week's followed as they're written, older ones from a quick look at each (quickState).
//     Besides this PC's, the ones in WSL (setCliRoots: its ~/.claude/projects, read from here
//     while the distro runs) and on SSH hosts (setRemoteChats: sent by claude-remote.js's watcher).

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  STALE_RUNNING_MS, UNREAD_WINDOW_MS, applyEntry, compareSessions, createTurnState, deriveStatus, describeAsk,
} = require('./transcript');
const { steadySkew } = require('./ssh-watcher');

const HOST_ID_RE = /^local_[A-Za-z0-9-]{1,64}$/;
const BRIDGE_ID_RE = /^session_[A-Za-z0-9]{8,64}$/;   // a Remote Control session: https://claude.ai/code/<id>
const TRANSCRIPT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const INITIAL_TAIL_BYTES = 768 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const META_SCAN_MS = 3000;
const PROJECT_SCAN_MS = 15000;
const DESKTOP_RECENT_MS = 7 * 24 * 60 * 60 * 1000;   // and past it while its last turn may still be Ready
const CLI_FOLLOW_MS = 7 * 24 * 60 * 60 * 1000;       // VS Code and terminal sessions followed as they're written
const CLI_PEEK_BYTES = 64 * 1024;                    // ... and older ones looked at this much at each end
const ENTRYPOINT_RE = /"entrypoint":"([^"\\]*)"/;
const CLI_REVIEW_MS = 10 * 60 * 1000;                // a turn that ended before cliReadyFrom: Ready this long
const DISMISSED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PROJECT_DIRS = 400;
const CLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const RELEASED_SUFFIX = '.desktop-released.json';
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_SLACK_MS = 3000;   // log times are whole seconds, and the clock skew is an estimate
// A second copy of the app (opening any claude:// link starts one) hands over and quits within
// a second of starting. A start nothing like that follows within this long was the app itself.
const LAUNCH_SETTLE_MS = 5000;
// The longest to wait for a turn's summary. The app waits 5 s before it notifies you, but they
// often take 3–4 s, and the wait ends as soon as one comes.
const SUMMARY_WAIT_MS = 10_000;
const KICK_DELAY_MS = 100;          // lets a burst of file changes settle into one update
const PROJECT_KICK_MIN_MS = 2000;   // scanning every project folder is the costly part

function defaultPaths(appDataDir) {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    sessionsRoot: path.join(appDataDir, 'Claude', 'claude-code-sessions'),
    projectsRoot: path.join(claudeHome, 'projects'),
    appLog: appLogPath(appDataDir),
    sshConnections: path.join(appDataDir, 'Claude', 'ssh_configs.json'),
  };
}

// The desktop app's main log. The Microsoft Store build writes it under LocalAppData.
function appLogPath(appDataDir) {
  const candidates = process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Logs', 'Claude', 'main.log')]
    : [
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude', 'logs', 'main.log'),
      path.join(appDataDir, 'Claude', 'logs', 'main.log'),
    ];
  let best = candidates[0];
  let bestMtime = -1;
  for (const file of candidates) {
    try {
      const { mtimeMs } = fs.statSync(file);
      if (mtimeMs > bestMtime) [best, bestMtime] = [file, mtimeMs];
    } catch {
      // not there
    }
  }
  return best;
}

async function readdirSafe(dir, opts) {
  try {
    return await fsp.readdir(dir, opts);
  } catch {
    return [];
  }
}

async function statSafe(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

// Follows a growing text file, starting near its end, and hands each new line to handleLine().
class FileFollower {
  constructor(file, tailBytes) {
    this.file = file;
    this.tailBytes = tailBytes;
    this.offset = -1;
    this.size = -1;
    this.mtimeMs = 0;
    this.partial = Buffer.alloc(0);
  }

  reset() {}

  handleLine() {}

  async poll() {
    const st = await statSafe(this.file);
    if (!st) return false;
    this.mtimeMs = st.mtimeMs;
    if (st.size === this.size) return false;
    if (st.size < this.offset) {
      this.offset = -1;
      this.partial = Buffer.alloc(0);
      this.reset();
    }
    let start = this.offset;
    let skipFirstLine = false;
    if (start < 0) {
      start = Math.max(0, st.size - this.tailBytes);
      skipFirstLine = start > 0;
    }
    const end = Math.min(st.size, start + MAX_READ_BYTES);
    if (end <= start) {
      this.offset = start;
      this.size = st.size;
      return false;
    }
    const buf = Buffer.alloc(end - start);
    const fh = await fsp.open(this.file, 'r');
    try {
      await fh.read(buf, 0, buf.length, start);
    } finally {
      await fh.close();
    }
    let data = this.partial.length ? Buffer.concat([this.partial, buf]) : buf;
    if (skipFirstLine) {
      const nl = data.indexOf(0x0a);
      data = nl >= 0 ? data.subarray(nl + 1) : Buffer.alloc(0);
    }
    const lastNl = data.lastIndexOf(0x0a);
    const complete = lastNl >= 0 ? data.subarray(0, lastNl) : Buffer.alloc(0);
    this.partial = Buffer.from(lastNl >= 0 ? data.subarray(lastNl + 1) : data);
    for (const line of complete.toString('utf8').split('\n')) {
      if (line.trim()) this.handleLine(line);
    }
    this.offset = end;
    this.size = end === st.size ? st.size : -1;
    return true;
  }
}

// Follows one JSONL transcript incrementally and keeps its turn state up to date.
class TranscriptFollower extends FileFollower {
  constructor(file) {
    super(file, INITIAL_TAIL_BYTES);
    this.state = createTurnState();
  }

  reset() {
    this.state = createTurnState();
  }

  handleLine(line) {
    try {
      applyEntry(this.state, JSON.parse(line));
    } catch {
      // A line we can't parse (or a newer format) shouldn't break the pet.
    }
  }
}

// Follows the desktop app's log, which records every prompt it sends to a session, every turn
// that ends and every time Claude stops to ask you something, as they happen. For SSH sessions
// that's the only live signal.
class AppLogFollower extends FileFollower {
  constructor(file) {
    super(file, LOG_TAIL_BYTES);
    this.turns = new Map();   // hostSessionId -> { running, at }, from the newest line about it
    this.asks = new Map();    // requestId -> { sessionId, tool, at }, until you answer
    this.launches = [];       // starts of the app not yet known to be a second copy of it
  }

  handleLine(line) {
    const e = parseLogLine(line);
    if (!e) return;
    this.settleLaunches(e.at);
    switch (e.kind) {
      case 'ask':
        this.asks.set(e.requestId, { sessionId: e.sessionId, tool: e.tool, at: e.at });
        return;
      case 'answer':
        this.asks.delete(e.requestId);
        return;
      case 'launch':
        this.launches.push(e.at);
        return;
      case 'second':
        this.launches.pop();
        return;
      case 'start':
        // A new prompt withdraws whatever was asked before it. The end of a turn doesn't: the app
        // asks some questions of its own as a turn ends (whether to load the mods Claude wrote),
        // and they stay up until you answer.
        for (const [id, ask] of this.asks) if (ask.sessionId === e.sessionId && ask.at <= e.at) this.asks.delete(id);
        // falls through
      default:
        this.turns.set(e.sessionId, { running: e.kind === 'start', at: e.at });
    }
  }

  // The app (re)started at a launch that no second copy's quitting followed. The questions went
  // with the sessions' CLIs. `now` is a time on the log's clock.
  settleLaunches(now) {
    let restartedAt = 0;
    while (this.launches.length && now - this.launches[0] > LAUNCH_SETTLE_MS) restartedAt = this.launches.shift();
    if (!restartedAt) return;
    for (const [id, ask] of this.asks) if (ask.at < restartedAt) this.asks.delete(id);
  }

  // What the log says about a session: { running, at, asking }, where `asking` is the oldest
  // question still waiting for your answer ({ tool, at }) or null. Null if the log hasn't
  // mentioned the session.
  turnOf(sessionId) {
    let asking = null;
    for (const ask of this.asks.values()) {
      if (ask.sessionId === sessionId && (!asking || ask.at < asking.at)) asking = { tool: ask.tool, at: ask.at };
    }
    const turn = this.turns.get(sessionId) ?? (asking && { running: true, at: asking.at });
    return turn ? { ...turn, asking } : null;
  }
}

const LOG_LINE_RE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:[.,](\d{1,3}))? \[\w+\] (.*)$/;
const LOG_EVENTS = [
  // A prompt handed to the session's CLI. The app logs the "Mapping" line for every prompt it
  // passes on (including ones it doesn't log as "Sending message", such as queued prompts).
  [/^Sending message to session (?<session>local_[\w-]+)/, 'start'],
  [/^Mapping internal session (?<session>local_[\w-]+) to CLI session/, 'start'],
  // The first reply after the app (re)started a session's CLI for a prompt. ("Starting local
  // session" itself also appears for pre-warmed sessions and rewinds, which don't run a turn.)
  [/^\[CCD start-timing\] (?<session>local_[\w-]+)\b(?:.*?\btotal_to_assistant=(?<ms>\d+)ms)?/, 'start'],
  [/^\[CCD CycleHealth\] (?:un)?healthy cycle for (?<session>local_[\w-]+)/, 'end'],
  [/^\[Stop hook\] Query completed for session (?<session>local_[\w-]+)/, 'end'],
  [/^Session (?<session>local_[\w-]+) query iterator completed/, 'end'],
  // Claude stops to ask you something (AskUserQuestion, ExitPlanMode) or for permission to use a
  // tool, and later you answer, or the question is withdrawn (you stopped the turn, say). Both
  // name only the request. The app asks its own questions the same way.
  [/^Emitted tool permission request (?<request>[\w-]+) for (?<tool>\S+) in session (?<session>local_[\w-]+)/, 'ask'],
  [/^Received permission response for (?<request>[\w-]+)/, 'answer'],
  [/^Permission request (?<request>[\w-]+) for \S+ aborted/, 'answer'],
  // Every copy of the app logs its start, and a second one (started by a claude:// link) then
  // says it isn't the main one and quits.
  [/^Starting app\b/, 'launch'],
  [/^Not main instance\b/, 'second'],
];

// "2026-09-24 23:47:34 [info] Sending message to session local_…" (local time)
function parseLogLine(line) {
  const m = LOG_LINE_RE.exec(line.trimEnd());
  if (!m) return null;
  for (const [re, kind] of LOG_EVENTS) {
    const e = re.exec(m[8]);
    if (!e) continue;
    const g = e.groups ?? {};
    const at = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)).getTime();
    const event = { kind, sessionId: g.session ?? null, at: at - (Number(g.ms) || 0) };
    if (g.request) event.requestId = g.request;
    if (g.tool) event.tool = g.tool;
    return event;
  }
  return null;
}

class SessionTracker extends EventEmitter {
  constructor({
    sessionsRoot, projectsRoot, appLog = null, sshConnections = null, pollMs = 1000, now = Date.now, dismissed = {}, readyFrom = null,
    cliReadyFrom = null,
  } = {}) {
    super();
    this.sessionsRoot = sessionsRoot;
    this.projectsRoot = projectsRoot;
    this.appLog = appLog ? new AppLogFollower(appLog) : null;
    this.sshConnectionsFile = sshConnections;
    this.connectionNames = new Map();  // machineKey -> the name you gave the SSH connection
    this.connectionsStamp = '';
    this.pollMs = pollMs;
    this.now = now;
    this.desktop = new Map();          // hostSessionId -> record from the desktop index
    this.desktopOwned = new Set();     // every cliSessionId the desktop knows, archived included
    this.metaCache = new Map();        // index file -> { mtimeMs, size, record }
    this.followers = new Map();        // transcript path -> TranscriptFollower
    this.transcriptFor = new Map();    // cliSessionId -> transcript path
    this.clockSkews = new Map();       // machineKey -> clockSkew's last answer
    this.cliSessions = new Map();      // cliSessionId -> { file, root, machineKey, machine, followed, mtimeMs } (not the desktop's)
    this.cliPeeks = new Map();         // transcript path -> { mtimeMs, size, state }: an older one's quick look
    // VS Code and terminal sessions whose turn ended from then on are Ready until marked done (as
    // the desktop's are from readyFrom); before, Ready for a few minutes, the pet can't tell more.
    this.cliReadyFrom = cliReadyFrom;
    this.cliRoots = [];                // WSL's projects folders: { root, machineKey, machine, active }
    this.remoteChats = [];             // the SSH hosts' VS Code and terminal sessions (setRemoteChats)
    this.projectDirs = [];
    this.dismissed = new Map(Object.entries(dismissed));
    this.readyFrom = readyFrom;        // turns ending from then on are Ready until dismissed (transcript.js)
    this.lastMetaScan = 0;
    this.lastProjectScan = 0;
    this.lastEmitted = '';
    this.sessions = [];
    this.all = [];                     // every desktop session in the index, and the week's VS Code and terminal ones, for folder mode
    this.lastListed = '';
    this.busy = false;
    this.rerun = false;
    this.running = false;
    this.timer = null;
    this.watchers = [];
    this.kickTimer = null;
    this.changed = new Set();          // files reported changed since the last update
    this.indexDirty = false;
    this.projectsDirty = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.watchFiles();
    const loop = async () => {
      await this.tick().catch((err) => this.emit('error', err));
      if (this.running) this.timer = setTimeout(loop, this.pollMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  // React to changes as soon as the OS reports them. The polling timer stays as a fallback,
  // and for changes that come with time, like a turn going stale.
  watchFiles() {
    const watch = (dir, opts, onChange) => {
      try {
        const w = fs.watch(dir, opts, (_event, name) => onChange(name ? String(name) : null));
        w.on('error', () => {
          w.close();
          this.watchers = this.watchers.filter((x) => x !== w);
        });
        this.watchers.push(w);
      } catch {
        // The folder is missing or can't be watched; the timer still picks changes up.
      }
    };
    if (this.sessionsRoot) watch(this.sessionsRoot, { recursive: true }, () => this.kick({ index: true }));
    if (this.projectsRoot) watch(this.projectsRoot, { recursive: true }, (name) => this.onProjectChange(name));
    if (this.appLog) {
      const { file } = this.appLog;
      watch(path.dirname(file), {}, (name) => {
        if (!name || name === path.basename(file)) this.kick({ file });
      });
    }
  }

  onProjectChange(name) {
    if (!name) {
      this.kick({ projects: true });
      return;
    }
    const parts = name.split(/[\\/]/);
    if (parts.length !== 2 || !TRANSCRIPT_RE.test(parts[1])) return;   // not a session transcript
    const file = path.join(this.projectsRoot, name);
    if (this.followers.has(file)) this.kick({ file });
    else if (parts[0].startsWith('ssh-')) this.kick({ index: true });   // an SSH copy: findTranscript knows where
    else this.kick({ projects: true });   // a transcript we don't follow yet
  }

  kick({ file = null, index = false, projects = false } = {}) {
    if (file) this.changed.add(file);
    if (index) this.indexDirty = true;
    if (projects) this.projectsDirty = true;
    if (!this.running || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      const only = this.changed;
      this.changed = new Set();
      this.tick(only).catch((err) => this.emit('error', err));
    }, KICK_DELAY_MS);
  }

  // WSL's projects folders, [{ root, machineKey, machine, active }]. A distro's files are read only
  // while it runs (`active`): reading them starts it, and it would never stop again. Its sessions
  // stay as last seen meanwhile.
  setCliRoots(roots) {
    this.cliRoots = roots;
    this.kick({ projects: true });
  }

  // The SSH hosts' VS Code and terminal sessions: [{ id, sessionId, state, machineKey, machine,
  // remote, skew }], `state` a turn state (transcript.js) on the host's clock, `skew` how far that
  // clock is ahead of ours.
  setRemoteChats(chats) {
    this.remoteChats = chats;
    this.recompute();
  }

  dismiss(id) {
    this.dismissed.set(id, this.now());
    this.recompute(true);
  }

  // Undoes dismiss: the session's own Ready, Error or Needs you comes back.
  undismiss(id) {
    if (this.dismissed.delete(id)) this.recompute(true);
  }

  // Kept as long as the session's last turn could still show as Ready, which only its dismissal ends.
  dismissedSnapshot() {
    const cutoff = this.now() - DISMISSED_KEEP_MS;
    return Object.fromEntries([...this.dismissed].filter(([, t]) => t > cutoff));
  }

  // `only` is the set of files reported changed; null (the timer) checks every file.
  async tick(only = null) {
    if (this.busy) {
      for (const file of only ?? []) this.changed.add(file);
      this.rerun = true;
      return;
    }
    this.busy = true;
    try {
      const now = this.now();
      const metaDue = this.indexDirty || now - this.lastMetaScan >= META_SCAN_MS;
      if (metaDue) {
        this.indexDirty = false;
        this.lastMetaScan = now;
        await this.scanDesktopIndex();
        await this.loadConnectionNames();
      }
      const projectsDue = now - this.lastProjectScan >= (this.projectsDirty ? PROJECT_KICK_MIN_MS : PROJECT_SCAN_MS);
      if (projectsDue) {
        this.projectsDirty = false;
        this.lastProjectScan = now;
        await this.scanProjects();
      }
      if (metaDue || projectsDue) await this.resolveTranscripts();
      const asleep = this.cliRoots.filter((r) => !r.active).map((r) => r.root);
      for (const [file, follower] of this.followers) {
        if (asleep.some((root) => file.startsWith(root))) continue;   // a stopped WSL distro's
        if (!only || only.has(file) || follower.offset < 0) await follower.poll().catch(() => {});
      }
      if (this.appLog) {
        if (!only || only.has(this.appLog.file)) await this.appLog.poll().catch(() => {});
        this.appLog.settleLaunches(now);
      }
      this.recompute();
    } finally {
      this.busy = false;
      if (this.rerun) {
        this.rerun = false;
        this.kick();
      }
    }
  }

  async scanDesktopIndex() {
    const seen = new Set();
    const owned = new Set();
    for (const account of await readdirSafe(this.sessionsRoot)) {
      for (const org of await readdirSafe(path.join(this.sessionsRoot, account))) {
        const dir = path.join(this.sessionsRoot, account, org);
        for (const name of await readdirSafe(dir)) {
          if (!/^local_.*\.json$/.test(name)) continue;
          const file = path.join(dir, name);
          const st = await statSafe(file);
          if (!st) continue;
          let cached = this.metaCache.get(file);
          if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
            let record = null;
            try {
              record = parseDesktopSession(JSON.parse(await fsp.readFile(file, 'utf8')));
            } catch {
              record = cached?.record ?? null;   // mid-write; keep the previous copy
            }
            cached = { mtimeMs: st.mtimeMs, size: st.size, record };
            this.metaCache.set(file, cached);
          }
          const r = cached.record;
          if (r?.cliSessionId) owned.add(r.cliSessionId);
          for (const id of r?.priorCliSessionIds ?? []) owned.add(id);   // before a compaction or /clear
          if (r && !r.isArchived) {
            this.desktop.set(r.hostSessionId, r);
            seen.add(r.hostSessionId);
          }
        }
      }
    }
    for (const id of [...this.desktop.keys()]) {
      if (!seen.has(id)) this.desktop.delete(id);
    }
    this.desktopOwned = owned;
  }

  // The WSL distros the desktop app has run sessions in, archived ones included.
  wslDistros() {
    const distros = new Set();
    for (const { record } of this.metaCache.values()) {
      if (record?.machineKey?.startsWith('wsl:') && record.machine) distros.add(record.machine);
    }
    return [...distros].sort();
  }

  // The names you gave your SSH connections in the desktop app, e.g. "lab-server".
  async loadConnectionNames() {
    if (!this.sshConnectionsFile) return;
    const st = await statSafe(this.sshConnectionsFile);
    const stamp = st ? `${st.mtimeMs}:${st.size}` : '';
    if (stamp === this.connectionsStamp) return;
    try {
      this.connectionNames = st ? parseSshConnections(JSON.parse(await fsp.readFile(this.sshConnectionsFile, 'utf8'))) : new Map();
      this.connectionsStamp = stamp;
    } catch {
      // mid-write; keep the names we had and try again on the next scan
    }
  }

  // The project folders, newest first, and the VS Code and terminal sessions in them, here and in
  // the WSL distros that run.
  async scanProjects() {
    this.projectDirs = await projectDirsOf(this.projectsRoot);
    const live = new Map();
    await this.findChats(this.projectDirs, { root: null, machineKey: null, machine: null }, live);
    for (const r of this.cliRoots) {
      if (r.active) await this.findChats(await projectDirsOf(r.root), r, live);
      else for (const [id, c] of this.cliSessions) if (c.root === r.root) live.set(id, c);
    }
    this.cliSessions = live;
  }

  // Into `live`: the transcripts in `dirs` that the desktop doesn't own. The last week's are
  // followed; an older one is looked at once (again when it changes) for its title and place.
  async findChats(dirs, { root, machineKey, machine }, live) {
    const cutoff = this.now() - CLI_FOLLOW_MS;
    for (const dir of dirs) {
      for (const name of await readdirSafe(dir)) {
        const m = TRANSCRIPT_RE.exec(name);
        if (!m || this.desktopOwned.has(m[1])) continue;
        const file = path.join(dir, name);
        const st = await statSafe(file);
        if (!st || (await releasedBefore(dir, m[1], st.mtimeMs))) continue;
        const followed = st.mtimeMs >= cutoff;
        if (!followed) {
          const peek = this.cliPeeks.get(file);
          if (!peek || peek.mtimeMs !== st.mtimeMs || peek.size !== st.size) {
            this.cliPeeks.set(file, { mtimeMs: st.mtimeMs, size: st.size, state: await quickState(file, st.size) });
          }
        }
        live.set(m[1], { file, root, machineKey, machine, followed, mtimeMs: st.mtimeMs });
      }
    }
  }

  async resolveTranscripts() {
    const wanted = new Set();
    for (const r of this.desktop.values()) {
      const file = await this.findTranscript(r);
      if (!file) continue;
      const st = await statSafe(file);
      if (!st || (this.now() - st.mtimeMs > DESKTOP_RECENT_MS && !this.mayBePending(r))) continue;
      wanted.add(file);
    }
    for (const c of this.cliSessions.values()) if (c.followed) wanted.add(c.file);
    for (const file of wanted) {
      if (!this.followers.has(file)) this.followers.set(file, new TranscriptFollower(file));
    }
    for (const file of [...this.followers.keys()]) {
      if (!wanted.has(file)) this.followers.delete(file);
    }
  }

  // Whether the session's last turn could still be Ready (or Error, or Needs you): it ended after
  // `readyFrom` and you haven't marked it done since. That lasts however long it takes.
  mayBePending(r) {
    return this.readyFrom != null && r.lastActivityAt >= this.readyFrom && !(this.dismissed.get(r.hostSessionId) >= r.lastActivityAt);
  }

  async findTranscript(r) {
    const id = r.cliSessionId;
    if (!id) return null;
    const known = this.transcriptFor.get(id);
    if (known && (await statSafe(known))) return known;
    const name = `${id}.jsonl`;
    const candidates = [path.join(this.projectsRoot, `ssh-${id}`, name)];
    if (!r.mirrored) {
      if (r.cwd) candidates.push(path.join(this.projectsRoot, r.cwd.replace(/[^a-zA-Z0-9]/g, '-'), name));
      for (const dir of this.projectDirs) candidates.push(path.join(dir, name));
    }
    for (const file of candidates) {
      if (await statSafe(file)) {
        this.transcriptFor.set(id, file);
        return file;
      }
    }
    return null;
  }

  recompute(force = false) {
    const now = this.now();
    const out = [];
    const all = [];
    const skews = new Map();
    for (const r of this.desktop.values()) {
      const follower = this.followers.get(this.transcriptFor.get(r.cliSessionId));
      let skew = 0;
      if (r.mirrored) {
        if (!skews.has(r.machineKey)) skews.set(r.machineKey, this.clockSkew(r.machineKey));
        skew = skews.get(r.machineKey);
      }
      const state = follower?.state ?? null;
      const dismissedAt = this.dismissed.get(r.hostSessionId);
      const name = this.connectionNames.get(r.machineKey);
      const derived = desktopStatus(name ? { ...r, machine: name } : r, state, {
        now,
        skew,
        dismissedAt,
        logTurn: this.appLog?.turnOf(r.hostSessionId) ?? null,
        readyFrom: this.readyFrom,
      });
      const base = {
        id: r.hostSessionId,
        kind: 'desktop',
        hostSessionId: r.hostSessionId,
        bridgeSessionId: r.bridgeSessionId,
        title: r.title || follower?.state.title || folderName(r.cwd) || 'Claude Code session',
        remote: r.remote && (name || r.remote),
        project: projectName(r.cwd),
        cwd: r.cwd,
      };
      if (derived) out.push({ ...base, ...derived });
      // Folder mode lists every session, with where it runs; one with nothing going on is idle.
      all.push({
        ...base,
        machineKey: r.machineKey,
        machine: name || r.machine,
        lastActivityAt: r.lastActivityAt,
        // Your newest prompt (a task's notice doesn't count), stamped by the CLI's machine.
        lastPromptAt: r.latestUserFrameAt ? r.latestUserFrameAt - skew : 0,
        ...(derived ?? { status: 'idle', detail: '', since: r.lastActivityAt }),
      });
    }
    const chats = [...this.remoteChats];
    for (const [cliId, c] of this.cliSessions) {
      if (this.desktopOwned.has(cliId)) continue;
      const state = c.followed ? this.followers.get(c.file)?.state : this.cliPeeks.get(c.file)?.state;
      if (!state) continue;
      chats.push({
        id: `cli:${cliId}`, sessionId: cliId, state, quiet: !c.followed, machineKey: c.machineKey, machine: c.machine, mtimeMs: c.mtimeMs,
      });
    }
    for (const c of chats) {
      // Not listed until it's known what started it: it may be the desktop app's (a scheduled
      // task's earlier runs aren't in its index).
      const client = clientOf(c.state.entrypoint);
      if (!client) continue;
      const skew = c.skew || 0;
      const there = now + skew;   // the session's own clock (an SSH host's)
      const dismissedAt = this.dismissed.get(c.id);
      // Not written to in a week: nothing going on, and only a quick look's worth known.
      const d = c.quiet ? { status: 'idle', detail: '', since: c.state.lastStampAt || 0 } : deriveStatus(c.state, {
        readyFrom: this.cliReadyFrom == null ? undefined : this.cliReadyFrom + skew,
        lastFocusedAt: there - CLI_REVIEW_MS,
        dismissedAt: dismissedAt == null ? undefined : dismissedAt + skew,
      }, there);
      const derived = { ...d, since: d.since ? d.since - skew : d.since };
      const base = {
        id: c.id,
        kind: 'cli',
        client,
        sessionId: c.sessionId,
        hostSessionId: null,
        title: c.state.title || c.state.aiTitle || folderName(c.state.cwd) || (client === 'vscode' ? 'Claude Code (VS Code)' : 'Claude Code (terminal)'),
        remote: c.remote ?? null,
        project: projectName(c.state.cwd),
        cwd: c.state.cwd,
      };
      out.push({ ...base, ...derived });
      all.push({
        ...base,
        machineKey: c.machineKey ?? null,
        machine: c.machine ?? null,
        lastActivityAt: (c.state.lastStampAt ? c.state.lastStampAt - skew : 0) || c.mtimeMs || 0,
        lastPromptAt: c.state.lastUserAt ? c.state.lastUserAt - skew : 0,
        ...derived,
      });
    }
    out.sort(compareSessions);
    this.sessions = out;
    const active = out.filter((s) => s.status !== 'idle');
    const key = JSON.stringify(active);
    if (force || key !== this.lastEmitted) {
      this.lastEmitted = key;
      this.emit('change', active);
    }
    all.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    this.all = all;
    const listKey = JSON.stringify(all);
    if (force || listKey !== this.lastListed) {
      this.lastListed = listKey;
      this.emit('list', all);
    }
  }

  // How far ahead of ours the clock is on the machine behind `machineKey`, measured from the
  // copies of its transcripts that we follow, and kept until it moves by more than a second.
  clockSkew(machineKey) {
    const samples = [];
    for (const r of this.desktop.values()) {
      if (r.machineKey !== machineKey) continue;
      const f = this.followers.get(this.transcriptFor.get(r.cliSessionId));
      if (f && f.size >= 0) samples.push({ mtimeMs: f.mtimeMs, lastStampAt: f.state.lastStampAt });
    }
    const skew = steadySkew(this.clockSkews.get(machineKey), estimateSkew(samples));
    this.clockSkews.set(machineKey, skew);
    return skew;
  }
}

// The status of a desktop session. `state` is the turn state of its transcript (null if we
// have none). Transcripts of SSH and WSL sessions are stamped by the remote machine's clock,
// which is `skew` ms ahead of ours, so the times are compared on that clock. `logTurn` is
// what the desktop app's log last said about the session.
function desktopStatus(r, state, opts = {}) {
  const derived = transcriptStatus(r, state, opts);
  const asking = opts.logTurn?.asking;
  if (!asking || derived?.status === 'waiting') return derived;   // the transcript has the question itself
  // Claude asked something the SSH copy doesn't have yet, wants permission for a tool (which the
  // transcript shows as just running it), or the app asked something of its own, which can
  // outlast the turn.
  if (opts.dismissedAt >= asking.at) return derived;
  return { status: 'waiting', detail: describeAsk(asking.tool), since: asking.at };
}

function transcriptStatus(r, state, {
  now = Date.now(), skew = 0, dismissedAt, logTurn = null, readyFrom = null,
} = {}) {
  const hidden = r.mirrored ? turnNotInCopy(r, state, skew, logTurn) : null;
  if (hidden) {
    if (now - Math.max(hidden.since, r.lastActivityAt) > STALE_RUNNING_MS) {
      return state ? { status: 'idle', detail: '', since: hidden.since } : null;
    }
    const where = projectName(r.cwd) || r.machine;   // the project, else the server
    return { status: 'running', detail: where ? `Working on ${where}` : 'Working', since: hidden.since };
  }
  if (!state) return null;
  let derived = deriveStatus(state, {
    lastFocusedAt: r.lastFocusedAt && r.lastFocusedAt + skew,
    dismissedAt: dismissedAt && dismissedAt + skew,
    summary: r.summary,
    readyFrom: readyFrom == null ? undefined : readyFrom + skew,
  }, now + skew);
  // The summary that says whether Claude ended the turn waiting on you comes a few seconds after
  // the turn. Like the app, wait for it a moment in sessions that get one, rather than show
  // "Ready" and then "Needs you".
  const summaryDue = r.summarized && !state.turnAssistantUuids.includes(r.summary?.summarizes_uuid);
  if (derived.status === 'review' && summaryDue && now + skew - state.turnEndedAt < SUMMARY_WAIT_MS) {
    derived = { status: 'running', detail: 'Wrapping up', since: state.turnStartedAt };
  }
  // If we started reading mid-turn, the desktop index knows when you sent the prompt.
  if (derived.status === 'running' && r.latestUserFrameAt > state.turnEndedAt) {
    derived.since = Math.min(derived.since || Infinity, r.latestUserFrameAt);
  }
  if (derived.since) derived.since -= skew;
  return derived;
}

// The desktop app copies an SSH session's transcript over when a turn ends (and when you open
// the session), so during a turn the copy lags. Returns { since } for a running turn that the
// copy doesn't show, or null.
function turnNotInCopy(r, state, skew, logTurn) {
  // The app's log records each prompt as it's sent and each turn as it ends.
  if (logTurn?.running) {
    const copyHasIt = state?.turnActive && state.turnStartedAt - skew >= logTurn.at - LOG_SLACK_MS;
    return copyHasIt ? null : { since: logTurn.at };
  }
  // Turns the log doesn't mention (e.g. started from another device) show up in the index,
  // which saves the newest prompt's time (stamped by the remote CLI) and reply's uuid now and then.
  if (!indexIsAhead(r, state)) return null;
  const since = r.latestUserFrameAt ? r.latestUserFrameAt - skew : r.lastActivityAt;
  if (logTurn && logTurn.at + LOG_SLACK_MS >= since) return null;   // the log saw that turn end
  return { since };
}

function indexIsAhead(r, state) {
  if (r.lastAssistantUuid && r.lastAssistantUuid === r.summaryFor) return false;   // summarized: the turn is over
  if (!state) return r.latestUserFrameAt > 0;
  if (r.latestUserFrameAt > state.lastUserAt) return true;
  return Boolean(r.lastAssistantUuid) && !state.seenAssistants.has(r.lastAssistantUuid);
}

// Each copy is written just after the remote CLI's newest entry, so (newest timestamp - local
// mtime) can only underestimate the skew; after a turn ends it's close. But the app also copies
// a session over again when you open it, which underestimates by however long it sat, so the
// bound comes from every copy of the last day rather than the latest few. (Older copies may
// predate a change of the server's clock.)
function estimateSkew(samples) {
  const valid = samples.filter((s) => s.lastStampAt > 0 && s.mtimeMs > 0);
  if (!valid.length) return 0;
  const newest = Math.max(...valid.map((s) => s.mtimeMs));
  const recent = valid.filter((s) => newest - s.mtimeMs <= CLOCK_WINDOW_MS);
  const skew = Math.max(...recent.map((s) => s.lastStampAt - s.mtimeMs));
  return Math.abs(skew) < MAX_CLOCK_SKEW_MS ? Math.round(skew) : 0;
}

// When you delete a session, the desktop app leaves a marker next to its transcript.
// A projects folder's folders, newest first. The desktop app's copies of SSH sessions (ssh-<id>/,
// one folder per session, often most of them) are left out: findTranscript goes straight to the
// one it needs, and VS Code and terminal sessions are never there.
async function projectDirsOf(root) {
  const dirs = [];
  for (const e of await readdirSafe(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('ssh-')) continue;
    const full = path.join(root, e.name);
    const st = await statSafe(full);
    if (st) dirs.push({ full, mtimeMs: st.mtimeMs });
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dirs.slice(0, MAX_PROJECT_DIRS).map((d) => d.full);
}

// A turn state from a quick look at a transcript: its first and last CLI_PEEK_BYTES. Enough for
// what an older session is listed with: what started it, its folder, title and last time.
async function quickState(file, size) {
  const state = createTurnState();
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const read = async (start, length) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead).toString('utf8');
    };
    const headText = await read(0, Math.min(size, CLI_PEEK_BYTES));
    const tailText = size > CLI_PEEK_BYTES ? await read(Math.max(CLI_PEEK_BYTES, size - CLI_PEEK_BYTES), Math.min(CLI_PEEK_BYTES, size - CLI_PEEK_BYTES)) : '';
    const head = headText.split('\n');
    if (size > CLI_PEEK_BYTES) head.pop();   // cut short
    const tail = tailText.split('\n').slice(1);   // the first starts in the middle of a line
    for (const line of [...head, ...tail]) {
      if (!line.trim()) continue;
      try {
        applyEntry(state, JSON.parse(line));
      } catch {
        // a line cut where the look ends
      }
    }
    // Long lines (a big tool result) can leave no whole entry in either look; what started it is
    // still in the text, at the end of each entry: so in the file's last bytes, most of all.
    if (!state.entrypoint) state.entrypoint = ENTRYPOINT_RE.exec(tailText)?.[1] ?? ENTRYPOINT_RE.exec(headText)?.[1] ?? null;
  } catch {
    // gone, or not readable: listed with what's known
  } finally {
    await fh?.close();
  }
  return state;
}

// Which app a session outside the desktop app runs in, by the transcript's entrypoint: 'vscode'
// (Claude Code in VS Code) or 'terminal' (`claude`). null for the desktop app's own (claude-desktop,
// and its variants such as claude-desktop-3p), for programs (the Agent SDK's sdk-…), and while
// it's unknown, none of which are listed.
function clientOf(entrypoint) {
  if (!entrypoint || /^(claude-desktop|sdk)/.test(entrypoint)) return null;
  return entrypoint === 'claude-vscode' ? 'vscode' : 'terminal';
}

async function releasedBefore(dir, cliId, mtimeMs) {
  try {
    const marker = JSON.parse(await fsp.readFile(path.join(dir, `${cliId}${RELEASED_SUFFIX}`), 'utf8'));
    const at = Date.parse(marker?.releasedAt);
    return !Number.isFinite(at) || mtimeMs <= at + 5000;   // unless it was resumed in a terminal since
  } catch {
    return false;
  }
}

function parseDesktopSession(j) {
  if (!j || typeof j !== 'object' || !HOST_ID_RE.test(j.sessionId || '')) return null;
  const summary = j.postTurnSummary && typeof j.postTurnSummary === 'object' ? {
    status_category: j.postTurnSummary.status_category,
    status_detail: j.postTurnSummary.status_detail,
    needs_action: j.postTurnSummary.needs_action,
    summarizes_uuid: j.postTurnSummary.summarizes_uuid || j.postTurnSummaryFor,
  } : null;
  const ssh = j.sshConfig && typeof j.sshConfig.sshHost === 'string' ? j.sshConfig : null;
  const wsl = j.wslConfig && typeof j.wslConfig.distro === 'string' ? j.wslConfig : null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    hostSessionId: j.sessionId,
    cliSessionId: str(j.cliSessionId),
    priorCliSessionIds: Array.isArray(j.priorCliSessionIds) ? j.priorCliSessionIds.filter((id) => typeof id === 'string') : [],
    title: str(j.title),
    isArchived: j.isArchived === true,
    lastFocusedAt: Number(j.lastFocusedAt) || 0,
    lastActivityAt: Number(j.lastActivityAt) || 0,
    latestUserFrameAt: Number(j.latestUserFrameAt) || 0,
    lastAssistantUuid: str(j.lastAssistantUuid),
    summaryFor: str(j.postTurnSummaryFor) || str(j.postTurnSummary?.summarizes_uuid),
    // Whether each turn gets a summary. The app drops the last one when a turn starts.
    summarized: j.classifierSummaryEnabled === true || Boolean(summary),
    cwd: str(j.cwd),
    // The Remote Control session it was last connected to: each new connection is added at the end.
    bridgeSessionId: Array.isArray(j.bridgeSessionIds) ? j.bridgeSessionIds.findLast((id) => BRIDGE_ID_RE.test(id)) ?? null : null,
    remote: ssh ? ssh.sshHost : null,
    // SSH and WSL sessions run elsewhere; their transcript here is a copy.
    mirrored: Boolean(ssh || wsl),
    machineKey: ssh ? sshKey(ssh.sshHost, ssh.sshPort) : wsl ? `wsl:${wsl.distro}` : null,
    machine: ssh ? ssh.sshHost.replace(/^.*@/, '') : wsl ? wsl.distro : null,
    summary,
  };
}

function sshKey(host, port) {
  return `ssh:${host}:${port ?? 22}`;
}

// The desktop app's saved SSH connections: { configs: [{ name, sshHost, sshPort }, …] }
function parseSshConnections(j) {
  const names = new Map();
  for (const c of Array.isArray(j?.configs) ? j.configs : []) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (name && typeof c.sshHost === 'string') names.set(sshKey(c.sshHost, c.sshPort), name);
  }
  return names;
}

// The Remote Control sessions that Claude Code processes running on this PC are connected to, from
// the file each keeps while it runs (<claudeHome>/sessions/<pid>.json): its session id (the CLI's,
// and the desktop app's local_ one for a desktop session) -> the Remote Control session's id. A file
// whose process is gone is left out, so these are live connections.
function liveBridges(claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), alive = processAlive) {
  const out = new Map();
  const dir = path.join(claudeHome, 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return out;
  }
  for (const name of names) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!BRIDGE_ID_RE.test(j?.bridgeSessionId || '') || !alive(Number(j.pid))) continue;
    if (typeof j.sessionId === 'string') out.set(j.sessionId, j.bridgeSessionId);
    if (HOST_ID_RE.test(j.hostSessionId || '')) out.set(j.hostSessionId, j.bridgeSessionId);
  }
  return out;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';   // there, but not ours to signal
  }
}

function folderName(p) {
  if (!p) return '';
  return path.basename(p.replace(/\\/g, '/').replace(/\/+$/, ''));
}

// The project a session works in: its folder's name, unless that folder is one the app made
// for a session started without a project.
function projectName(cwd) {
  if (!cwd) return null;
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  if (parts.some((p) => p.toLowerCase() === 'scratch-workspaces')) return null;   // Claude's "No folder" sessions
  const [grand, parent] = parts.slice(-3, -1);
  if (/^codex$/i.test(grand || '') && /^\d{4}-\d{2}-\d{2}$/.test(parent || '')) return null;   // Codex: …/Codex/<date>/<topic>
  return parts.at(-1) || null;
}

module.exports = {
  SessionTracker,
  AppLogFollower,
  FileFollower,
  TranscriptFollower,
  clientOf,
  defaultPaths,
  folderName,
  liveBridges,
  readdirSafe,
  statSafe,
  desktopStatus,
  estimateSkew,
  parseDesktopSession,
  parseLogLine,
  parseSshConnections,
  projectName,
  HOST_ID_RE,
};

// `node src/sessions.js` prints what the pet currently sees (handy for debugging).
if (require.main === module) {
  const appData = process.env.APPDATA
    || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
  const tracker = new SessionTracker(defaultPaths(appData));
  tracker.tick().then(() => {
    const rows = tracker.sessions.map((s) => ({
      status: s.status,
      kind: s.kind,
      id: s.id.slice(0, 16),
      title: (s.title || '').slice(0, 40),
      detail: (s.detail || '').slice(0, 50),
      remote: s.remote || '',
      since: s.since ? new Date(s.since).toLocaleTimeString() : '',
    }));
    console.table(rows);
  });
}
