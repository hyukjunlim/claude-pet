'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settleHidden } = require('../src/hidden');

const T0 = Date.parse('2026-10-25T09:00:00Z');

test('a hidden session stays hidden until something new happens in it', () => {
  const hidden = { quiet: T0, wrote: T0, busy: T0, old: T0 };
  const left = settleHidden(hidden, [
    { id: 'quiet', status: 'idle', since: T0 - 60_000, lastPromptAt: T0 - 60_000 },
    { id: 'wrote', status: 'idle', since: T0 - 60_000, lastPromptAt: T0 + 60_000 },     // you sent it a message
    { id: 'busy', status: 'waiting', since: T0 + 60_000, lastPromptAt: 0 },             // it asks you something
    { id: 'old', status: 'review', since: T0 - 60_000, lastPromptAt: 0 },               // finished before you hid it
  ]);
  assert.deepEqual(left, { quiet: T0, old: T0 });
  assert.deepEqual(Object.keys(hidden), ['quiet', 'wrote', 'busy', 'old'], 'the saved list is left as it was');
});

test('a session the lists lack stays hidden, and nothing to change gives the same list back', () => {
  const hidden = { offline: T0 };
  assert.equal(settleHidden(hidden, []), hidden);
  assert.equal(settleHidden(hidden, [{ id: 'other', status: 'running', since: T0 + 1, lastPromptAt: T0 + 1 }]), hidden);
});
