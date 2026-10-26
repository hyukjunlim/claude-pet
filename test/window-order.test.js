'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { watchWindowOrder } = require('../src/window-order');

function fixture(t) {
  const win = new EventEmitter();
  const moves = [], logs = [];
  let receive, probeStopped = false;
  Object.assign(win, {
    visible: true, minimized: false, destroyed: false, topmost: true,
    isVisible: () => win.visible, isMinimized: () => win.minimized,
    isDestroyed: () => win.destroyed, isAlwaysOnTop: () => win.topmost,
    setAlwaysOnTop(...args) { moves.push(['setAlwaysOnTop', ...args]); win.topmost = args[0]; },
    moveTop() { moves.push(['moveTop']); },
  });
  const watcher = watchWindowOrder(win, {
    platform: 'win32', log: (...args) => logs.push(args),
    probe(_win, options) {
      receive = options.onState;
      return () => { probeStopped = true; };
    },
  });
  // The native topmost flag can remain set while an ordinary window covers the pet.
  const state = {
    orderComplete: true, topmost: true, visible: true, minimized: false, cloaked: false,
    overlappingAbove: [{ windowClass: 'Chrome_WidgetWin_1', topmost: false }],
  };
  t.after(watcher.stop);
  return { win, moves, logs, state, watcher, receive: (overrides = {}) => receive({ state: { ...state, ...overrides } }), probeStopped: () => probeStopped };
}

test('corrects the captured ordering failure even when isAlwaysOnTop remains true', (t) => {
  const { receive, moves, logs } = fixture(t);
  receive();
  assert.deepEqual(moves, [['moveTop']]);
  assert.equal(logs.some(([event]) => event === 'window order correction:'), true);
  receive({ overlappingAbove: [] });
  assert.equal(logs.some(([event]) => event === 'window order verified:'), true);
  assert.equal(moves.length, 1, 'healthy events must not reassert window order');
});

test('a topmost overlay or the desktop does not trigger a window-order contest', (t) => {
  const { receive, moves } = fixture(t);
  receive({ overlappingAbove: [{ topmost: true, windowClass: '#32768' }] });
  receive({ overlappingAbove: [{ topmost: false, windowClass: 'WorkerW' }] });
  assert.deepEqual(moves, []);
});

test('ignores incomplete or hidden snapshots and hiding after a snapshot was taken', (t) => {
  const { receive, win, moves } = fixture(t);
  receive({ orderComplete: false });
  receive({ visible: false });
  receive({ cloaked: true });
  receive({ minimized: true });
  win.visible = false;
  receive();
  win.visible = true;
  win.minimized = true;
  receive();
  assert.deepEqual(moves, []);
});

test('restores the native topmost flag as well if it was actually removed', (t) => {
  const { receive, win, moves } = fixture(t);
  win.topmost = false;
  receive({ topmost: false, overlappingAbove: [] });
  assert.deepEqual(moves, [['setAlwaysOnTop', true, 'pop-up-menu'], ['moveTop']]);
});

test('closing the pet stops the monitor and rejects late snapshots', (t) => {
  const { receive, win, moves, probeStopped } = fixture(t);
  win.emit('closed');
  receive();
  assert.equal(probeStopped(), true);
  assert.deepEqual(moves, []);
});
