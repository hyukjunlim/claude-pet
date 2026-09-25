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
//   - Other recently active transcripts (terminal `claude` sessions) are reported as kind "cli".
//   - Your plan's usage, which the desktop app samples into <appData>/Claude/plan-usage-history.json
//     (reported as 'usage' events, for the weekly-limit meter).

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { STALE_RUNNING_MS, applyEntry, compareSessions, createTurnState, deriveStatus } = require('./transcript');
const { parseClaudeUsage } = require('./usage');

const HOST_ID_RE = /^local_[A-Za-z0-9-]{1,64}$/;
const TRANSCRIPT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const INITIAL_TAIL_BYTES = 768 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const META_SCAN_MS = 3000;
const PROJECT_SCAN_MS = 15000;
const DESKTOP_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const CLI_RECENT_MS = 30 * 60 * 1000;
const CLI_REVIEW_MS = 10 * 60 * 1000;
const MAX_PROJECT_DIRS = 400;
const CLOCK_SAMPLES = 3;
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const RELEASED_SUFFIX = '.desktop-released.json';
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_SLACK_MS = 3000;   // log times are whole seconds, and the clock skew is an estimate
const KICK_DELAY_MS = 100;          // lets a burst of file changes settle into one update
const PROJECT_KICK_MIN_MS = 2000;   // scanning every project folder is the costly part

function defaultPaths(appDataDir) {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    sessionsRoot: path.join(appDataDir, 'Claude', 'claude-code-sessions'),
    projectsRoot: path.join(claudeHome, 'projects'),
    appLog: appLogPath(appDataDir),
    sshConnections: path.join(appDataDir, 'Claude', 'ssh_configs.json'),
    planUsage: path.join(appDataDir, 'Claude', 'plan-usage-history.json'),
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

// Follows the desktop app's log, which records every prompt it sends to a session and every
// turn that ends, as they happen. For SSH sessions that's the only live signal.
class AppLogFollower extends FileFollower {
  constructor(file) {
    super(file, LOG_TAIL_BYTES);
    this.turns = new Map();   // hostSessionId -> { running, at }, from the newest line about it
  }

  handleLine(line) {
    const e = parseLogLine(line);
    if (e) this.turns.set(e.sessionId, { running: e.kind === 'start', at: e.at });
  }
}

const LOG_LINE_RE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:[.,](\d{1,3}))? \[\w+\] (.*)$/;
const LOG_EVENTS = [
  // A prompt handed to the session's CLI. The app logs the "Mapping" line for every prompt it
  // passes on (including ones it doesn't log as "Sending message", such as queued prompts).
  [/^Sending message to session (local_[\w-]+)/, 'start'],
  [/^Mapping internal session (local_[\w-]+) to CLI session/, 'start'],
  // The first reply after the app (re)started a session's CLI for a prompt. ("Starting local
  // session" itself also appears for pre-warmed sessions and rewinds, which don't run a turn.)
  [/^\[CCD start-timing\] (local_[\w-]+)\b(?:.*?\btotal_to_assistant=(\d+)ms)?/, 'start'],
  [/^\[CCD CycleHealth\] (?:un)?healthy cycle for (local_[\w-]+)/, 'end'],
  [/^\[Stop hook\] Query completed for session (local_[\w-]+)/, 'end'],
  [/^Session (local_[\w-]+) query iterator completed/, 'end'],
];

// "2026-09-24 23:47:34 [info] Sending message to session local_…" (local time)
function parseLogLine(line) {
  const m = LOG_LINE_RE.exec(line.trimEnd());
  if (!m) return null;
  for (const [re, kind] of LOG_EVENTS) {
    const e = re.exec(m[8]);
    if (e) {
      const at = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)).getTime();
      return { kind, sessionId: e[1], at: at - (Number(e[2]) || 0) };
    }
  }
  return null;
}

