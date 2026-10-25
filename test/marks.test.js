'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settleMarks } = require('../src/marks');

const T0 = Date.parse('2026-10-25T09:00:00Z');

test('a mark stays, opened or not, until you send that session a message', () => {
  const marked = { a: T0, b: T0, c: T0 };
  const left = settleMarks(marked, [
    { id: 'a', lastPromptAt: T0 + 60_000 },   // you wrote to it since: done
    { id: 'b', lastPromptAt: T0 - 60_000 },   // your message came before the mark
    { id: 'c', lastPromptAt: 0 },             // nothing known
    { id: 'd', lastPromptAt: T0 + 60_000 },   // never marked
  ]);
  assert.deepEqual(left, { b: T0, c: T0 });
  assert.deepEqual(marked, { a: T0, b: T0, c: T0 }, 'the saved marks are left as they were');
});

test('a session the lists lack keeps its mark, and nothing to change gives the same marks back', () => {
  const marked = { offline: T0 };
  assert.equal(settleMarks(marked, []), marked);
  assert.equal(settleMarks(marked, [{ id: 'other', lastPromptAt: T0 + 1 }]), marked);
});
