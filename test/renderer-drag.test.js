'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function fixture() {
  const filename = path.join(__dirname, '../src/renderer/pet.js');
  const calls = [];
  const callbacks = {};
  function element() {
    const listeners = new Map();
    const classes = new Set();
    const captured = new Set();
    return {
      style: { setProperty() {} },
      setAttribute() {},
      classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s), contains: (s) => classes.has(s) },
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      dispatch(type, e) { for (const fn of listeners.get(type) || []) fn(e); },
      getBoundingClientRect: () => ({ left: 88, top: 284, width: 144, height: 156 }),
      setPointerCapture(id) { captured.add(id); },
      hasPointerCapture(id) { return captured.has(id); },
      releasePointerCapture(id) { captured.delete(id); this.dispatch('lostpointercapture', { pointerId: id, clientX: 100, clientY: 300 }); },
    };
  }
  const nodes = Object.fromEntries(['stage', 'pet', 'sprite', 'tray', 'badge'].map((id) => [id, element()]));
  const api = {};
  for (const event of ['Pet', 'Motion', 'Layout', 'Sessions', 'Usage', 'Wake', 'Landed', 'Pointer']) {
    api[`on${event}`] = (fn) => { callbacks[event] = fn; };
  }
  for (const method of ['ready', 'setInteractive', 'dragStart', 'dragMove', 'dragEnd', 'activate', 'dismiss', 'traySize', 'contextMenu']) {
    api[method] = (...args) => calls.push([method, ...args]);
  }
  class SpritePlayer {
    constructor() { this.transient = null; }
    hitTest() { return true; }
    hold(state) { this.transient = state; }
    release() { this.transient = null; calls.push(['release']); }
    playOnce() {}
  }
  const context = {
    window: { pet: api, SpritePlayer, addEventListener() {} },
    document: { getElementById: (id) => nodes[id], createElement: element, documentElement: element(), elementFromPoint: () => nodes.sprite },
    setInterval() {},
    matchMedia: () => ({ addEventListener() {} }),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const event = (extra = {}) => ({ pointerId: 1, button: 0, buttons: 1, screenX: 100, screenY: 300, clientX: 100, clientY: 300, timeStamp: 10, preventDefault() {}, ...extra });
  return { calls, callbacks, pet: nodes.pet, event };
}


function startMoving(f) {
  f.pet.dispatch('pointerdown', f.event());
  f.pet.dispatch('pointermove', f.event({ screenX: 120, timeStamp: 40 }));
}

function ends(f) {
  return f.calls.filter((call) => call[0] === 'dragEnd');
}

test('losing capture cancels the drag and allows a fresh drag', () => {
  const f = fixture();
  startMoving(f);
  f.pet.releasePointerCapture(1);
  assert.equal(f.pet.classList.contains('dragging'), false);
  assert.deepEqual(ends(f), [['dragEnd', 0, 0]]);
  f.callbacks.Landed();
  assert.equal(f.calls.filter((call) => call[0] === 'release').length, 1);
  assert.equal(f.calls.some((call) => call[0] === 'activate'), false);
  f.pet.dispatch('pointerdown', f.event({ pointerId: 2 }));
  f.pet.dispatch('pointermove', f.event({ pointerId: 2, screenX: 130, timeStamp: 80 }));
  assert.equal(f.pet.classList.contains('dragging'), true);
  assert.deepEqual(f.calls.at(-1), ['dragMove', 130, 300]);
});

test('a move with the left button released cancels a missing pointerup', () => {
  const f = fixture();
  startMoving(f);
  f.pet.dispatch('pointermove', f.event({ screenX: 130, buttons: 0, timeStamp: 60 }));
  assert.equal(f.pet.classList.contains('dragging'), false);
  assert.deepEqual(ends(f), [['dragEnd', 0, 0]]);
  assert.equal(f.calls.filter((call) => call[0] === 'dragMove').length, 1);
  f.pet.dispatch('pointerup', f.event({ buttons: 0 }));
  assert.equal(ends(f).length, 1);
});

test('normal release still throws and releases capture only once', () => {
  const f = fixture();
  startMoving(f);
  f.pet.dispatch('pointerup', f.event({ buttons: 0, timeStamp: 60 }));
  assert.equal(f.pet.classList.contains('dragging'), false);
  assert.equal(ends(f).length, 1);
  assert.ok(ends(f)[0][1] > 450);
  assert.equal(f.pet.hasPointerCapture(1), false);
  f.callbacks.Landed();
  assert.equal(f.calls.filter((call) => call[0] === 'release').length, 1);
});

test('an unrelated pointer losing capture does not cancel the active drag', () => {
  const f = fixture();
  startMoving(f);
  f.pet.dispatch('lostpointercapture', f.event({ pointerId: 2 }));
  assert.equal(f.pet.classList.contains('dragging'), true);
  assert.equal(ends(f).length, 0);
});

test('capture lost before any movement cancels without opening an app', () => {
  const f = fixture();
  f.pet.dispatch('pointerdown', f.event());
  f.pet.releasePointerCapture(1);
  assert.equal(f.pet.classList.contains('dragging'), false);
  assert.deepEqual(ends(f), [['dragEnd', 0, 0]]);
  assert.equal(f.calls.some((call) => call[0] === 'activate'), false);
});

test('a normal click still activates once, despite capture release', () => {
  const f = fixture();
  f.pet.dispatch('pointerdown', f.event());
  f.pet.dispatch('pointerup', f.event({ buttons: 0, timeStamp: 40 }));
  assert.equal(ends(f).length, 1);
  assert.deepEqual(f.calls.filter((call) => call[0] === 'activate'), [['activate', null]]);
});
