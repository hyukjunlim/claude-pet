'use strict';

// Sets up Claude Pet's mod for Claude Code (claude-mod/, see its register.ts) on this PC, in WSL
// and on SSH hosts, and takes it away again. The mod saves the plan's usage after each reply to
// ~/.claude-pet/usage.json, which keeps the weekly-limit meter current (see claude-usage.js).
//
// Setting it up on a machine:
//   - copies the mod to ~/.claude-pet/mod/pet-usage (WSL runs the Windows copy, through /mnt/c),
//   - and adds two entries to the `env` of Claude Code's ~/.claude/settings.json, which Claude Code
//     reads as each session starts, the desktop app's sessions included:
//       CLAUDE_CODE_PLUGIN_DIRS            the mod's folder, after any folders already listed
//       CLAUDE_CODE_ENABLE_FUNCTION_HOOKS  "1", which mods need
//     The settings file is copied to settings.json.claude-pet.bak first.
// Taking it away removes those again (function hooks only if they were off before), with the
// mod's folder and its usage file.
//
// The desktop app doesn't pass mods on to the sessions it runs in WSL or over SSH (it leaves a
// plugin's hooks/ out when it copies the plugin there), so each of those machines gets its own
// entries. There a small Python script makes the same changes (INSTALLER).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { BOOTSTRAP, LOADER, asciiJson, sshArgs } = require('./ssh-watcher');

const MOD_NAME = 'pet-usage';
const MOD_SOURCE = path.join(__dirname, '..', 'claude-mod');
const MOD_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts'];
const OURS_RE = /[\\/]\.claude-pet[\\/]mod[\\/]pet-usage[\\/]*$/;   // the mod's folder, on any machine
const BACKUP_SUFFIX = '.claude-pet.bak';
const INSTALLER_TIMEOUT_MS = 60_000;

