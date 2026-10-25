'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { REGISTRY, WebChatsFeature, batchPath, extensionId, launcher } = require('../src/webchats/feature');
const { createHost, frame, frameReader } = require('../src/webchats/host');
const { END_GRACE_MS } = require('../src/webchats/chats');

const ROOT = path.join(__dirname, '..');
const CONV = '0f8fad5b-d9cb-469f-a165-70867728950e';

function feature(t, saved = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webchats-'));
  const data = { webChats: true, ...saved };
  const settings = { get: (k) => data[k], set: (p) => Object.assign(data, p) };
  const reg = [];
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\ttokttok-pet-webchats-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    : path.join(dir, 'webchats.sock');
  const f = new WebChatsFeature({
    electron: { dialog: { showMessageBox: async () => ({ response: 1 }) }, shell: { openPath() {} } },
    settings,
    appRoot: ROOT,
    userData: dir,
    exe: 'C:\\Users\\민수\\AppData\\Local\\Programs\\ttokttok-pet\\Ttokttok Pet.exe',
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\민수\\AppData\\Local', USERPROFILE: 'C:\\Users\\민수' },
    pipePath,
    execFileFn: (cmd, args, opts, cb) => {
      reg.push([cmd, ...args]);
      cb(null);
    },
  });
  t.after(() => f.stop());
  return { f, data, reg, dir, pipePath };
}

test("the extension's id comes from the key in its manifest", () => {
  const { key } = JSON.parse(fs.readFileSync(path.join(ROOT, 'browser-extension', 'manifest.json'), 'utf8'));
  assert.equal(extensionId(key), 'habdcjjcoianlobddinmnmmcpgolmohh');
});

test('a batch file names folders under the user profile through %VARIABLES%, so a non-ASCII user name stays out of it', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\민수\\AppData\\Local', APPDATA: 'C:\\Users\\민수\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\민수' };
  assert.equal(batchPath('C:\\Users\\민수\\AppData\\Local\\Programs\\ttokttok-pet\\Ttokttok Pet.exe', env), '%LOCALAPPDATA%\\Programs\\ttokttok-pet\\Ttokttok Pet.exe');
  assert.equal(batchPath('c:\\users\\민수\\ttokttok-pet\\src\\webchats\\host.js', env), '%USERPROFILE%\\ttokttok-pet\\src\\webchats\\host.js');
  assert.equal(batchPath('D:\\pet\\100%\\host.js', env), 'D:\\pet\\100%%\\host.js');
  assert.equal(batchPath('C:\\Users\\민수2\\x.exe', env), 'C:\\Users\\민수2\\x.exe');   // only a whole folder name counts
  const text = launcher({ exe: 'D:\\pet\\pet.exe', script: 'D:\\pet\\host.js', env });
  assert.equal(text, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"D:\\pet\\pet.exe" "D:\\pet\\host.js" %*\r\n');
});

test('turning web chats on registers one host with Chrome and Edge for this extension only; off removes it', async (t) => {
  const { f, data, reg, dir } = feature(t);
  await f.register();
  const manifestPath = path.join(dir, 'webchats', 'host.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, 'com.hyukjunlim.ttokttok_pet');
  assert.equal(manifest.type, 'stdio');
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://habdcjjcoianlobddinmnmmcpgolmohh/']);
  assert.equal(manifest.path, path.join(dir, 'webchats', 'host.cmd'));
  const cmd = fs.readFileSync(manifest.path, 'utf8');
  assert.match(cmd, /^"%LOCALAPPDATA%\\Programs\\ttokttok-pet\\Ttokttok Pet\.exe" ".*host\.js" %\*\r$/m);
  assert.deepEqual(reg, [
    ['reg.exe', 'add', REGISTRY.chrome, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
    ['reg.exe', 'add', REGISTRY.edge, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'],
  ]);
  assert.match(REGISTRY.chrome, /^HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\/);
  assert.match(REGISTRY.edge, /^HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\/);
  reg.length = 0;
  await f.setEnabled(false);
  assert.equal(data.webChats, false);
  assert.deepEqual(reg, [['reg.exe', 'delete', REGISTRY.chrome, '/f'], ['reg.exe', 'delete', REGISTRY.edge, '/f']]);
});

test('off by default: nothing is registered and nothing listens', async (t) => {
  const { f, reg } = feature(t, { webChats: false });
  await f.start();
  assert.deepEqual(reg, []);
  assert.equal(f.server, null);
  assert.equal(f.menu().submenu[0].checked, false);
});

test('a tab reported through a real host and pipe becomes a bubble, and its click brings the tab forward', async (t) => {
  const { f, pipePath } = feature(t);
  const changes = [];
  f.on('change', (list) => changes.push(list));
  await f.start();
  await new Promise((r) => f.server.listening ? r() : f.server.once('listening', r));
  assert.equal(f.menu().submenu.at(-1).label, 'Waiting for the extension');

  const input = new PassThrough();
  const output = new PassThrough();
  const toBrowser = [];
  output.on('data', frameReader((m) => toBrowser.push(m)));
  const host = createHost({ input, output, connect: () => net.connect(pipePath) });
  t.after(() => host.stop());
  input.write(frame({
    type: 'chat', tabId: 4, windowId: 2, site: 'claude', url: `https://claude.ai/chat/${CONV}`,
    title: 'Pipe test - Claude', generating: true, looking: false,
  }));
  const deadline = Date.now() + 3000;
  while (!changes.at(-1)?.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  const [item] = changes.at(-1);
  assert.deepEqual([item.id, item.status, item.title], [`web:claude:${CONV}`, 'running', 'Pipe test']);
  assert.equal(f.menu().submenu.at(-1).label, 'Extension connected');
  assert.equal(f.target(item.id).tab.hostPid, process.pid);

  assert.equal(f.focus(item.id), true);
  while (!toBrowser.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(toBrowser, [{ type: 'focus', tabId: 4 }]);

  input.write(frame({
    type: 'chat', tabId: 4, windowId: 2, site: 'claude', url: `https://claude.ai/chat/${CONV}`,
    title: 'Pipe test - Claude', generating: false, looking: false,
  }));
  while (changes.at(-1)?.[0]?.status !== 'review' && Date.now() < deadline + END_GRACE_MS) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(changes.at(-1)[0].status, 'review');

  input.end();                                  // the browser closed: its host and its tabs go
  while (f.sockets.size && Date.now() < deadline + END_GRACE_MS + 2000) await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.sockets.size, 0);
  assert.deepEqual(f.target(item.id).tab, null);   // the Ready chat stays, to open by its address
});
