'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  INSTALLER, LocalMod, bundledVersion, hasMod, modFiles, runInstaller, withMod, withoutMod,
} = require('../src/claude-mod');
const { LOADER } = require('../src/ssh-watcher');

const WIN_DIR = 'C:\\Users\\me\\.claude-pet\\mod\\pet-usage';
const LINUX_DIR = '/home/me/.claude-pet/mod/pet-usage';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-mod-'));
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test("the mod's folder joins any plugin folders already in Claude Code's settings, once", () => {
  const before = { model: 'opus', env: { CLAUDE_CODE_PLUGIN_DIRS: 'D:\\mods\\mine', OTHER: 'x' } };
  const { settings, hooksWereOff } = withMod(before, WIN_DIR, ';');
  assert.deepEqual(settings, {
    model: 'opus',
    env: { CLAUDE_CODE_PLUGIN_DIRS: `D:\\mods\\mine;${WIN_DIR}`, OTHER: 'x', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
  });
  assert.equal(hooksWereOff, true);
  assert.ok(hasMod(settings, ';'));
  assert.deepEqual(withMod(settings, WIN_DIR, ';').settings, settings, 'setting it up again changes nothing');
  assert.equal(withMod(settings, WIN_DIR, ';').hooksWereOff, false);
  assert.deepEqual(withoutMod(settings, ';', { dropFunctionHooks: true }), before);
  assert.deepEqual(withoutMod(settings, ';'), { ...before, env: { ...before.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } });

  // On Linux the folders are separated by ':', and a moved home is still the mod's.
  const linux = withMod({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/old/home/.claude-pet/mod/pet-usage/' } }, LINUX_DIR, ':').settings;
  assert.equal(linux.env.CLAUDE_CODE_PLUGIN_DIRS, LINUX_DIR);
  assert.deepEqual(withoutMod(linux, ':', { dropFunctionHooks: true }), {});
  assert.equal(hasMod({}, ':'), false);
  assert.equal(hasMod({ env: { CLAUDE_CODE_PLUGIN_DIRS: LINUX_DIR } }, ':'), false, 'mods need function hooks on');
});

test('setting the mod up on this PC copies it and adds it to the settings, and taking it away undoes both', () => {
  const home = tempHome();
  try {
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir);
    const original = `${JSON.stringify({ model: 'opus', env: { CLAUDE_CODE_PLUGIN_DIRS: 'D:\\mods\\mine' } }, null, 2)}\n`;
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), original);
    const mod = new LocalMod({ home, claudeDir, delimiter: ';' });
    assert.ok(mod.hasClaudeCode());
    assert.deepEqual(mod.status(), { installed: false, version: null });

    assert.deepEqual(mod.install(), { installed: true, version: bundledVersion() });
    for (const [rel, text] of Object.entries(modFiles())) {
      assert.equal(fs.readFileSync(path.join(mod.dir, ...rel.split('/')), 'utf8'), text);
    }
    assert.equal(mod.dir, path.join(home, '.claude-pet', 'mod', 'pet-usage'));
    assert.equal(mod.usageFile, path.join(home, '.claude-pet', 'usage.json'));
    assert.deepEqual(readJson(path.join(claudeDir, 'settings.json')).env, {
      CLAUDE_CODE_PLUGIN_DIRS: `D:\\mods\\mine;${mod.dir}`, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    });
    assert.equal(fs.readFileSync(path.join(claudeDir, 'settings.json.claude-pet.bak'), 'utf8'), original, 'the old settings are kept');

    mod.install();
    assert.equal(readJson(path.join(claudeDir, 'settings.json')).env.CLAUDE_CODE_PLUGIN_DIRS, `D:\\mods\\mine;${mod.dir}`);

    fs.writeFileSync(mod.usageFile, '{}');
    assert.deepEqual(mod.uninstall(), { installed: false, version: null });
    assert.deepEqual(readJson(path.join(claudeDir, 'settings.json')), JSON.parse(original));
    assert.equal(fs.existsSync(path.join(home, '.claude-pet', 'mod')), false);
    assert.equal(fs.existsSync(mod.usageFile), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("function hooks you turned on yourself stay on, and settings the pet can't read stay as they are", () => {
  const home = tempHome();
  try {
    const claudeDir = path.join(home, '.claude');
    const mod = new LocalMod({ home, claudeDir });
    assert.equal(mod.hasClaudeCode(), false);

    // No settings file yet: one is made.
    mod.install();
    assert.deepEqual(readJson(path.join(claudeDir, 'settings.json')), {
      env: { CLAUDE_CODE_PLUGIN_DIRS: mod.dir, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    });
    mod.uninstall();
    assert.deepEqual(readJson(path.join(claudeDir, 'settings.json')), {});

    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }));
    mod.install();
    mod.uninstall();
    assert.deepEqual(readJson(path.join(claudeDir, 'settings.json')), { env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } });

    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ "model": ');
    assert.throws(() => mod.install(), /isn't valid JSON/);
    assert.equal(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'), '{ "model": ');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a newer pet brings its newer mod, and leaves the settings be', () => {
  const home = tempHome();
  try {
    const claudeDir = path.join(home, '.claude');
    const mod = new LocalMod({ home, claudeDir, delimiter: ';' });
    mod.install();
    const manifest = path.join(mod.dir, '.claude-plugin', 'plugin.json');
    fs.writeFileSync(manifest, JSON.stringify({ name: 'pet-usage', version: '0.0.1' }));
    const settings = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8');
    fs.rmSync(path.join(claudeDir, 'settings.json.claude-pet.bak'), { force: true });
    assert.equal(mod.status().version, '0.0.1');
    assert.deepEqual(mod.update(), { installed: true, version: bundledVersion() });
    assert.equal(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'), settings);
    assert.equal(fs.existsSync(path.join(claudeDir, 'settings.json.claude-pet.bak')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function fakeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.input = '';
  child.stdin.on('data', (b) => { child.input += b; });
  child.kill = () => {};
  child.stdin.on('finish', () => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    setImmediate(() => child.emit('close', code));
  });
  return child;
}

test("the installer runs over ssh or wsl.exe, and a failure says why without ssh's notices", async () => {
  let spawned;
  const ok = await runInstaller({
    command: 'ssh',
    args: ['lab-server', 'python3'],
    spawnFn: (cmd, args) => {
      spawned = fakeChild({ stdout: 'hello\n{"ok":true,"version":"1.0.0","enabled":true}\n' });
      Object.assign(spawned, { cmd, args });
      return spawned;
    },
  }, { action: 'status' });
  assert.deepEqual(ok, { ok: true, version: '1.0.0', enabled: true });
  const [script, request] = spawned.input.trim().split('\n');
  assert.equal(JSON.parse(script), INSTALLER);
  assert.deepEqual(JSON.parse(request), { action: 'status' });

  const failed = await runInstaller({
    command: 'ssh',
    args: [],
    spawnFn: () => fakeChild({
      stderr: '** WARNING: connection is not using a post-quantum key exchange algorithm.\nbash: python3: command not found\n',
      code: 127,
    }),
  }, { action: 'status' });
  assert.deepEqual(failed, { ok: false, error: 'bash: python3: command not found' });

  const thrown = await runInstaller({ command: 'wsl.exe', args: [], spawnFn: () => { throw new Error('ENOENT'); } }, {});
  assert.deepEqual(thrown, { ok: false, error: 'ENOENT' });
});

// The installer is plain Python 3; run it here against a fake home if Python is installed.
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['-c', 'import sys; sys.exit(sys.version_info[0] != 3)']).status === 0);

test('the installer script sets the mod up on a host and takes it away again', { skip: !python && 'Python 3 is not installed' }, async () => {
  const home = tempHome();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  const run = (request) => runInstaller({
    command: python,
    args: ['-u', '-c', LOADER],
    spawnFn: (cmd, args, opts) => require('node:child_process').spawn(cmd, args, { ...opts, env }),
  }, request);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const modDir = path.join(home, '.claude-pet', 'mod', 'pet-usage');
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const original = { model: 'opus', env: { CLAUDE_CODE_PLUGIN_DIRS: path.join(home, 'mine'), LANG: '한국어' } };
    fs.writeFileSync(settingsFile, JSON.stringify(original));
    assert.deepEqual(await run({ action: 'status' }), { ok: true, version: null, enabled: false });

    assert.deepEqual(await run({ action: 'install', files: modFiles() }), { ok: true, version: bundledVersion(), enabled: true });
    for (const [rel, text] of Object.entries(modFiles())) {
      assert.equal(fs.readFileSync(path.join(modDir, ...rel.split('/')), 'utf8'), text);
    }
    const after = readJson(settingsFile);
    assert.equal(after.env.CLAUDE_CODE_PLUGIN_DIRS, [path.join(home, 'mine'), modDir].join(path.delimiter));
    assert.equal(after.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, '1');
    assert.equal(after.env.LANG, '한국어');
    assert.deepEqual(readJson(`${settingsFile}.claude-pet.bak`), original);

    assert.deepEqual(await run({ action: 'install', files: modFiles() }), { ok: true, version: bundledVersion(), enabled: true });
    assert.equal(readJson(settingsFile).env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter).length, 2, 'set up once');

    fs.writeFileSync(path.join(home, '.claude-pet', 'usage.json'), '{}');
    assert.deepEqual(await run({ action: 'uninstall' }), { ok: true, version: null, enabled: false });
    assert.deepEqual(readJson(settingsFile), original);
    assert.equal(fs.existsSync(path.join(home, '.claude-pet', 'mod')), false);
    assert.equal(fs.existsSync(path.join(home, '.claude-pet', 'usage.json')), false);

    fs.writeFileSync(settingsFile, '{ "model": ');
    const refused = await run({ action: 'install', files: modFiles() });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /isn't valid JSON/);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ "model": ');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
