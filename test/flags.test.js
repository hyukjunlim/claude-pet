'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settleFlags } = require('../src/flags');

const T0 = Date.parse('2026-10-25T09:00:00Z');

test('a flag stays, opened or not, until you send that session a message', () => {
  const flags = { a: T0, b: T0, c: T0 };
  const left = settleFlags(flags, [
    { id: 'a', lastPromptAt: T0 + 60_000 },   // you wrote to it since: done
    { id: 'b', lastPromptAt: T0 - 60_000 },   // your message came before the flag
    { id: 'c', lastPromptAt: 0 },             // nothing known
    { id: 'd', lastPromptAt: T0 + 60_000 },   // never flagged
  ]);
  assert.deepEqual(left, { b: T0, c: T0 });
  assert.deepEqual(flags, { a: T0, b: T0, c: T0 }, 'the saved flags are left as they were');
});

test('a session the lists lack keeps its flag, and nothing to change gives the same flags back', () => {
  const flags = { offline: T0 };
  assert.equal(settleFlags(flags, []), flags);
  assert.equal(settleFlags(flags, [{ id: 'other', lastPromptAt: T0 + 1 }]), flags);
});
