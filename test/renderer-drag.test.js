'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./renderer-fixture');

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
