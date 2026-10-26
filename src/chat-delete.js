'use strict';

// The sidebar's Delete for a chat run in VS Code or a terminal: the one write to Claude's and
// Codex's files besides the opt-in mod (CONSTRAINTS.md), and only after you confirm it.
//   - A Claude Code session's transcript (~/.claude/projects/<project>/<id>.jsonl) and the folder
//     beside it go: to the Recycle Bin on this PC; for good in WSL, whose files the Recycle Bin
//     can't take, and on an SSH host, where one SSH command removes them.
//   - A Codex chat is archived by Codex itself: the pet starts Codex's app-server on the chat's
//     machine and asks it for thread/archive, so Codex's own records stay in step, and the chat
//     can be brought back from Codex's archived chats.

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LOADER, sshArgs } = require('./ssh-watcher');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUIET_MS = 2 * 60 * 1000;            // a chat written this recently may still be open
const BUSY = new Set(['running', 'waiting', 'background']);
const TIMEOUT_MS = 60 * 1000;
const SSH_PYTHON = `exec python3 -u -c '${LOADER}'`;

// Whether a sidebar row is a chat that can be deleted: Claude Code's or Codex's, from VS Code or a
// terminal (not the apps' own), and nothing going on in it.
function isChat(s) {
  return Boolean(s && (s.kind === 'cli' || (s.kind === 'codex' && s.client)));
}

function canDelete(s, now = Date.now()) {
  return isChat(s) && !BUSY.has(s.status) && now - (s.lastActivityAt || 0) >= QUIET_MS;
}

// ---------------------------------------------------------------- Claude Code

// Runs on an SSH host: removes the session's transcript and the folder beside it, and prints how
// many transcripts it found (the id is a checked UUID, so it's safe inside the script).
function claudeDeleteScript(sessionId) {
  if (!ID_RE.test(sessionId)) throw new Error('Not a Claude Code session id');
  return String.raw`
import glob, os, shutil
ROOT = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'), 'projects')
gone = 0
for f in glob.glob(os.path.join(ROOT, '*', '${sessionId}.jsonl')):
    os.remove(f)
    gone += 1
    if os.path.isdir(f[:-6]):
        shutil.rmtree(f[:-6])
print(gone)
`;
}

