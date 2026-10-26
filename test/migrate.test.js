'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PREVIOUS, moveFolder, previous } = require('../src/migrate');

test("an older install's names all come from its one name", () => {
  assert.equal(PREVIOUS, 'claude-pet');
  assert.deepEqual(previous, {
    dir: 'claude-pet', homeDir: '.claude-pet', loginItem: 'ClaudePet', hostName: 'com.hyukjunlim.claude_pet',
  });
});

// %APPDATA% with the older install's folder in it: settings, a token, and a webchats\ folder.
function appData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ttokttok-pet-move-'));
  const from = path.join(root, previous.dir);
  fs.mkdirSync(path.join(from, 'webchats'), { recursive: true });
  fs.writeFileSync(path.join(from, 'settings.json'), '{"mode":"folder"}');
  fs.writeFileSync(path.join(from, 'Local State'), 'key');
  fs.writeFileSync(path.join(from, 'webchats', 'host.cmd'), '@echo off');
  return { root, from, to: path.join(root, 'ttokttok-pet') };
}

function same(dir) {
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"mode":"folder"}');
  assert.equal(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'), 'key');
  assert.equal(fs.readFileSync(path.join(dir, 'webchats', 'host.cmd'), 'utf8'), '@echo off');
}

test('a folder nothing holds is renamed, once', () => {
  const { root, from, to } = appData();
  try {
    assert.equal(moveFolder(from, to), `moved ${from} to ${to}`);
    same(to);
    assert.equal(fs.existsSync(from), false);
    assert.equal(moveFolder(from, to), null);
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, 'settings.json'), '{}');
    assert.equal(moveFolder(from, to), null, 'a run of the older install since is left alone');
    assert.equal(fs.existsSync(path.join(from, 'settings.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a folder a browser host holds is copied, and the rest goes once it lets go', { skip: process.platform !== 'win32' && "only Windows keeps a process's folder from being renamed" }, async () => {
  const { root, from, to } = appData();
  // as Chrome starts the web chats host: in the folder of its manifest
  const host = spawn(process.execPath, ['-e', 'console.log("up"); setInterval(() => {}, 1000)'], {
    cwd: path.join(from, 'webchats'), stdio: ['ignore', 'pipe', 'ignore'],
  });
  const gone = new Promise((resolve) => host.on('exit', resolve));
  try {
    await new Promise((resolve) => host.stdout.once('data', resolve));   // it holds its folder once it runs
    assert.equal(moveFolder(from, to, { waitMs: 10 }), `copied ${from} to ${to}; what was still in use goes later`);
    same(to);
    assert.equal(fs.existsSync(`${to}.moving`), false);
    assert.deepEqual(fs.readdirSync(from).sort(), ['moved.txt', 'webchats']);
    assert.equal(moveFolder(from, to), null, 'still held');
    host.kill();
    await gone;
    assert.equal(moveFolder(from, to), `removed what was left of ${from}`);
    assert.equal(fs.existsSync(from), false);
    same(to);
  } finally {
    host.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
