'use strict';

// Follows Codex threads on an SSH host. Codex keeps a thread's history on the machine that runs
// it, so the pet runs a small read-only watcher there over SSH, with the host settings from your
// ~/.ssh/config (the ones the Codex app uses too). The watcher sends new lines of recently
// written rollouts, which are read the same way as rollouts on this PC, plus the host's clock.
// It also lists the host's chats in the Codex VS Code extension and the Codex CLI, which the app
// doesn't list, with their names.

const { applyRolloutEntry, createRolloutState, rateLimitsOf } = require('./rollout');
const { BOOTSTRAP, LOADER, SshWatcher } = require('./ssh-watcher');

// Runs on the host (see ssh-watcher.js). Output, one JSON object per line:
//   {"now": <host time, s>}  every 5 s      {"open": <n>, "path": …}  started following a rollout
//   {"n": <n>, "l": <line>}  a rollout line  {"close": <n>}            stopped following it
//   {"limits": <line>}       once, at the start: the newest rollout line with the account's rate
//                            limits, which may be in a rollout too old to follow
//   {"chats": [[<thread id>, "vscode" or "terminal", <cwd>, <mtime, s>]…]}  the VS Code and
//                            terminal chats, when the list changes (checked every walk)
//   {"names": {<thread id>: <name>}}  their names in session_index.jsonl, when they change
// It only reads files. It exits when the pet goes away: the pet keeps the watcher's stdin open,
// and when the pet quits or dies, the pipe closes and stdin ends.
const WATCHER = String.raw`
import json, os, sys, threading, time

def exit_with_the_pet():
    sys.stdin.read()
    os._exit(0)

threading.Thread(target=exit_with_the_pet, daemon=True).start()

HOME = os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex')
ROOT = os.path.join(HOME, 'sessions')
INDEX = os.path.join(HOME, 'session_index.jsonl')
RECENT = 3600            # follow rollouts written in the last hour,
CHAT_RECENT = 7 * 86400  # and VS Code or terminal chats written in the last week
WALK = 30                # look through every rollout this often (for a resumed old thread);
                         # in between, only the followed ones and the folders of the last two days
TAIL = 256 * 1024        # how much of a rollout to send when we start following it
CHUNK = 4 * 1024 * 1024  # read at most this much of one rollout per round
files = {}               # path -> [id, offset, partial line (None: skip up to the next newline)]
chats = {}               # path -> [thread id, client, cwd] for a VS Code or terminal chat, else None
last_id = 0
last_beat = 0

def send(obj):
    sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')

# Whether a rollout is a VS Code or terminal chat, from its first line (as rollout.js's clientOf).
def chat_of(path):
    if path in chats:
        return chats[path]
    try:
        with open(path, 'rb') as f:
            head = f.readline(8 * 1024 * 1024)
    except OSError:
        return None
    if not head.endswith(b'\n'):
        return None              # still being written
    try:
        p = json.loads(head.decode('utf-8', 'replace')).get('payload')
    except (ValueError, AttributeError):
        p = None
    p = p if isinstance(p, dict) else {}
    source = p.get('source')
    client = None
    if isinstance(p.get('id'), str) and not isinstance(source, dict):
        client = 'vscode' if p.get('originator') == 'codex_vscode' else 'terminal' if source == 'cli' else None
    chats[path] = [p['id'], client, p.get('cwd')] if client else None
    return chats[path]

def names_of(ids):
    names = {}
    try:
        with open(INDEX, 'rb') as f:
            for line in f:
                try:
                    j = json.loads(line.decode('utf-8', 'replace'))
                    if j.get('id') in ids and isinstance(j.get('thread_name'), str):
                        names[j['id']] = j['thread_name']
                except (ValueError, AttributeError, TypeError):
                    pass
    except OSError:
        pass
    return names

def lines_of(entry, data):
    if entry[2] is None:
        nl = data.find(b'\n')
        if nl < 0:
            return []
        data, entry[2] = data[nl + 1:], b''
    parts = (entry[2] + data).split(b'\n')
    entry[2] = parts.pop()
    return parts

def is_rollout(name):
    return name.startswith('rollout-') and name.endswith('.jsonl')

def every_rollout():
    for folder, _dirs, names in os.walk(ROOT):
        for name in names:
            if is_rollout(name):
                yield os.path.join(folder, name)

# Codex files a thread under sessions/YYYY/MM/DD/ for the day it started, on the host's clock.
def recent_rollouts(now):
    days = set()
    for t in (now, now - 86400):
        for tm in (time.localtime(t), time.gmtime(t)):
            days.add(os.path.join(ROOT, time.strftime('%Y', tm), time.strftime('%m', tm), time.strftime('%d', tm)))
    for folder in days:
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in names:
            if is_rollout(name):
                yield os.path.join(folder, name)

def newest_limits():
    rollouts = []
    for path in every_rollout():
        try:
            rollouts.append((os.stat(path).st_mtime, path))
        except OSError:
            pass
    rollouts.sort(reverse=True)
    for _mtime, path in rollouts[:3]:
        try:
            with open(path, 'rb') as f:
                size = os.fstat(f.fileno()).st_size
                f.seek(max(0, size - TAIL))
                lines = f.read().split(b'\n')
        except OSError:
            continue
        if size > TAIL:
            lines = lines[1:]    # cut off by the seek
        for line in reversed(lines):
            if b'"rate_limits":{' in line:
                return line.decode('utf-8', 'replace')
    return None

limits = newest_limits()
last_walk = 0
listed = None
index_stamp = None
named = None

while True:
    now = time.time()
    if now - last_beat >= 5:
        send({'now': now})
        last_beat = now
    if limits:                   # after the clock, so the pet can place it in time
        send({'limits': limits})
        limits = None
    if now - last_walk >= WALK:
        candidates = list(every_rollout())
        last_walk = now
        found = []
        for path in candidates:
            chat = chat_of(path)
            try:
                if chat:
                    found.append(chat + [os.stat(path).st_mtime])
            except OSError:
                pass
        if found != listed:
            send({'chats': found})
            listed = found
        ids = set(c[0] for c in found)
        try:
            st = os.stat(INDEX)
            stamp = (st.st_mtime, st.st_size, ids)
        except OSError:
            stamp = (None, None, ids)
        if stamp != index_stamp:
            index_stamp = stamp
            names = names_of(ids)
            if names != named:
                send({'names': names})
                named = names
    else:
        candidates = list(files) + list(recent_rollouts(now))
    checked = set()
    seen = set()
    for path in candidates:
        if path in checked:
            continue
        checked.add(path)
        try:
            st = os.stat(path)
        except OSError:
            continue
        age = now - st.st_mtime
        if age > RECENT and (age > CHAT_RECENT or not chat_of(path)):
            continue
        seen.add(path)
        entry = files.get(path)
        if entry is None or st.st_size < entry[1]:
            if entry is not None:
                send({'close': entry[0]})
            last_id += 1
            entry = files[path] = [last_id, 0, b'']
            send({'open': last_id, 'path': path})
            if st.st_size > TAIL:
                with open(path, 'rb') as f:
                    head = f.readline(8 * 1024 * 1024)
                if head.endswith(b'\n'):
                    send({'n': last_id, 'l': head[:-1].decode('utf-8', 'replace')})
                entry[1], entry[2] = st.st_size - TAIL, None
        if st.st_size > entry[1]:
            with open(path, 'rb') as f:
                f.seek(entry[1])
                data = f.read(min(CHUNK, st.st_size - entry[1]))
            entry[1] += len(data)
            for line in lines_of(entry, data):
                if line.strip():
                    send({'n': entry[0], 'l': line.decode('utf-8', 'replace')})
    for path in [p for p in files if p not in seen]:
        send({'close': files.pop(path)[0]})
    sys.stdout.flush()
    time.sleep(1)
`;