// `place`: 'local' or 'wsl' with the transcript's `file`, or 'ssh' with the `host` ({ target,
// port, identity, name }). `trashItem`: Electron's shell.trashItem.
async function deleteClaudeSession({ sessionId, place, file = null, host = null, trashItem, spawnFn = spawn }) {
  if (!ID_RE.test(sessionId)) throw new Error('Not a Claude Code session id');
  if (place === 'ssh') {
    const { code, stdout, stderr } = await run(spawnFn, 'ssh', sshArgs(host, SSH_PYTHON), `${JSON.stringify(claudeDeleteScript(sessionId))}\n`);
    const gone = Number(stdout.trim());
    if (code !== 0 || !Number.isFinite(gone)) throw new Error(lastLine(stderr) || `ssh ${host.name || host.target} failed`);
    if (gone < 1) throw new Error(`It's no longer on ${host.name || host.target}.`);
    return;
  }
  if (!file || path.basename(file) !== `${sessionId}.jsonl`) throw new Error("Couldn't find its transcript.");
  const folder = file.slice(0, -'.jsonl'.length);
  const hasFolder = await fsp.stat(folder).then((st) => st.isDirectory(), () => false);
  if (place === 'local') {
    await trashItem(file);
    if (hasFolder) await trashItem(folder);
  } else {
    await fsp.rm(file);
    if (hasFolder) await fsp.rm(folder, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- Codex

// Runs in WSL or on an SSH host: finds Codex (the newest VS Code extension's copy, else `codex` on
// the PATH, else ~/.local/bin/codex), says so, and becomes its app-server on the same stdin. The
// pet sends nothing more until it has heard back, so none of the app-server's input is lost in
// Python's buffer.
const CODEX_LOCATOR = String.raw`
import glob, json, os, re, shutil, sys
def version(p):
    m = re.search(r'openai\.chatgpt-([0-9.]+)', p)
    return [int(x) for x in m.group(1).split('.') if x] if m else []
found = sorted(glob.glob(os.path.expanduser('~/.vscode-server/extensions/openai.chatgpt-*/bin/linux-*/codex')), key=version)
codex = found[-1] if found else (shutil.which('codex') or os.path.expanduser('~/.local/bin/codex'))
if not os.access(codex, os.X_OK):
    print(json.dumps({'error': 'Codex is not installed there'}))
    sys.exit(0)
print(json.dumps({'ready': codex}))
sys.stdout.flush()
os.execv(codex, [codex, 'app-server'])
`;

// Codex on this PC: the newest VS Code extension's copy.
function localCodex({ home = os.homedir() } = {}) {
  const dir = path.join(home, '.vscode', 'extensions');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^openai\.chatgpt-[0-9.]+-win32-/.test(n));
  } catch {
    // no VS Code extensions
  }
  const version = (n) => /-([0-9.]+)-/.exec(n)[1].split('.').map(Number);
  names.sort((a, b) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  });
  for (const n of names.reverse()) {
    const exe = path.join(dir, n, 'bin', 'windows-x86_64', 'codex.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

// `place`: 'local', 'wsl' with its `distro`, or 'ssh' with its `host`.
async function archiveCodexChat({ threadId, place, distro = null, host = null, spawnFn = spawn, codexExe = localCodex, timeoutMs = TIMEOUT_MS }) {
  if (!ID_RE.test(threadId)) throw new Error('Not a Codex thread id');
  let child;
  if (place === 'local') {
    const exe = codexExe();
    if (!exe) throw new Error("Couldn't find Codex on this PC (it comes with the Codex VS Code extension).");
    child = spawnFn(exe, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } else if (place === 'wsl') {
    child = spawnFn('wsl.exe', ['-d', distro, '-e', 'python3', '-u', '-c', LOADER], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    child = spawnFn('ssh', sshArgs(host, SSH_PYTHON), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return archiveThrough(child, threadId, { locate: place !== 'local', timeoutMs });
}

// Talks JSON-RPC (one message a line) with an app-server: initialize, then thread/archive.
// `locate`: the CODEX_LOCATOR comes first and says when the app-server is there.
function archiveThrough(child, threadId, { locate = false, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let done = false;
    const stderr = [];
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();   // the app-server ends with its input
      setTimeout(() => child.kill(), 3000).unref?.();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Codex didn't answer in time.")), timeoutMs);
    const initialize = () => send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ttokttok_pet', version: '1' } } });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        let m;
        try {
          m = JSON.parse(buffer.slice(0, nl));
        } catch {
          m = null;
        }
        buffer = buffer.slice(nl + 1);
        if (!m || typeof m !== 'object') continue;
        if (m.id == null && typeof m.ready === 'string') initialize();
        else if (m.id == null && typeof m.error === 'string') finish(new Error(m.error));
        else if (m.id === 1) {
          if (m.error) finish(new Error(m.error.message || 'Codex refused to start'));
          else {
            send({ method: 'initialized' });
            send({ id: 2, method: 'thread/archive', params: { threadId } });
          }
        } else if (m.id === 2) {
          finish(m.error ? new Error(m.error.message || "Codex couldn't archive it") : null);
        }
      }
    });
    child.stderr?.on('data', (d) => stderr.push(String(d)));
    child.on('error', (err) => finish(err));
    child.on('close', (code) => finish(new Error(lastLine(stderr.join('')) || `Codex stopped (${code})`)));
    if (locate) child.stdin.write(`${JSON.stringify(CODEX_LOCATOR)}\n`);
    else initialize();
  });
}

// ---------------------------------------------------------------- helpers

function run(spawnFn, cmd, args, input, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// The last line of an error output that says something (ssh's notices about key exchange don't).
function lastLine(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('**')).at(-1) || '';
}

module.exports = {
  CODEX_LOCATOR, archiveCodexChat, archiveThrough, canDelete, claudeDeleteScript, deleteClaudeSession, isChat, localCodex,
};
