'use strict';

// Reads Claude's plan usage on an SSH host. A Claude Code session the desktop app runs over SSH
// runs on the host, so Claude Pet's mod (claude-mod/, set up there from the tray menu) saves the
// usage there, to ~/.claude-pet/usage.json. The pet keeps a small read-only watcher running on the
// host (see ssh-watcher.js) that sends the file whenever it changes, and whether the mod is set up.

const { SshWatcher } = require('./ssh-watcher');
const { parseModUsage } = require('./usage');

// Runs on the host. Output, one JSON object per line:
//   {"now": <host time, s>}             every 5 s
//   {"usage": <usage.json> | null}      at the start, and when the file changes
//   {"mod": {"version", "enabled"}}     at the start, and when the mod or Claude's settings change
// It only reads files, and exits when the pet goes away (stdin closes).
const WATCHER = String.raw`
import json, os, sys, threading, time

def exit_with_the_pet():
    sys.stdin.read()
    os._exit(0)

threading.Thread(target=exit_with_the_pet, daemon=True).start()

HOME = os.path.expanduser('~')
USAGE = os.path.join(HOME, '.claude-pet', 'usage.json')
MANIFEST = os.path.join(HOME, '.claude-pet', 'mod', 'pet-usage', '.claude-plugin', 'plugin.json')
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
    ours = any(d.endswith('/.claude-pet/mod/pet-usage') for d in dirs)
    return {'version': (read_json(MANIFEST) or {}).get('version'),
            'enabled': ours and env.get('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS') == '1'}

seen = {}
last_beat = 0
while True:
    now = time.time()
    if now - last_beat >= 5:
        send({'now': now})
        last_beat = now
    s = stamp(USAGE)
    if s != seen.get('usage', 0):
        usage = read_json(USAGE) if s else None
        if s is None or usage is not None:   # else half written: read it again next round
            seen['usage'] = s
            send({'usage': usage})
    s = [stamp(MANIFEST), stamp(SETTINGS)]
    if s != seen.get('mod', 0):
        seen['mod'] = s
        send({'mod': mod_state()})
    time.sleep(2)
`;

class ClaudeRemote extends SshWatcher {
  // key: the host as the desktop app's sessions name it (see sshKey in sessions.js)
  constructor({ key, name, target, port = null, identity = null, spawnFn, now }) {
    super({ target, port, identity, spawnFn, now, script: WATCHER, label: 'Claude usage' });
    Object.assign(this, { key, name });
    this.usage = null;    // the newest figures the mod saved there, on the host's clock
    this.mod = null;      // { version, enabled } once the watcher has said
  }

  onMessage(m) {
    if ('usage' in m) {
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

module.exports = { ClaudeRemote, WATCHER };