class CodexRemote extends SshWatcher {
  // target: what to pass to ssh (a ~/.ssh/config alias or a host name)
  constructor({ hostId, target, port = null, identity = null, spawnFn, now }) {
    super({ target, port, identity, spawnFn, now, script: WATCHER, label: 'Codex' });
    this.hostId = hostId;
    this.files = new Map();     // id -> { path, state }
    this.limits = null;         // the newest rate limits seen on the host, on its clock
    this.chats = new Map();     // threadId -> { client, cwd, mtimeMs }: its VS Code and terminal chats, on its clock
    this.names = new Map();     // threadId -> the chat's name
  }

  onDisconnect() {
    if (!this.files.size) return;
    this.files.clear();
    this.emit('change');
  }

  onMessage(m) {
    if (m.open != null && typeof m.path === 'string') {
      this.files.set(m.open, { path: m.path, state: createRolloutState() });
    } else if (m.close != null) {
      if (this.files.delete(m.close)) this.emit('change');
    } else if (typeof m.limits === 'string') {
      let limits = null;
      try {
        limits = rateLimitsOf(JSON.parse(m.limits));
      } catch {
        return;
      }
      if (this.keepLimits(limits)) this.emit('change');
    } else if (Array.isArray(m.chats)) {
      this.chats = new Map();
      for (const c of m.chats) {
        if (!Array.isArray(c) || typeof c[0] !== 'string' || (c[1] !== 'vscode' && c[1] !== 'terminal')) continue;
        this.chats.set(c[0], { client: c[1], cwd: typeof c[2] === 'string' ? c[2] : null, mtimeMs: (Number(c[3]) || 0) * 1000 });
      }
      this.emit('change');
    } else if (m.names && typeof m.names === 'object') {
      this.names = new Map(Object.entries(m.names).filter(([, name]) => typeof name === 'string'));
      this.emit('change');
    } else if (m.n != null && typeof m.l === 'string') {
      const f = this.files.get(m.n);
      if (!f) return;
      try {
        applyRolloutEntry(f.state, JSON.parse(m.l));
      } catch {
        return;   // a line we can't parse (or a newer format)
      }
      this.keepLimits(f.state.limits);
      this.emit('change');
    }
  }

  // The newest rate limits stay after the rollout they came in is no longer followed.
  keepLimits(limits) {
    if (!limits || (this.limits && limits.at <= this.limits.at)) return false;
    this.limits = limits;
    return true;
  }
}

module.exports = { BOOTSTRAP, CodexRemote, LOADER, WATCHER };
