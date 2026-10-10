'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ClaudeUsage, parseSshHosts } = require('../src/claude-usage');
const { ClaudeRemote, WATCHER } = require('../src/claude-remote');
const { BOOTSTRAP, LOADER } = require('../src/ssh-watcher');

const T0 = Date.parse('2026-03-14T09:00:00.000Z');
const WEEK = 7 * 86_400_000;
const RESET = T0 + 2 * 86_400_000;
const saved = (at, weekly) => ({ version: 1, at, limits: [{ kind: 'seven_day', percent: weekly, resetsAt: RESET }] });

const flush = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (pred, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    if (pred()) return true;
  }
  return false;
};

test("the SSH hosts are the desktop app's saved connections", () => {
  assert.deepEqual(parseSshHosts({
    configs: [
      { name: 'Lab', sshHost: 'me@lab-server', sshPort: 2222, sshIdentityFile: 'C:\\Users\\me\\.ssh\\id_lab' },
      { name: '', sshHost: 'me@gpu-box' },
      { name: 'broken' },
    ],
  }), [
    { key: 'ssh:me@lab-server:2222', name: 'Lab', target: 'me@lab-server', port: 2222, identity: 'C:\\Users\\me\\.ssh\\id_lab' },
    { key: 'ssh:me@gpu-box:22', name: 'gpu-box', target: 'me@gpu-box', port: null, identity: null },
  ]);
  assert.deepEqual(parseSshHosts(null), []);
});

function fakeSsh() {
  const children = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.script = '';
    child.stdin.on('data', (b) => { child.script += b; });
    child.kill = () => setImmediate(() => child.emit('exit', null));
    Object.assign(child, { cmd, args });
    children.push(child);
    return child;
  };
  return { spawnFn, children };
}

test("the SSH watcher reports the host's saved usage, and whether the mod is set up there", async () => {
  const { spawnFn, children } = fakeSsh();
  const remote = new ClaudeRemote({ key: 'ssh:lab-server:22', name: 'lab-server', target: 'lab-server', spawnFn });
  remote.on('error', () => {});
  const events = [];
  remote.on('change', () => events.push('change'));
  remote.on('mod', () => events.push('mod'));
  remote.start();
  const [child] = children;
  assert.deepEqual(child.args.slice(-2), ['lab-server', BOOTSTRAP]);
  await flush();
  assert.equal(JSON.parse(child.script), WATCHER);

  const say = (m) => child.stdout.write(`${JSON.stringify(m)}\n`);
  say({ mod: { version: '1.0.0', enabled: true } });
  say({ usage: saved(T0, 42) });
  say({ usage: saved(T0, 42) });   // the same again: no news
  await flush();
  assert.deepEqual(remote.mod, { version: '1.0.0', enabled: true });
  assert.deepEqual(remote.usage, { weekly: { percent: 42, resetsAt: RESET, windowMs: WEEK }, fiveHour: null, at: T0 });
  assert.deepEqual(events, ['mod', 'change']);

  say({ usage: null });   // taken away
  await flush();
  assert.equal(remote.usage, null);
  remote.stop();
});

test("Claude's readings come from the mod's file here and on each SSH host", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-usage-'));
  const usageFile = path.join(dir, 'usage.json');
  const sshConnections = path.join(dir, 'ssh_configs.json');
  const remotes = [];
  const usage = new ClaudeUsage({
    usageFile,
    sshConnections,
    pollMs: 20,
    remoteFactory: (o) => {
      const r = Object.assign(new EventEmitter(), o, { usage: null, mod: null, skew: 0, started: false });
      r.start = () => { r.started = true; };
      r.stop = () => { r.started = false; };
      remotes.push(r);
      return r;
    },
  });
  let readings = [];
  usage.on('change', (list) => { readings = list; });
  usage.on('error', (err) => { throw err; });
  try {
    fs.writeFileSync(usageFile, JSON.stringify(saved(T0, 40)));
    fs.writeFileSync(sshConnections, JSON.stringify({ configs: [{ name: 'Lab', sshHost: 'lab-server' }] }));
    usage.start();
    assert.ok(await waitFor(() => readings.length === 1 && remotes.length === 1));
    assert.equal(readings[0].weekly.percent, 40);
    assert.equal(remotes[0].started, true);
    assert.deepEqual(usage.hostStates(), [{ key: 'ssh:lab-server:22', name: 'Lab', target: 'lab-server', port: null, identity: null, mod: null }]);

    // The host's clock runs a minute ahead; its readings come over on ours.
    remotes[0].skew = 60_000;
    remotes[0].usage = { weekly: { percent: 44, resetsAt: RESET, windowMs: WEEK }, fiveHour: null, at: T0 + 120_000 };
    remotes[0].emit('change');
    remotes[0].mod = { version: '1.0.0', enabled: true };
    remotes[0].emit('mod');
    assert.deepEqual(readings.map((r) => [r.weekly.percent, r.at]), [[40, T0], [44, T0 + 60_000]]);
    assert.deepEqual(usage.hostStates()[0].mod, { version: '1.0.0', enabled: true });

    // A newer file here; then hosts no longer watched.
    fs.writeFileSync(usageFile, JSON.stringify(saved(T0 + 300_000, 47)));
    assert.ok(await waitFor(() => readings.some((r) => r.weekly.percent === 47)));
    usage.setWatchHosts(false);
    assert.equal(remotes[0].started, false);
    assert.deepEqual(readings.map((r) => r.weekly.percent), [47]);
    assert.deepEqual(usage.hostStates()[0].mod, null);

    fs.rmSync(usageFile);
    assert.ok(await waitFor(() => readings.length === 0));
  } finally {
    usage.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The watcher is plain Python 3; run it here against a fake home if Python is installed.
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['-c', 'import sys; sys.exit(sys.version_info[0] != 3)']).status === 0);

test('the watcher script sends the usage file and the mod state, and again when they change', { skip: !python && 'Python 3 is not installed' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-watch-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  const petDir = path.join(home, '.claude-pet');
  const modDir = path.join(petDir, 'mod', 'pet-usage');
  fs.mkdirSync(path.join(modDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(modDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pet-usage', version: '1.0.0' }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: modDir } }));
  fs.writeFileSync(path.join(petDir, 'usage.json'), JSON.stringify(saved(T0, 40)));
  const child = spawn(python, ['-u', '-c', LOADER], { env, windowsHide: true });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    const messages = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        messages.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stdin.write(`${JSON.stringify(WATCHER)}\n`);
    const last = (key) => messages.filter((m) => key in m).at(-1)?.[key];
    assert.ok(await waitFor(() => messages.some((m) => typeof m.now === 'number')), 'sends the host clock');
    assert.ok(await waitFor(() => last('usage') && last('mod')));
    assert.deepEqual(last('usage'), saved(T0, 40));
    assert.deepEqual(last('mod'), { version: '1.0.0', enabled: false }, 'function hooks are off');

    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      env: { CLAUDE_CODE_PLUGIN_DIRS: modDir, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    }));
    fs.writeFileSync(path.join(petDir, 'usage.json'), JSON.stringify(saved(T0 + 60_000, 42)));
    assert.ok(await waitFor(() => last('mod')?.enabled === true && last('usage')?.at === T0 + 60_000, 8000));

    child.stdin.end();
    const late = new Promise((resolve) => setTimeout(() => resolve('still running'), 4000));
    assert.notEqual(await Promise.race([exited, late]), 'still running');
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
