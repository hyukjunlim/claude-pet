'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AppBar, CALLBACK_MESSAGE, parseRect, script } = require('../src/appbar');

test('the helper reports the strip as left,top,right,bottom; anything else is no strip', () => {
  assert.deepEqual(parseRect('0,0,450,2160\r\n'), { x: 0, y: 0, width: 450, height: 2160 });
  assert.deepEqual(parseRect('-1920,0,-1470,1080'), { x: -1920, y: 0, width: 450, height: 1080 });
  assert.equal(parseRect(''), null);
  assert.equal(parseRect('0,0,0,2160'), null);
  assert.equal(parseRect('Exception calling "Dock"'), null);
});

test('the helper script gets the window, the action, the message and the width', () => {
  const s = script('dock', 123456789n, 450.4);
  assert.match(s, /\[long\]'123456789'/);
  assert.match(s, /if \('dock' -eq 'dock'\)/);
  assert.match(s, new RegExp(`Dock\\(\\$h, ${CALLBACK_MESSAGE}, 450\\)`));
  assert.match(script('undock', 1n), /if \('undock' -eq 'dock'\)/);
});

// A stand-in for the BrowserWindow and for powershell.exe.
function fakes(out = '0,0,450,2160\n', code = 0) {
  const hooks = new Map();
  const win = {
    getNativeWindowHandle: () => { const b = Buffer.alloc(8); b.writeBigUInt64LE(42n); return b; },
    hookWindowMessage: (msg, fn) => hooks.set(msg, fn),
    isDestroyed: () => false,
  };
  const runs = [];
  const spawnFn = (exe, args) => {
    runs.push(Buffer.from(args.at(-1), 'base64').toString('utf16le'));
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    setImmediate(() => {
      c.stdout.emit('data', out);
      c.emit('exit', code);
    });
    return c;
  };
  return { win, hooks, runs, spawnFn };
}

test('docking turns the strip into DIPs; undocking gives it back once; Windows\' notice re-docks only while docked', async () => {
  const { win, hooks, runs, spawnFn } = fakes();
  let moved = 0;
  const bar = new AppBar({ win, spawnFn, platform: 'win32', toDip: (r) => ({ ...r, width: r.width / 1.5, height: r.height / 1.5 }), onMoved: () => { moved += 1; } });
  hooks.get(CALLBACK_MESSAGE)(1);
  assert.equal(moved, 0);                                  // not docked yet
  assert.deepEqual(await bar.dock(300, 1.5), { x: 0, y: 0, width: 300, height: 1440 });
  assert.match(runs[0], /Dock\(\$h, \d+, 450\)/);          // 300 DIPs at 150%
  assert.match(runs[0], /\[long\]'42'/);
  hooks.get(CALLBACK_MESSAGE)(1);                          // ABN_POSCHANGED
  hooks.get(CALLBACK_MESSAGE)(3);                          // another notice
  assert.equal(moved, 1);
  await bar.undock();
  await bar.undock();
  assert.equal(runs.length, 2);
  assert.match(runs[1], /if \('undock' -eq 'dock'\)/);
});

test('an app going full screen, and back, is passed on while docked', async () => {
  const { win, hooks, spawnFn } = fakes();
  const seen = [];
  const bar = new AppBar({ win, spawnFn, platform: 'win32', toDip: (r) => r, onFullscreen: (on) => seen.push(on) });
  const param = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  hooks.get(CALLBACK_MESSAGE)(param(2), param(1));
  await bar.dock(300);
  hooks.get(CALLBACK_MESSAGE)(param(2), param(1));          // ABN_FULLSCREENAPP, opening
  hooks.get(CALLBACK_MESSAGE)(param(2), param(0));          // and closing
  assert.deepEqual(seen, [true, false]);
});

test('a strip Windows would not give is no strip, and leaves nothing to give back', async () => {
  const { win, runs, spawnFn } = fakes('', 1);
  const logged = [];
  const bar = new AppBar({ win, spawnFn, platform: 'win32', toDip: (r) => r, log: (...a) => logged.push(a.join(' ')) });
  assert.equal(await bar.dock(300), null);
  assert.match(logged[0], /could not dock/);
  await bar.undock();
  assert.equal(runs.length, 1);
});