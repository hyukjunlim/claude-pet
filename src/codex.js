'use strict';

// Watches Codex (the Codex desktop app and the Codex CLI) and reports its threads the way
// SessionTracker reports Claude sessions.
//
// Sources, all read-only:
//   - ~/.codex/.codex-global-state.json: the desktop app's unread threads, per host. The app
//     adds a thread when a turn finishes while you aren't looking at it, and removes it once you
//     open the thread. It also lists the SSH hosts the app works on.
//   - ~/.codex/sqlite/codex-dev.db (local_thread_catalog): each thread's title and host.
//   - ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl: the live history of threads that run on
//     this PC (the app's local host, and the Codex CLI).
//   - The same rollouts on each SSH host, streamed by a small watcher (see codex-remote.js).
//     Each reply in a rollout also records the account's rate limits, for the weekly-limit meter.

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { FileFollower, folderName, projectName, readdirSafe, statSafe } = require('./sessions');
const { UNREAD_WINDOW_MS, compareSessions } = require('./transcript');
const { applyRolloutEntry, createRolloutState, rateLimitsOf, rolloutStatus } = require('./rollout');
const { CodexRemote } = require('./codex-remote');

const ROLLOUT_RE = /^rollout-.+[-_][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const HOST_KEY_RE = /^(.+):[0-9a-f]{64}$/;       // the unread list keys hosts as "<hostId>:<hash>"
const ROLLOUT_TAIL_BYTES = 512 * 1024;
const ROLLOUT_RECENT_MS = 60 * 60 * 1000;        // rollouts written this recently are followed
const SCAN_MS = 60 * 1000;                       // look for rollouts the watcher didn't report
const PAST_LIMITS_FILES = 3;                     // older rollouts to look through for rate limits
const APP_STATE_MIN_MS = 1000;                   // the app's state file is ~3 MB
const CATALOG_MIN_MS = 5000;
const KICK_DELAY_MS = 100;

function codexPaths() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return {
    home,
    appState: path.join(home, '.codex-global-state.json'),
    catalog: path.join(home, 'sqlite', 'codex-dev.db'),
    sessionsRoot: path.join(home, 'sessions'),
    sessionIndex: path.join(home, 'session_index.jsonl'),
  };
}

class RolloutFollower extends FileFollower {
  constructor(file) {
    super(file, ROLLOUT_TAIL_BYTES);
    this.state = createRolloutState();
  }

  reset() {
    this.state = createRolloutState();
  }

  handleLine(line) {
    try {
      applyRolloutEntry(this.state, JSON.parse(line));
    } catch {
      // A line we can't parse (or a newer format) shouldn't break the pet.
    }
  }

  async poll() {
    const known = this.state.threadId;
    const changed = await super.poll();
    // The thread's details are in its first line, which a tail read of a long file skips.
    if (changed && !known && !this.state.threadId) await this.readMeta();
    return changed;
  }

  // The first line (session_meta) carries the thread's id; it can be long (base instructions).
  async readMeta() {
    try {
      const fh = await fsp.open(this.file, 'r');
      try {
        const chunks = [];
        const buf = Buffer.alloc(64 * 1024);
        for (let pos = 0; pos < 4 * 1024 * 1024;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
          chunks.push(Buffer.from(buf.subarray(0, nl >= 0 ? nl : bytesRead)));
          if (nl >= 0) break;
          pos += bytesRead;
        }
        const entry = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (entry?.type === 'session_meta') applyRolloutEntry(this.state, entry);   // only sets the thread's details
      } finally {
        await fh.close();
      }
    } catch {
      // A partial write; try again when the file changes.
    }
  }
}

// Reads the newest rate limits from the tail of a rollout we don't follow.
class LimitsReader extends FileFollower {
  constructor(file) {
    super(file, ROLLOUT_TAIL_BYTES);
    this.limits = null;
  }

  handleLine(line) {
    if (!line.includes('"rate_limits"')) return;
    try {
      this.limits = rateLimitsOf(JSON.parse(line)) || this.limits;
    } catch {
      // skip it
    }
  }
}

// ------------------------------------------------------------------ the desktop app's state

// electron-thread-read-state-v1: { unreadByIdentity: { <account>: { "<hostId>:<hash>": [threadId…] } } }
function parseUnread(j) {
  const unread = new Map();   // threadId -> hostId
  const byIdentity = j?.['electron-thread-read-state-v1']?.unreadByIdentity;
  if (!byIdentity || typeof byIdentity !== 'object') return unread;
  for (const hosts of Object.values(byIdentity)) {
    if (!hosts || typeof hosts !== 'object') continue;
    for (const [hostKey, ids] of Object.entries(hosts)) {
      if (!Array.isArray(ids)) continue;
      const hostId = HOST_KEY_RE.exec(hostKey)?.[1] ?? hostKey;
      if (hostId.startsWith('chatgpt:')) continue;    // ChatGPT chats, not Codex threads
      for (const id of ids) if (typeof id === 'string') unread.set(id, hostId);
    }
  }
  return unread;
}