class SessionTracker extends EventEmitter {
  constructor({
    sessionsRoot, projectsRoot, appLog = null, sshConnections = null, planUsage = null, pollMs = 1000, now = Date.now, dismissed = {},
  } = {}) {
    super();
    this.sessionsRoot = sessionsRoot;
    this.projectsRoot = projectsRoot;
    this.appLog = appLog ? new AppLogFollower(appLog) : null;
    this.sshConnectionsFile = sshConnections;
    this.connectionNames = new Map();  // machineKey -> the name you gave the SSH connection
    this.connectionsStamp = '';
    this.planUsageFile = planUsage;
    this.usage = null;                 // the newest sample of your plan's usage
    this.usageStamp = '';
    this.pollMs = pollMs;
    this.now = now;
    this.desktop = new Map();          // hostSessionId -> record from the desktop index
    this.desktopOwned = new Set();     // every cliSessionId the desktop knows, archived included
    this.metaCache = new Map();        // index file -> { mtimeMs, size, record }
    this.followers = new Map();        // transcript path -> TranscriptFollower
    this.transcriptFor = new Map();    // cliSessionId -> transcript path
    this.cliSessions = new Map();      // cliSessionId -> transcript path (not owned by the desktop)
    this.projectDirs = [];
    this.dismissed = new Map(Object.entries(dismissed));
    this.lastMetaScan = 0;
    this.lastProjectScan = 0;
    this.lastEmitted = '';
    this.sessions = [];
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

  dismiss(id) {
    this.dismissed.set(id, this.now());
    this.recompute(true);
  }

  dismissedSnapshot() {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
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
        await this.loadUsage();
      }
      const projectsDue = now - this.lastProjectScan >= (this.projectsDirty ? PROJECT_KICK_MIN_MS : PROJECT_SCAN_MS);
      if (projectsDue) {
        this.projectsDirty = false;
        this.lastProjectScan = now;
        await this.scanProjects();
      }
      if (metaDue || projectsDue) await this.resolveTranscripts();
      for (const [file, follower] of this.followers) {
        if (!only || only.has(file) || follower.offset < 0) await follower.poll().catch(() => {});
      }
      if (this.appLog && (!only || only.has(this.appLog.file))) await this.appLog.poll().catch(() => {});
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

  // The desktop app adds a sample of your plan's usage every 15 minutes while it runs.
  async loadUsage() {
    if (!this.planUsageFile) return;
    const st = await statSafe(this.planUsageFile);
    const stamp = st ? `${st.mtimeMs}:${st.size}` : '';
    if (stamp === this.usageStamp) return;
    let usage = null;
    try {
      if (st) usage = parseClaudeUsage(JSON.parse(await fsp.readFile(this.planUsageFile, 'utf8')));
    } catch {
      return;   // mid-write; try again on the next scan
    }
    this.usageStamp = stamp;
    if (JSON.stringify(usage) === JSON.stringify(this.usage)) return;
    this.usage = usage;
    this.emit('usage', { claude: usage });
  }

  async scanProjects() {
    const entries = await readdirSafe(this.projectsRoot, { withFileTypes: true });
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(this.projectsRoot, e.name);
      const st = await statSafe(full);
      if (st) dirs.push({ full, mtimeMs: st.mtimeMs });
    }
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.projectDirs = dirs.slice(0, MAX_PROJECT_DIRS).map((d) => d.full);

    // Terminal sessions: recently written transcripts that the desktop doesn't own.
    const cutoff = this.now() - CLI_RECENT_MS;
    const live = new Map();
    for (const dir of this.projectDirs) {
      if (path.basename(dir).startsWith('ssh-')) continue;   // the desktop app's copies of SSH sessions
      for (const name of await readdirSafe(dir)) {
        const m = TRANSCRIPT_RE.exec(name);
        if (!m || this.desktopOwned.has(m[1])) continue;
        const file = path.join(dir, name);
        const st = await statSafe(file);
        if (!st || st.mtimeMs < cutoff || (await releasedBefore(dir, m[1], st.mtimeMs))) continue;
        live.set(m[1], file);
      }
    }
    this.cliSessions = live;
  }

