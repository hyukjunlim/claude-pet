'use strict';

// Reads Claude's plan usage on an SSH host. A Claude Code session the desktop app runs over SSH,
// or that you start there from a terminal, runs on the host, so Ttokttok Pet's mod (claude-mod/, set
// up there from the tray menu) saves the usage there, to ~/.ttokttok-pet/usage.json. The pet keeps a small read-only watcher running on the
// host (see ssh-watcher.js) that sends the file whenever it changes, and whether the mod is set up.
// It also follows the host's Claude Code sessions in VS Code or a terminal (the desktop app's
// come through the app), for the bubbles and the sidebar (sessions.js).

const { SshWatcher } = require('./ssh-watcher');
const { parseModUsage } = require('./usage');
const { previous } = require('./migrate');
const { applyEntry, createTurnState } = require('./transcript');

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHATS_SETTLE_MS = 250;   // a burst of lines (a session's tail, at the start) is one update

// Runs on the host. Output, one JSON object per line:
//   {"now": <host time, s>}             every 5 s
//   {"usage": <usage.json> | null}      at the start, and when the file changes
//   {"mod": {"version", "enabled"}}     at the start, and when the mod or Claude's settings change
//   {"chat": <n>, "id": <session id>}   started following a VS Code or terminal session's transcript
//   {"cl": <n>, "l": <line>}            a line of it: its last 768 KB first, then each new one
//   {"chat_reset": <n>}                 it was written anew: its lines start over
//   {"chat_close": <n>}                 stopped following it (a week old, or gone)
//   {"peek": {"id", "entrypoint", "cwd", "title", "ai_title", "summary", "at"}}
//                                       an older one (not written to in a week), from a quick look
//   {"chats": [<n>, …], "peeked": [<id>, …]}   after each look (every 15 s): the ones it has
// It only reads files, and exits when the pet goes away (stdin closes).
const WATCHER = String.raw`
import json, os, re, sys, threading, time

def exit_with_the_pet():
    sys.stdin.read()
    os._exit(0)

threading.Thread(target=exit_with_the_pet, daemon=True).start()

HOME = os.path.expanduser('~')
USAGE = os.path.join(HOME, '.ttokttok-pet', 'usage.json')
# the mod, and an older install's copy, which the pet's next 'update' moves over (claude-mod.js)
HOMES = ('.ttokttok-pet', '${previous.homeDir}')
MANIFESTS = [os.path.join(HOME, d, 'mod', 'pet-usage', '.claude-plugin', 'plugin.json') for d in HOMES]
SETTINGS = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(HOME, '.claude'), 'settings.json')

def send(obj):
    sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')
    sys.stdout.flush()

def stamp(path):
    try:
        st = os.stat(path)
        return [st.st_mtime_ns, st.st_size]
    except OSError:
        return None

def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None

def mod_state():
    env = (read_json(SETTINGS) or {}).get('env') or {}
    dirs = [d.replace(chr(92), '/').rstrip('/') for d in str(env.get('CLAUDE_CODE_PLUGIN_DIRS') or '').split(os.pathsep) if d]
    ours = any(d.endswith('/' + h + '/mod/pet-usage') for d in dirs for h in HOMES)
    version = next((v for v in ((read_json(m) or {}).get('version') for m in MANIFESTS) if v), None)
    return {'version': version, 'enabled': ours and env.get('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS') == '1'}

# VS Code and terminal sessions: the transcripts whose entrypoint isn't the desktop app's (its
# sessions come through the app) or a program's (sdk-...). The last week's are followed; an
# older one gets a quick look (peek), again only when it changes.
PROJECTS = os.path.join(os.path.dirname(SETTINGS), 'projects')
CHAT_DAYS = 7
CHAT_TAIL = 768 * 1024
CHAT_READ = 4 * 1024 * 1024
PEEK = 64 * 1024
SCAN_EVERY = 15
TRANSCRIPT = re.compile(r'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$')
ENTRYPOINT = re.compile(rb'"entrypoint":"([^"]*)"')
chats = {}         # path -> {'n', 'off', 'skip', 'part'}
peeked = {}        # path -> (session id, mtime of the look sent)
unsure = {}        # path -> mtime of a look that didn't say what started it
not_chats = set()  # paths found to be the desktop app's or a program's
next_n = [0]

# What started it: each entry says at its end, so it's in the file's last bytes, most of all (a
# big first message can push it far from the start). None if neither end says.
def entrypoint_of(path):
    try:
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            f.seek(max(0, size - PEEK))
            tail = f.read(PEEK)
            f.seek(0)
            head = f.read(PEEK)
    except OSError:
        return None
    m = ENTRYPOINT.search(tail) or ENTRYPOINT.search(head)
    return m.group(1).decode('utf-8', 'replace') if m else None

def not_a_chat(entrypoint):
    return entrypoint.startswith('claude-desktop') or entrypoint.startswith('sdk')

# The first and last PEEK bytes of a transcript: what started it, its folder, title and last time.
def peek(path, size):
    out = {'entrypoint': None, 'cwd': None, 'title': None, 'ai_title': None, 'summary': None, 'at': None}
    try:
        with open(path, 'rb') as f:
            head = f.read(PEEK)
            tail = b''
            if size > PEEK:
                f.seek(max(PEEK, size - PEEK))
                tail = f.read(PEEK)
    except OSError:
        return None
    # Long lines (a big tool result) can leave no whole entry in either look; what started it is
    # still in the text.
    m = ENTRYPOINT.search(tail) or ENTRYPOINT.search(head)
    if m:
        out['entrypoint'] = m.group(1).decode('utf-8', 'replace')
    lines = head.split(b'\n')
    if size > PEEK:
        lines.pop()   # cut short
    lines += tail.split(b'\n')[1:]
    for raw in lines:
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(e, dict):
            continue
        if isinstance(e.get('entrypoint'), str):
            out['entrypoint'] = e['entrypoint']
        if isinstance(e.get('cwd'), str):
            out['cwd'] = e['cwd']
        kind = e.get('type')
        if kind == 'custom-title' and isinstance(e.get('customTitle'), str):
            out['title'] = e['customTitle']
        elif kind == 'ai-title' and isinstance(e.get('aiTitle'), str):
            out['ai_title'] = e['aiTitle']
        elif kind == 'summary' and isinstance(e.get('summary'), str) and not out['summary']:
            out['summary'] = e['summary']
        stamp = e.get('timestamp')
        if isinstance(stamp, str) and (out['at'] is None or stamp > out['at']):
            out['at'] = stamp
    return out

def scan_chats():
    cutoff = time.time() - CHAT_DAYS * 86400
    found = {}
    try:
        dirs = [d for d in os.listdir(PROJECTS) if not d.startswith('ssh-')]
    except OSError:
        dirs = []
    for d in dirs:
        try:
            names = os.listdir(os.path.join(PROJECTS, d))
        except OSError:
            continue
        for name in names:
            m = TRANSCRIPT.match(name)
            path = os.path.join(PROJECTS, d, name)
            if not m or path in not_chats:
                continue
            try:
                st = os.stat(path)
                found[path] = (m.group(1), st.st_mtime, st.st_size)
            except OSError:
                pass
    for path in [p for p in chats if p not in found or found[p][1] < cutoff]:
        send({'chat_close': chats.pop(path)['n']})
    for path in [p for p in peeked if p not in found or found[p][1] >= cutoff]:
        del peeked[path]
    for path, (sid, mtime, size) in found.items():
        if path in chats:
            continue
        if mtime < cutoff:
            if (path in peeked and peeked[path][1] == mtime) or unsure.get(path) == mtime:
                continue
            info = peek(path, size)
            if info is None:
                continue
            if info['entrypoint'] is None:
                unsure[path] = mtime   # can't tell whose: not listed, nor looked at again till it changes
                continue
            if not_a_chat(info['entrypoint']):
                not_chats.add(path)
                continue
            peeked[path] = (sid, mtime)
            info['id'] = sid
            send({'peek': info})
            continue
        entrypoint = entrypoint_of(path)
        if entrypoint is None:
            continue   # nothing in it yet that says; look again next time
        if not_a_chat(entrypoint):
            not_chats.add(path)
            continue
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        next_n[0] += 1
        start = max(0, size - CHAT_TAIL)
        chats[path] = {'n': next_n[0], 'off': start, 'skip': start > 0, 'part': b''}
        send({'chat': next_n[0], 'id': sid})
    send({'chats': [c['n'] for c in chats.values()], 'peeked': [sid for sid, _ in peeked.values()]})

def pump_chats():
    for path, c in list(chats.items()):
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        if size < c['off']:
            c.update(off=0, skip=False, part=b'')
            send({'chat_reset': c['n']})
        if size == c['off']:
            continue
        try:
            with open(path, 'rb') as f:
                f.seek(c['off'])
                data = f.read(min(size - c['off'], CHAT_READ))
        except OSError:
            continue
        c['off'] += len(data)
        data = c['part'] + data
        if c['skip']:
            nl = data.find(b'\n')
            if nl < 0:
                c['part'] = data
                continue
            data = data[nl + 1:]
            c['skip'] = False
        lines = data.split(b'\n')
        c['part'] = lines.pop()
        for line in lines:
            if line.strip():
                send({'cl': c['n'], 'l': line.decode('utf-8', 'replace')})

seen = {}
last_beat = 0
last_scan = 0
while True:
    now = time.time()
    if now - last_beat >= 5:
        send({'now': now})
        last_beat = now
    if now - last_scan >= SCAN_EVERY:
        scan_chats()
        last_scan = now
    pump_chats()
    s = stamp(USAGE)
    if s != seen.get('usage', 0):
        usage = read_json(USAGE) if s else None
        if s is None or usage is not None:   # else half written: read it again next round
            seen['usage'] = s
            send({'usage': usage})
    s = [stamp(m) for m in MANIFESTS] + [stamp(SETTINGS)]
    if s != seen.get('mod', 0):
        seen['mod'] = s
        send({'mod': mod_state()})
    time.sleep(2)
`;

