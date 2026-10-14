'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { HELPER, raiseCodexWindow } = require('../src/raise');

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

test('a newer raise replaces one still waiting', () => {
  const { runs, spawnFn } = fakeSpawn();
  raiseCodexWindow({ spawnFn, platform: 'win32' });
  raiseCodexWindow({ spawnFn, platform: 'win32' });
  assert.equal(runs[0].child.killed, true);
  assert.equal(runs[1].child.killed, false);
  runs[1].child.emit('exit');
});