  async resolveTranscripts() {
    const wanted = new Set();
    for (const r of this.desktop.values()) {
      const file = await this.findTranscript(r);
      if (!file) continue;
      const st = await statSafe(file);
      if (!st || this.now() - st.mtimeMs > DESKTOP_RECENT_MS) continue;
      wanted.add(file);
    }
    for (const file of this.cliSessions.values()) wanted.add(file);
    for (const file of wanted) {
      if (!this.followers.has(file)) this.followers.set(file, new TranscriptFollower(file));
    }
    for (const file of [...this.followers.keys()]) {
      if (!wanted.has(file)) this.followers.delete(file);
    }
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
    const skews = new Map();
    for (const r of this.desktop.values()) {
      const follower = this.followers.get(this.transcriptFor.get(r.cliSessionId));
      let skew = 0;
      if (r.mirrored) {
        if (!skews.has(r.machineKey)) skews.set(r.machineKey, this.clockSkew(r.machineKey));
        skew = skews.get(r.machineKey);
      }
      const name = this.connectionNames.get(r.machineKey);
      const derived = desktopStatus(name ? { ...r, machine: name } : r, follower?.state ?? null, {
        now,
        skew,
        dismissedAt: this.dismissed.get(r.hostSessionId),
        logTurn: this.appLog?.turns.get(r.hostSessionId) ?? null,
      });
      if (!derived) continue;
      out.push({
        id: r.hostSessionId,
        kind: 'desktop',
        hostSessionId: r.hostSessionId,
        title: r.title || follower?.state.title || folderName(r.cwd) || 'Claude Code session',
        remote: r.remote && (name || r.remote),
        project: projectName(r.cwd),
        cwd: r.cwd,
        ...derived,
      });
    }
    for (const [cliId, file] of this.cliSessions) {
      const follower = this.followers.get(file);
      if (!follower || this.desktopOwned.has(cliId)) continue;
      const id = `cli:${cliId}`;
      const derived = deriveStatus(follower.state, {
        lastFocusedAt: now - CLI_REVIEW_MS,
        dismissedAt: this.dismissed.get(id),
      }, now);
      out.push({
        id,
        kind: 'cli',
        hostSessionId: null,
        title: follower.state.title || folderName(follower.state.cwd) || 'Claude Code (terminal)',
        remote: null,
        project: projectName(follower.state.cwd),
        cwd: follower.state.cwd,
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
  }

  // How far ahead of ours the clock is on the machine behind `machineKey`, measured from the
  // copies of its transcripts that we follow.
  clockSkew(machineKey) {
    const samples = [];
    for (const r of this.desktop.values()) {
      if (r.machineKey !== machineKey) continue;
      const f = this.followers.get(this.transcriptFor.get(r.cliSessionId));
      if (f && f.size >= 0) samples.push({ mtimeMs: f.mtimeMs, lastStampAt: f.state.lastStampAt });
    }
    return estimateSkew(samples);
  }
}

// The status of a desktop session. `state` is the turn state of its transcript (null if we
// have none). Transcripts of SSH and WSL sessions are stamped by the remote machine's clock,
// which is `skew` ms ahead of ours, so the times are compared on that clock. `logTurn` is
// what the desktop app's log last said about the session.
function desktopStatus(r, state, { now = Date.now(), skew = 0, dismissedAt, logTurn = null } = {}) {
  const hidden = r.mirrored ? turnNotInCopy(r, state, skew, logTurn) : null;
  if (hidden) {
    if (now - Math.max(hidden.since, r.lastActivityAt) > STALE_RUNNING_MS) {
      return state ? { status: 'idle', detail: '', since: hidden.since } : null;
    }
    const where = projectName(r.cwd) || r.machine;   // the project, else the server
    return { status: 'running', detail: where ? `Working on ${where}` : 'Working', since: hidden.since };
  }
  if (!state) return null;
  const derived = deriveStatus(state, {
    lastFocusedAt: r.lastFocusedAt && r.lastFocusedAt + skew,
    dismissedAt: dismissedAt && dismissedAt + skew,
    summary: r.summary,
  }, now + skew);
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
// mtime) can only underestimate the skew. After a turn ends it's close, so the recent copies
// give a tight bound.
function estimateSkew(samples) {
  const recent = samples
    .filter((s) => s.lastStampAt > 0 && s.mtimeMs > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, CLOCK_SAMPLES);
  if (!recent.length) return 0;
  const skew = Math.max(...recent.map((s) => s.lastStampAt - s.mtimeMs));
  return Math.abs(skew) < MAX_CLOCK_SKEW_MS ? Math.round(skew) : 0;
}

// When you delete a session, the desktop app leaves a marker next to its transcript.
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
    cwd: str(j.cwd),
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
  FileFollower,
  TranscriptFollower,
  defaultPaths,
  folderName,
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
