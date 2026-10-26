'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { displayChoices, placeOn, widthTo } = require('../src/folder-mode');

const WORK = { x: 2560, y: 0, width: 1920, height: 1040 };   // a second monitor, right of the main one

test('the sidebar sits against the edge it docks on, and keeps its outer side as its width changes', () => {
  assert.deepEqual(placeOn(WORK, 400, 'left'), { x: 2560, y: 0, width: 400, height: 1040 });
  assert.deepEqual(placeOn(WORK, 400, 'right'), { x: 4080, y: 0, width: 400, height: 1040 });
  assert.deepEqual(placeOn(WORK, 400, 'anywhere'), placeOn(WORK, 400, 'left'));
  const strip = placeOn(WORK, 400, 'right');
  assert.deepEqual(placeOn(strip, 500, 'right'), { x: 3980, y: 0, width: 500, height: 1040 }, 'wider: the left side moves');
  assert.deepEqual(placeOn(placeOn(WORK, 400, 'left'), 500, 'left'), { x: 2560, y: 0, width: 500, height: 1040 });
});

test('the width follows the inner edge to the cursor, within the limits', () => {
  const left = placeOn(WORK, 400, 'left');
  const right = placeOn(WORK, 400, 'right');
  assert.equal(widthTo(left, 2560 + 450, 'left'), 450);
  assert.equal(widthTo(right, 4480 - 450, 'right'), 450);
  assert.equal(widthTo(right, 4470, 'right'), 180, 'never narrower than the least');
  assert.equal(widthTo(left, 2560 + 5000, 'left'), 800, 'nor wider than the most');
});

test('the monitors are named for where they sit, with their size and the main one', () => {
  const main = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 };
  const second = { id: 7, bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  const third = { id: 3, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  assert.deepEqual(displayChoices([main], 1), [{ id: 1, label: 'This monitor · 3840×2160 (main)' }]);
  assert.deepEqual(displayChoices([second, main], 1).map((d) => d.label), [
    'Left monitor · 3840×2160 (main)',
    'Right monitor · 1920×1080',
  ]);
  assert.deepEqual(displayChoices([main, second, third], 1).map((d) => d.id), [3, 1, 7], 'left to right');
  assert.equal(displayChoices([main, second, third], 1)[1].label, 'Middle monitor · 3840×2160 (main)');
  const four = [main, second, third, { id: 9, bounds: { x: 4480, y: 0, width: 800, height: 600 }, scaleFactor: 1 }];
  assert.equal(displayChoices(four, 1)[3].label, 'Monitor 4 · 800×600');
});
