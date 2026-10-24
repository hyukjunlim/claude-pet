'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BROWSER_HELPER, HELPER, raiseBrowserWindow, raiseCodexWindow } = require('../src/raise');

function fakeSpawn() {
  const runs = [];
  const spawnFn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.killed = false;
    c.kill = () => { c.killed = true; };
    runs.push({ cmd, args, opts, child: c });
    return c;
  };
  return { runs, spawnFn };
}

test("a hidden PowerShell helper raises the Codex app's window, on Windows only", () => {
  const { runs, spawnFn } = fakeSpawn();
  assert.equal(raiseCodexWindow({ spawnFn, platform: 'darwin' }), null);
  assert.equal(runs.length, 0);
  raiseCodexWindow({ spawnFn, platform: 'win32' });
  assert.equal(runs[0].cmd, 'powershell.exe');
  assert.equal(runs[0].opts.windowsHide, true);
  const script = Buffer.from(runs[0].args.at(-1), 'base64').toString('utf16le');
  assert.equal(script, HELPER);
  assert.match(script, /OpenAI\.Codex/);
  assert.match(script, /SetForegroundWindow/);
});

// A lone Alt tap opens the menu bar of the window that has the focus, so the helpers never send one.
test('both helpers send Alt only when the window is not in front, with an unassigned key inside it', () => {
  const steps = [
    'GetForegroundWindow() == h) return true',
    'keybd_event(0x12, 0, 0,',                   // Alt down
    'keybd_event(0xE8, 0, 0,',
    'keybd_event(0xE8, 0, 2,',
    'keybd_event(0x12, 0, 2,',                   // Alt up
    'return SetForegroundWindow(h)',
  ];
  for (const script of [HELPER, BROWSER_HELPER]) {
    const raise = script.slice(script.indexOf('public static bool Raise('));
    const at = steps.map((s) => raise.indexOf(s));
    assert.ok(at.every((i) => i >= 0), `missing step in Raise: ${steps[at.indexOf(-1)]}`);
    assert.deepEqual(at, [...at].sort((a, b) => a - b));
    assert.equal(raise.match(/keybd_event\(0x12,/g).length, 2);   // one Alt down, one Alt up
  }
});

test('a newer raise replaces one still waiting', () => {
  const { runs, spawnFn } = fakeSpawn();
  raiseCodexWindow({ spawnFn, platform: 'win32' });
  raiseCodexWindow({ spawnFn, platform: 'win32' });
  assert.equal(runs[0].child.killed, true);
  assert.equal(runs[1].child.killed, false);
  runs[1].child.emit('exit');
});

test("a web chat's window is found from its host's browser and its tab's title, which reaches the helper only as data", () => {
  const { runs, spawnFn } = fakeSpawn();
  const title = '"; Remove-Item C:\\ -Recurse; "  한글 - Claude';
  raiseBrowserWindow({ hostPid: 4321, title, spawnFn, platform: 'win32', env: { PATH: 'x' } });
  const { opts, args } = runs[0];
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.equal(script, BROWSER_HELPER);
  assert.ok(!script.includes('Remove-Item'));
  assert.match(script, /ParentProcessId/);        // the browser is up the host's parent chain
  assert.equal(opts.env.PET_RAISE_HOST_PID, '4321');
  assert.equal(Buffer.from(opts.env.PET_RAISE_TITLE, 'base64').toString('utf8'), title);
  assert.equal(opts.env.PATH, 'x');
  runs[0].child.emit('exit');
  assert.equal(raiseBrowserWindow({ hostPid: 4321, title, spawnFn, platform: 'darwin' }), null);
  assert.equal(raiseBrowserWindow({ hostPid: null, title, spawnFn, platform: 'win32' }), null);
  assert.equal(raiseBrowserWindow({ hostPid: 4321, title: '', spawnFn, platform: 'win32' }), null);
  assert.equal(runs.length, 1);
});
