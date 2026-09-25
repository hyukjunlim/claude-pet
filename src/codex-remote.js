'use strict';

// Follows Codex threads on an SSH host. Codex keeps a thread's history on the machine that runs
// it, so the pet runs a small read-only watcher there over SSH, with the host settings from your
// ~/.ssh/config (the ones the Codex app uses too). The watcher sends new lines of recently
// written rollouts, which are read the same way as rollouts on this PC, plus the host's clock.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { applyRolloutEntry, createRolloutState, rateLimitsOf } = require('./rollout');

// Runs on the host (see BOOTSTRAP). Output, one JSON object per line:
//   {"now": <host time, s>}  every 5 s      {"open": <n>, "path": …}  started following a rollout
//   {"n": <n>, "l": <line>}  a rollout line  {"close": <n>}            stopped following it
//   {"limits": <line>}       once, at the start: the newest rollout line with the account's rate
//                            limits, which may be in a rollout too old to follow
// It only reads files. It exits when the pet goes away: the pet keeps the watcher's stdin open,
// and when the pet quits or dies, the pipe closes and stdin ends.
const WATCHER = String.raw`
import json, os, sys, threading, time

def exit_with_the_pet():
    sys.stdin.read()
    os._exit(0)

threading.Thread(target=exit_with_the_pet, daemon=True).start()

ROOT = os.path.join(os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex'), 'sessions')
RECENT = 3600            # follow rollouts written in the last hour
TAIL = 256 * 1024        # how much of a rollout to send when we start following it
CHUNK = 4 * 1024 * 1024  # read at most this much of one rollout per round
files = {}               # path -> [id, offset, partial line (None: skip up to the next newline)]
last_id = 0
last_beat = 0

def send(obj):
    sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')

def lines_of(entry, data):
    if entry[2] is None:
        nl = data.find(b'\n')
        if nl < 0:
            return []
        data, entry[2] = data[nl + 1:], b''
    parts = (entry[2] + data).split(b'\n')
    entry[2] = parts.pop()
    return parts

def newest_limits():
    rollouts = []
    for folder, _dirs, names in os.walk(ROOT):
        for name in names:
            if name.startswith('rollout-') and name.endswith('.jsonl'):
                path = os.path.join(folder, name)
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

while True:
    now = time.time()
    if now - last_beat >= 5:
        send({'now': now})
        last_beat = now
    if limits:                   # after the clock, so the pet can place it in time
        send({'limits': limits})
        limits = None
    seen = set()
    for folder, _dirs, names in os.walk(ROOT):
        for name in names:
            if not (name.startswith('rollout-') and name.endswith('.jsonl')):
                continue
            path = os.path.join(folder, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if now - st.st_mtime > RECENT:
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

// The watcher arrives as the first line on stdin, and stdin then stays open (see above).
const LOADER = 'import sys, json; exec(json.loads(sys.stdin.readline()))';
const BOOTSTRAP = `exec python3 -u -c '${LOADER}'`;
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-T'];
const RETRY_MS = [5000, 30_000, 2 * 60_000, 10 * 60_000];
const STEADY_MS = 60_000;   // a connection that lasted this long resets the retry delay

class CodexRemote extends EventEmitter {
  // target: what to pass to ssh (a ~/.ssh/config alias or a host name)
  constructor({ hostId, target, port = null, identity = null, spawnFn = spawn, now = Date.now }) {
    super();
    Object.assign(this, { hostId, target, port, identity, spawnFn, now });
    this.files = new Map();     // id -> { path, state }
    this.skew = 0;              // how far the host's clock is ahead of ours, ms
    this.limits = null;         // the newest rate limits seen on the host, on its clock
    this.child = null;
    this.stopped = true;
    this.attempt = 0;
    this.retryTimer = null;
    this.lastError = '';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    if (this.files.size) {
      this.files.clear();
      this.emit('change');
    }
  }

  connect() {
    const args = [...SSH_OPTIONS];
    if (this.port) args.push('-p', String(this.port));
    if (this.identity) args.push('-i', this.identity);
    args.push(this.target, BOOTSTRAP);
    let child;
    try {
      child = this.spawnFn('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.onExit(null, err.message);
      return;
    }
    this.child = child;
    const startedAt = this.now();
    let buffer = '';
    const stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        this.handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s) => {
      stderr.push(...String(s).split(/\r?\n/).filter(Boolean));
      stderr.splice(0, Math.max(0, stderr.length - 3));
    });
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      if (this.now() - startedAt >= STEADY_MS) this.attempt = 0;
      this.onExit(child, stderr.join(' ') || reason);
    };
    child.on('error', (err) => finish(err.message));
    child.on('exit', (code) => finish(`exited with ${code}`));
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(WATCHER)}\n`);   // and no end(): see WATCHER
  }

  onExit(child, reason) {
    if (child && child !== this.child) return;   // an old connection we already replaced or stopped
    this.child = null;
    if (this.files.size) {
      this.files.clear();
      this.emit('change');
    }
    if (this.stopped) return;
    const message = `Codex on ${this.target}: ${reason}`;
    if (message !== this.lastError) this.emit('error', new Error(message));
    this.lastError = message;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  handle(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof m?.now === 'number') {
      this.lastError = '';
      const skew = Math.round(m.now * 1000 - this.now());
      const moved = Math.abs(skew - this.skew) > 1000;
      this.skew = skew;
      if (moved) this.emit('change');
    } else if (m?.open != null && typeof m.path === 'string') {
      this.files.set(m.open, { path: m.path, state: createRolloutState() });
    } else if (m?.close != null) {
      if (this.files.delete(m.close)) this.emit('change');
    } else if (typeof m?.limits === 'string') {
      let limits = null;
      try {
        limits = rateLimitsOf(JSON.parse(m.limits));
      } catch {
        return;
      }
      if (this.keepLimits(limits)) this.emit('change');
    } else if (m?.n != null && typeof m.l === 'string') {
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
