'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { StepKeys } = require('../src/step-keys');

function fakes() {
  const registered = new Map();
  const globalShortcut = {
    register: (key, fn) => { registered.set(key, fn); return true; },
    unregister: (key) => registered.delete(key),
  };
  const watchers = [];
  const watcherFactory = () => {
    const w = new EventEmitter();
    w.started = false;
    w.start = () => { w.started = true; };
    w.stop = () => { w.started = false; };
    watchers.push(w);
    return w;
  };
  return { registered, globalShortcut, watchers, watcherFactory };
}

test('the keys are taken only while Claude, Codex or the sidebar is in front', () => {
  const { registered, globalShortcut, watchers, watcherFactory } = fakes();
  const steps = [];
  const keys = new StepKeys({ apps: ['claude', 'ChatGPT', 'electron'], onStep: (d) => steps.push(d), globalShortcut, watcherFactory });
  keys.start();
  const [w] = watchers;
  assert.equal(w.started, true);
  w.emit('name', 'chrome');
  assert.equal(registered.size, 0);                     // a browser keeps its tabs' keys
  w.emit('name', 'Claude');
  assert.deepEqual([...registered.keys()], ['Control+Tab', 'Control+Shift+Tab']);
  registered.get('Control+Tab')();
  registered.get('Control+Shift+Tab')();
  assert.deepEqual(steps, [1, -1]);
  w.emit('name', 'chatgpt');                            // Codex: still taken, not taken twice
  assert.equal(registered.size, 2);
  w.emit('name', 'WindowsTerminal');
  assert.equal(registered.size, 0);
  w.emit('name', 'electron');                           // the sidebar itself
  assert.equal(registered.size, 2);
  keys.stop();
  assert.equal(registered.size, 0);
  assert.equal(w.started, false);
});

test('when the helper stops on its own the keys are given back, and it starts again later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { registered, globalShortcut, watchers, watcherFactory } = fakes();
  const keys = new StepKeys({ apps: ['claude'], onStep: () => {}, globalShortcut, watcherFactory });
  keys.start();
  watchers[0].emit('name', 'claude');
  assert.equal(registered.size, 2);
  watchers[0].emit('exit');
  assert.equal(registered.size, 0);
  t.mock.timers.tick(30_000);
  assert.equal(watchers.length, 2);
  assert.equal(watchers[1].started, true);
  keys.stop();
});
