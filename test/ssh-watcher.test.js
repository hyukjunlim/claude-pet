'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SshWatcher, steadySkew } = require('../src/ssh-watcher');

test('a clock estimate is kept until a new one is more than a second off', () => {
  assert.equal(steadySkew(undefined, 345_007), 345_007, 'the first one is taken as it is');
  assert.equal(steadySkew(345_000, 345_007), 345_000);
  assert.equal(steadySkew(345_000, 344_000), 345_000);
  assert.equal(steadySkew(345_000, 346_001), 346_001);
  assert.equal(steadySkew(345_000, 0), 0);
});

test('a host\'s clock holds through the few ms each line\'s trip adds, and moves when it really does', () => {
  let clock = 1_000_000;
  const w = new SshWatcher({ target: 'lab', script: '', label: 'Test', now: () => clock });
  let changes = 0;
  w.on('change', () => changes++);
  const tell = (aheadMs) => w.handle(JSON.stringify({ now: (clock + aheadMs) / 1000 }));
  tell(345_000);
  assert.equal(w.skew, 345_000);
  for (const d of [3, -4, 7, 900, -999]) {
    clock += 5000;
    tell(345_000 + d);
    assert.equal(w.skew, 345_000);
  }
  assert.equal(changes, 1);
  clock += 5000;
  tell(347_000);
  assert.equal(w.skew, 347_000);
  assert.equal(changes, 2);
});