// codex-managed-remote-connections: [{ hostId, displayName, alias, hostname, sshPort, identity }]
function parseConnections(j) {
  const hosts = j?.['codex-managed-remote-connections'];
  const out = [];
  for (const h of Array.isArray(hosts) ? hosts : []) {
    const target = h?.alias || h?.hostname;
    if (typeof h?.hostId !== 'string' || typeof target !== 'string' || !target) continue;
    out.push({
      hostId: h.hostId,
      name: h.displayName || h.alias || target,
      target,
      port: Number(h.sshPort) || null,
      identity: typeof h.identity === 'string' && h.identity ? h.identity : null,
    });
  }
  return out;
}

function hostName(hostId, names) {
  if (!hostId || hostId === 'local') return null;
  return names.get(hostId) || hostId.replace(/^remote-ssh-discovered:/, '');
}

function threadUrl(threadId, hostId) {
  const url = `codex://threads/${threadId}`;
  return hostId && hostId !== 'local' ? `${url}?hostId=${encodeURIComponent(hostId)}` : url;
}

let DatabaseSync;

function readCatalog(file) {
  let db;
  try {
    DatabaseSync ??= require('node:sqlite').DatabaseSync;
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(
      "select host_id, thread_id, display_title, source_updated_at, cwd from local_thread_catalog where host_id not like 'chatgpt:%'",
    ).all();
    return new Map(rows.map((r) => [r.thread_id, {
      hostId: r.host_id,
      title: r.display_title || null,
      updatedAt: Math.round((Number(r.source_updated_at) || 0) * 1000),
      cwd: r.cwd || null,
    }]));
  } catch {
    return null;   // not there, locked mid-migration, or no SQLite in this runtime
  } finally {
    db?.close();
  }
}

// ------------------------------------------------------------------ tracker

class CodexTracker extends EventEmitter {
  constructor({
    home, appState, catalog, sessionsRoot, sessionIndex,
    watchHosts = true, remoteFactory = (o) => new CodexRemote(o), pollMs = 1000, now = Date.now, dismissed = {},
  } = {}) {
    super();
    this.home = home;
    this.appStateFile = appState;
    this.catalogFile = catalog;
    this.sessionsRoot = sessionsRoot;
    this.sessionIndexFile = sessionIndex;
    this.watchHosts = watchHosts;
    this.remoteFactory = remoteFactory;
    this.pollMs = pollMs;
    this.now = now;
    this.dismissed = new Map(Object.entries(dismissed).filter(([id]) => id.startsWith('codex:')));
    this.unread = new Map();          // threadId -> hostId, from the app's unread list
    this.unreadSince = new Map();     // threadId -> when it became unread while we watched
    this.connections = [];            // the SSH hosts the app works on
    this.hostNames = new Map();       // hostId -> the name you gave the host
    this.remotes = new Map();         // hostId -> CodexRemote
    this.catalog = new Map();         // threadId -> { hostId, title, updatedAt, cwd }
    this.threadNames = new Map();     // threadId -> a name from session_index.jsonl
    this.followers = new Map();       // rollout path -> RolloutFollower
    this.limits = null;               // the newest rate limits Codex recorded, on our clock
    this.pastLimits = null;           // ... found in a rollout too old to follow
    this.limitsChecked = new Set();   // older rollouts read for them, as "path|mtime|size"
    this.stamps = {};
    this.lastAppStateRead = 0;
    this.lastCatalogRead = 0;
    this.lastScan = 0;
    this.scanDirty = false;
    this.lastEmitted = '';
    this.sessions = [];
    this.busy = false;
    this.rerun = false;
    this.running = false;
    this.timer = null;
    this.kickTimer = null;
    this.retryTimer = null;
    this.changed = new Set();
    this.watchers = [];
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
    clearTimeout(this.retryTimer);
    this.timer = null;
    this.kickTimer = null;
    this.retryTimer = null;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.syncRemotes();
  }

  setWatchHosts(on) {
    this.watchHosts = on;
    this.syncRemotes();
  }

  dismiss(id) {
    this.dismissed.set(id, this.now());
    this.recompute(true);
  }