// A turn state from the watcher's quick look at an older session (peek in WATCHER).
function peekState(p) {
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const state = createTurnState();
  state.entrypoint = str(p.entrypoint);
  state.cwd = str(p.cwd);
  state.title = str(p.title) || str(p.summary);
  state.aiTitle = str(p.ai_title);
  state.lastStampAt = Date.parse(p.at) || 0;
  return state;
}

class ClaudeRemote extends SshWatcher {
  // key: the host as the desktop app's sessions name it (see sshKey in sessions.js), or
  // ssh-config:<name> for a host from ~/.ssh/config
  constructor({ key, name, target, port = null, identity = null, spawnFn, now }) {
    super({ target, port, identity, spawnFn, now, script: WATCHER, label: 'Claude usage' });
    Object.assign(this, { key, name });
    this.usage = null;    // the newest figures the mod saved there, on the host's clock
    this.mod = null;      // { version, enabled } once the watcher has said
    this.chats = new Map();      // session id -> turn state (transcript.js), on the host's clock; kept while away
    this.numbered = new Map();   // this connection's numbers for them -> session id
    this.peeks = new Map();      // session id -> turn state from a quick look: an older session's, listed quiet
    this.chatsTimer = null;
  }

  // A new connection numbers them afresh, and sends each again from its tail.
  onDisconnect() {
    this.numbered.clear();
  }