function bundledVersion() {
  return JSON.parse(fs.readFileSync(path.join(MOD_SOURCE, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

// { '.claude-plugin/plugin.json': text, … }
function modFiles() {
  return Object.fromEntries(MOD_FILES.map((rel) => [rel, fs.readFileSync(path.join(MOD_SOURCE, ...rel.split('/')), 'utf8')]));
}

function pluginDirs(env, delimiter) {
  return String(env?.CLAUDE_CODE_PLUGIN_DIRS || '').split(delimiter).filter(Boolean);
}

// Claude Code settings with the mod's folder `dir` added (`delimiter` goes between the folders:
// ';' on Windows, ':' elsewhere), and whether function hooks were off before.
function withMod(settings, dir, delimiter) {
  const env = { ...(isObject(settings.env) ? settings.env : {}) };
  env.CLAUDE_CODE_PLUGIN_DIRS = [...pluginDirs(env, delimiter).filter((d) => !OURS_RE.test(d)), dir].join(delimiter);
  const hooksWereOff = env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS !== '1';
  env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1';
  return { settings: { ...settings, env }, hooksWereOff };
}

// The settings with the mod's entries taken out, function hooks too when the pet turned them on.
function withoutMod(settings, delimiter, { dropFunctionHooks = false } = {}) {
  if (!isObject(settings.env)) return settings;
  const env = { ...settings.env };
  const dirs = pluginDirs(env, delimiter).filter((d) => !OURS_RE.test(d));
  if (dirs.length) env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(delimiter);
  else delete env.CLAUDE_CODE_PLUGIN_DIRS;
  if (dropFunctionHooks) delete env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
  const out = { ...settings, env };
  if (!Object.keys(env).length) delete out.env;
  return out;
}

function hasMod(settings, delimiter) {
  const env = isObject(settings?.env) ? settings.env : {};
  return env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1' && pluginDirs(env, delimiter).some((d) => OURS_RE.test(d));
}

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// The mod on the machine the pet runs on.
class LocalMod {
  constructor({ home = os.homedir(), claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), delimiter = path.delimiter } = {}) {
    this.petDir = path.join(home, '.claude-pet');
    this.dir = path.join(this.petDir, 'mod', MOD_NAME);
    this.usageFile = path.join(this.petDir, 'usage.json');
    this.stateFile = path.join(this.petDir, 'install.json');
    this.claudeDir = claudeDir;
    this.settingsFile = path.join(claudeDir, 'settings.json');
    this.delimiter = delimiter;
  }

  // Whether Claude Code is set up on this machine at all.
  hasClaudeCode() {
    return fs.existsSync(this.claudeDir);
  }

  // { installed, version }: installed when the mod is in place and the settings load it.
  status() {
    let version = null;
    try {
      version = JSON.parse(fs.readFileSync(path.join(this.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null;
    } catch {
      // not copied (yet)
    }
    let enabled = false;
    try {
      enabled = hasMod(this.readSettings(), this.delimiter);
    } catch {
      // unreadable settings: not set up as far as we can tell
    }
    return { installed: Boolean(version) && enabled, version };
  }

  install() {
    this.copyFiles();
    const { settings, hooksWereOff } = withMod(this.readSettings(), this.dir, this.delimiter);
    const state = this.readState();
    writeFileAtomic(this.stateFile, `${JSON.stringify({ functionHooksAdded: Boolean(state.functionHooksAdded || hooksWereOff) })}\n`);
    this.writeSettings(settings);
    return this.status();
  }

  // A newer copy of the mod, after the pet itself was updated. The settings stay as they are.
  update() {
    this.copyFiles();
    return this.status();
  }

  uninstall() {
    const state = this.readState();
    const settings = this.readSettings();
    if (hasMod(settings, this.delimiter) || state.functionHooksAdded) {
      this.writeSettings(withoutMod(settings, this.delimiter, { dropFunctionHooks: Boolean(state.functionHooksAdded) }));
    }
    fs.rmSync(path.join(this.petDir, 'mod'), { recursive: true, force: true });
    fs.rmSync(this.stateFile, { force: true });
    fs.rmSync(this.usageFile, { force: true });
    return this.status();
  }

  copyFiles() {
    for (const [rel, text] of Object.entries(modFiles())) writeFileAtomic(path.join(this.dir, ...rel.split('/')), text);
  }

  readSettings() {
    let text;
    try {
      text = fs.readFileSync(this.settingsFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
    if (!text.trim()) return {};
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`${this.settingsFile} isn't valid JSON, so the pet left it alone.`);
    }
    if (!isObject(j)) throw new Error(`${this.settingsFile} isn't a JSON object, so the pet left it alone.`);
    return j;
  }

  writeSettings(settings) {
    if (fs.existsSync(this.settingsFile)) fs.copyFileSync(this.settingsFile, this.settingsFile + BACKUP_SUFFIX);
    writeFileAtomic(this.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }

  readState() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return isObject(j) ? j : {};
    } catch {
      return {};
    }
  }
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.claude-pet.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// The same changes on another machine (WSL, or an SSH host), in Python 3. It reads one request,
//   { action: 'install' | 'update' | 'uninstall' | 'status', files?: { <path>: <text> }, windowsDir?: <path> }
// and answers with one line, { ok: true, version, enabled } or { ok: false, error }. `files` are
// the mod's, copied to ~/.claude-pet/mod/pet-usage; 'update' copies them and leaves the settings be. In WSL there are none: `windowsDir` names
// the copy on the Windows side, which WSL reaches through its path under /mnt (wslpath).
const INSTALLER = String.raw`
import json, os, shutil, subprocess, sys

req = json.loads(sys.stdin.readline())
HOME = os.path.expanduser('~')
PET = os.path.join(HOME, '.claude-pet')
MOD = os.path.join(PET, 'mod', 'pet-usage')
STATE = os.path.join(PET, 'install.json')
SETTINGS = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(HOME, '.claude'), 'settings.json')

def is_ours(d):
    return d.replace(chr(92), '/').rstrip('/').endswith('/.claude-pet/mod/pet-usage')

def read_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default

def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.claude-pet.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    os.replace(tmp, path)

def remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass

def mod_dir():
    if req.get('windowsDir'):
        out = subprocess.run(['wslpath', '-u', req['windowsDir']], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    return MOD

def answer(settings):
    env = settings.get('env') or {}
    dirs = [d for d in str(env.get('CLAUDE_CODE_PLUGIN_DIRS') or '').split(os.pathsep) if d]
    try:
        manifest = read_json(os.path.join(mod_dir(), '.claude-plugin', 'plugin.json'), {})
    except (OSError, ValueError, subprocess.CalledProcessError):
        manifest = {}
    enabled = any(is_ours(d) for d in dirs) and env.get('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS') == '1'
    return {'ok': True, 'version': manifest.get('version'), 'enabled': enabled}

def main():
    action = req.get('action')
    try:
        text = open(SETTINGS, encoding='utf-8').read()
    except FileNotFoundError:
        text = ''
    try:
        settings = json.loads(text) if text.strip() else {}
    except ValueError:
        return {'ok': False, 'error': SETTINGS + " isn't valid JSON, so the pet left it alone."}
    if not isinstance(settings, dict):
        return {'ok': False, 'error': SETTINGS + " isn't a JSON object, so the pet left it alone."}
    if action == 'status':
        return answer(settings)
    if action == 'update':
        for rel, body in (req.get('files') or {}).items():
            write_text(os.path.join(MOD, *rel.split('/')), body)
        return answer(settings)
    try:
        state = read_json(STATE, {})
    except ValueError:
        state = {}
    env = dict(settings.get('env') or {})
    dirs = [d for d in str(env.get('CLAUDE_CODE_PLUGIN_DIRS') or '').split(os.pathsep) if d and not is_ours(d)]
    if action == 'install':
        for rel, body in (req.get('files') or {}).items():
            write_text(os.path.join(MOD, *rel.split('/')), body)
        env['CLAUDE_CODE_PLUGIN_DIRS'] = os.pathsep.join(dirs + [mod_dir()])
        added = bool(state.get('functionHooksAdded')) or env.get('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS') != '1'
        env['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'] = '1'
        write_text(STATE, json.dumps({'functionHooksAdded': added}) + '\n')
    elif action == 'uninstall':
        if dirs:
            env['CLAUDE_CODE_PLUGIN_DIRS'] = os.pathsep.join(dirs)
        else:
            env.pop('CLAUDE_CODE_PLUGIN_DIRS', None)
        if state.get('functionHooksAdded'):
            env.pop('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', None)
        remove(STATE)
        remove(os.path.join(PET, 'usage.json'))
        shutil.rmtree(os.path.join(PET, 'mod'), ignore_errors=True)
    else:
        return {'ok': False, 'error': 'unknown action ' + str(action)}
    if env:
        settings['env'] = env
    else:
        settings.pop('env', None)
    if os.path.exists(SETTINGS):
        shutil.copyfile(SETTINGS, SETTINGS + '.claude-pet.bak')
    write_text(SETTINGS, json.dumps(settings, indent=2, ensure_ascii=False) + '\n')
    return answer(settings)

try:
    result = main()
except Exception as e:
    result = {'ok': False, 'error': str(e)}
sys.stdout.write(json.dumps(result) + '\n')
`;

// Runs INSTALLER with `command args` (which start python3 reading the script from stdin, see
// LOADER) and resolves its answer; it never rejects.
function runInstaller({ command, args, spawnFn = spawn, timeoutMs = INSTALLER_TIMEOUT_MS }, request) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawnFn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: 'timed out' });
    }, timeoutMs);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => { out += s; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s) => { err += s; });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      const last = out.trim().split(/\r?\n/).pop() || '';
      try {
        const result = JSON.parse(last);
        if (result && typeof result.ok === 'boolean') return finish(result);
      } catch {
        // no answer: python3 missing, ssh refused, …
      }
      // ssh's own notices start with "**" (e.g. about the key exchange); the reason is elsewhere
      const reason = err.replace(/\0/g, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('**')).slice(-2).join(' ');
      finish({ ok: false, error: reason || `exited with ${code}` });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${asciiJson(INSTALLER)}\n${asciiJson(request)}\n`);
  });
}

// The WSL distros running now. (Asking a distro that isn't would start it.)
function runningWslDistros(spawnFn = spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn('wsl.exe', ['--list', '--running', '--quiet'], { windowsHide: true });
    } catch {
      resolve(new Set());
      return;
    }
    const chunks = [];
    child.stdout.on('data', (b) => chunks.push(Buffer.from(b)));
    child.on('error', () => resolve(new Set()));
    child.on('close', () => {
      // wsl.exe writes its own output in UTF-16
      const text = Buffer.concat(chunks).toString('utf16le').replace(/\0/g, '');
      resolve(new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));
    });
  });
}

// An SSH host from the desktop app's connections: { target, port, identity }.
function sshInstaller(host, request, spawnFn) {
  return runInstaller({ command: 'ssh', args: sshArgs(host, BOOTSTRAP), spawnFn }, request);
}

// A WSL distro, running the Windows copy of the mod at `windowsDir`.
function wslInstaller(distro, request, spawnFn) {
  return runInstaller({ command: 'wsl.exe', args: ['-d', distro, '-e', 'python3', '-u', '-c', LOADER], spawnFn }, request);
}

module.exports = {
  INSTALLER,
  LocalMod,
  MOD_NAME,
  bundledVersion,
  hasMod,
  modFiles,
  runInstaller,
  runningWslDistros,
  sshInstaller,
  withMod,
  withoutMod,
  wslInstaller,
};