  dismissedSnapshot() {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    return Object.fromEntries([...this.dismissed].filter(([, t]) => t > cutoff));
  }

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
    const kickFor = (files) => (name) => {
      if (!name || files.includes(name)) this.kick();
    };
    watch(this.home, {}, kickFor([path.basename(this.appStateFile), path.basename(this.sessionIndexFile)]));
    watch(path.dirname(this.catalogFile), {}, kickFor([path.basename(this.catalogFile), `${path.basename(this.catalogFile)}-wal`]));
    watch(this.sessionsRoot, { recursive: true }, (name) => this.onRolloutChange(name));
  }

  onRolloutChange(name) {
    if (!name || !ROLLOUT_RE.test(path.basename(name))) {
      if (!name) this.kick({ scan: true });
      return;
    }
    const file = path.join(this.sessionsRoot, name);
    if (!this.followers.has(file)) this.followers.set(file, new RolloutFollower(file));
    this.kick({ file });
  }

  kick({ file = null, scan = false } = {}) {
    if (file) this.changed.add(file);
    if (scan) this.scanDirty = true;
    if (!this.running || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      const only = this.changed;
      this.changed = new Set();
      this.tick(only).catch((err) => this.emit('error', err));
    }, KICK_DELAY_MS);
  }

  // A file changed again right after we read it: read it once the minimum gap has passed.
  retryIn(ms) {
    if (!this.running || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, ms);
  }

  // `only` is the set of rollouts reported changed; null (the timer) checks them all.
  async tick(only = null) {
    if (this.busy) {
      for (const file of only ?? []) this.changed.add(file);
      this.rerun = true;
      return;
    }
    this.busy = true;
    try {
      const now = this.now();
      await this.loadAppState(now);
      await this.loadThreadNames();
      await this.loadCatalog(now);
      if (now - this.lastScan >= (this.scanDirty ? 2000 : SCAN_MS)) {
        this.scanDirty = false;
        this.lastScan = now;
        await this.scanRollouts(now);
      }
      for (const [file, f] of this.followers) {
        if (!only || only.has(file) || f.offset < 0) await f.poll().catch(() => {});
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

  async stampOf(...files) {
    const parts = [];
    for (const f of files) {
      const st = await statSafe(f);
      parts.push(st ? `${st.mtimeMs}:${st.size}` : '-');
    }
    return parts.join('|');
  }

  async loadAppState(now) {
    const stamp = await this.stampOf(this.appStateFile);
    if (stamp === this.stamps.appState) return;
    const wait = APP_STATE_MIN_MS - (now - this.lastAppStateRead);
    if (wait > 0) {
      this.retryIn(wait);
      return;
    }
    let j = null;
    if (stamp !== '-') {
      try {
        j = JSON.parse(await fsp.readFile(this.appStateFile, 'utf8'));
      } catch {
        return;   // mid-write; read it again next time
      }
    }
    const firstRead = !this.lastAppStateRead;
    this.stamps.appState = stamp;
    this.lastAppStateRead = now;
    const unread = parseUnread(j);
    // We only know when a thread became unread if we saw it happen.
    for (const id of unread.keys()) if (!firstRead && !this.unread.has(id)) this.unreadSince.set(id, now);
    for (const id of this.unreadSince.keys()) if (!unread.has(id)) this.unreadSince.delete(id);
    this.unread = unread;
    this.connections = parseConnections(j);
    this.hostNames = new Map(this.connections.map((c) => [c.hostId, c.name]));
    this.syncRemotes();
  }

  // One watcher per SSH host the app works on, while the tracker runs.
  syncRemotes() {
    const wanted = new Map(this.running && this.watchHosts ? this.connections.map((c) => [c.hostId, c]) : []);
    for (const [hostId, remote] of this.remotes) {
      const c = wanted.get(hostId);
      if (c && c.target === remote.target && c.port === remote.port && c.identity === remote.identity) continue;
      remote.stop();
      this.remotes.delete(hostId);
    }
    for (const [hostId, c] of wanted) {
      if (this.remotes.has(hostId)) continue;
      const remote = this.remoteFactory({ hostId, target: c.target, port: c.port, identity: c.identity });
      remote.on('change', () => this.kick());
      remote.on('error', (err) => this.emit('error', err));
      this.remotes.set(hostId, remote);
      remote.start();
    }
  }

  async loadThreadNames() {
    const stamp = await this.stampOf(this.sessionIndexFile);
    if (stamp === this.stamps.names) return;
    this.stamps.names = stamp;
    const names = new Map();
    try {
      for (const line of (await fsp.readFile(this.sessionIndexFile, 'utf8')).split('\n')) {
        try {
          const j = JSON.parse(line);
          if (typeof j?.id === 'string' && typeof j.thread_name === 'string') names.set(j.id, j.thread_name);
        } catch {
          // skip
        }
      }
    } catch {
      // no index yet
    }
    this.threadNames = names;
  }

  async loadCatalog(now) {
    const stamp = await this.stampOf(this.catalogFile, `${this.catalogFile}-wal`);
    if (stamp === this.stamps.catalog) return;
    const wait = CATALOG_MIN_MS - (now - this.lastCatalogRead);
    if (wait > 0) {
      this.retryIn(wait);
      return;
    }
    this.lastCatalogRead = now;
    const catalog = readCatalog(this.catalogFile);
    if (catalog) {
      this.catalog = catalog;
      this.stamps.catalog = stamp;
    }
  }

  async scanRollouts(now) {
    const wanted = new Set();
    const older = [];
    const walk = async (dir, depth) => {
      for (const e of await readdirSafe(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
        else if (e.isFile() && ROLLOUT_RE.test(e.name)) {
          const st = await statSafe(full);
          if (!st) continue;
          if (now - st.mtimeMs <= ROLLOUT_RECENT_MS) wanted.add(full);
          else older.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
        }
      }
    };
    await walk(this.sessionsRoot, 0);
    for (const file of wanted) if (!this.followers.has(file)) this.followers.set(file, new RolloutFollower(file));
    for (const file of [...this.followers.keys()]) if (!wanted.has(file)) this.followers.delete(file);
    await this.loadPastLimits(older);
  }

  // Rate limits come with every reply. When Codex hasn't run here for a while, the latest ones
  // are in the newest rollout we don't follow. Each file is read once.
  async loadPastLimits(older) {
    older.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { file, mtimeMs, size } of older.slice(0, PAST_LIMITS_FILES)) {
      if (this.limits && this.limits.at >= mtimeMs) return;   // what we have is newer
      const stamp = `${file}|${mtimeMs}|${size}`;
      if (this.limitsChecked.has(stamp)) continue;
      if (this.limitsChecked.size >= 100) this.limitsChecked.clear();
      this.limitsChecked.add(stamp);
      const reader = new LimitsReader(file);
      await reader.poll().catch(() => {});
      if (reader.limits) {
        this.pastLimits = reader.limits;
        return;
      }
    }
  }

  recompute(force = false) {
    const now = this.now();
    const byThread = new Map();
    const followed = new Set();
    const session = (threadId, hostId, cwd, derived) => {
      const c = this.catalog.get(threadId);
      const host = c?.hostId || hostId;
      return {
        id: `codex:${threadId}`,
        kind: 'codex',
        hostSessionId: null,
        title: c?.title || this.threadNames.get(threadId) || folderName(c?.cwd || cwd) || 'Codex thread',
        remote: hostName(host, this.hostNames),
        project: projectName(c?.cwd || cwd),
        cwd: c?.cwd || cwd,
        url: threadUrl(threadId, host),
        ...derived,
      };
    };
    // Threads whose history we can see, here or on an SSH host, say what they're doing.
    const follow = (s, hostId, skew) => {
      if (!s.threadId || s.subagent) return;
      followed.add(s.threadId);
      const derived = rolloutStatus(s, {
        now, skew, unread: this.unread.has(s.threadId), dismissedAt: this.dismissed.get(`codex:${s.threadId}`),
      });
      if (derived.status !== 'idle') byThread.set(s.threadId, session(s.threadId, hostId, s.cwd, derived));
    };
    for (const f of this.followers.values()) follow(f.state, 'local', 0);
    for (const [hostId, remote] of this.remotes) {
      for (const f of remote.files.values()) follow(f.state, hostId, remote.skew);
    }
    // Threads on other hosts that finished while you weren't looking.
    for (const [threadId, hostId] of this.unread) {
      if (followed.has(threadId)) continue;
      const host = this.catalog.get(threadId)?.hostId || hostId;
      const since = Math.max(this.catalog.get(threadId)?.updatedAt || 0, this.unreadSince.get(threadId) || 0);
      const dismissedAt = this.dismissed.get(`codex:${threadId}`) || 0;
      if ((dismissedAt && dismissedAt >= since) || (since && now - since > UNREAD_WINDOW_MS)) continue;
      byThread.set(threadId, session(threadId, host, null, { status: 'review', detail: '', since }));
    }

    const out = [...byThread.values()].sort(compareSessions);
    this.sessions = out;
    const key = JSON.stringify(out);
    if (force || key !== this.lastEmitted) {
      this.lastEmitted = key;
      this.emit('change', out);
    }
    this.updateLimits();
  }

  // The rate limits are the account's, so the newest ones win, whichever machine they came from.
  updateLimits() {
    let newest = this.limits;
    const consider = (l, skew = 0) => {
      if (l && (!newest || l.at - skew > newest.at)) newest = { ...l, at: l.at - skew };
    };
    consider(this.pastLimits);
    for (const f of this.followers.values()) consider(f.state.limits);
    for (const remote of this.remotes.values()) consider(remote.limits, remote.skew);
    if (newest === this.limits) return;
    this.limits = newest;
    this.emit('usage', { codex: newest });
  }
}

module.exports = { CodexTracker, codexPaths, parseConnections, parseUnread, readCatalog, threadUrl };