  chatsChanged() {
    if (this.chatsTimer) return;
    this.chatsTimer = setTimeout(() => {
      this.chatsTimer = null;
      this.emit('chats');
    }, CHATS_SETTLE_MS);
  }

  onMessage(m) {
    if (Number.isInteger(m.chat) && SESSION_ID_RE.test(m.id ?? '')) {
      this.numbered.set(m.chat, m.id);
      this.chats.set(m.id, createTurnState());
      this.peeks.delete(m.id);
      this.chatsChanged();
    } else if (m.peek && typeof m.peek === 'object' && SESSION_ID_RE.test(m.peek.id ?? '')) {
      this.peeks.set(m.peek.id, peekState(m.peek));
      this.chatsChanged();
    } else if (Number.isInteger(m.cl) && typeof m.l === 'string') {
      const state = this.chats.get(this.numbered.get(m.cl));
      if (!state) return;
      try {
        applyEntry(state, JSON.parse(m.l));
      } catch {
        return;   // not a whole entry
      }
      this.chatsChanged();
    } else if (Number.isInteger(m.chat_reset)) {
      const id = this.numbered.get(m.chat_reset);
      if (id) this.chats.set(id, createTurnState());
    } else if (Number.isInteger(m.chat_close)) {
      this.chats.delete(this.numbered.get(m.chat_close));
      this.numbered.delete(m.chat_close);
      this.chatsChanged();
    } else if (Array.isArray(m.chats)) {
      const followed = new Set(m.chats.map((n) => this.numbered.get(n)).filter(Boolean));
      for (const id of [...this.chats.keys()]) if (!followed.has(id)) this.chats.delete(id);
      const peeked = new Set(Array.isArray(m.peeked) ? m.peeked : []);
      for (const id of [...this.peeks.keys()]) if (!peeked.has(id)) this.peeks.delete(id);
      this.chatsChanged();
    } else if ('usage' in m) {
      const usage = parseModUsage(m.usage);
      if (JSON.stringify(usage) === JSON.stringify(this.usage)) return;
      this.usage = usage;
      this.emit('change');
    } else if (m.mod && typeof m.mod === 'object') {
      const mod = { version: typeof m.mod.version === 'string' ? m.mod.version : null, enabled: m.mod.enabled === true };
      if (JSON.stringify(mod) === JSON.stringify(this.mod)) return;
      this.mod = mod;
      this.emit('mod');
    }
  }
}

module.exports = { ClaudeRemote, SESSION_ID_RE, WATCHER };
