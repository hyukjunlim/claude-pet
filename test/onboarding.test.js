'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GettingStarted, PRACTICE_PET, PRACTICE_ROWS } = require('../src/onboarding');

function gettingStarted() {
  const g = { changed: 0 };
  g.it = new GettingStarted({ state: () => ({}), actions: {}, changed: () => g.changed++ });
  return g;
}

test("the floating pet's practice: a bubble that goes once it's marked done, four things to try", () => {
  const g = gettingStarted();
  const { it } = g;
  const counter = () => g.changed;
  assert.deepEqual(it.petItems(), [], 'no practice, no bubble');
  it.setPractice('pet');
  const [bubble] = it.petItems();
  assert.equal(bubble.id, PRACTICE_PET);
  assert.equal(bubble.kind, 'practice');
  assert.equal(it.folderHost(), null, "the sidebar's practice is another mode's");
  assert.ok(it.isPractice(bubble.id));
  assert.equal(it.isPractice('local_123'), false);

  it.tried('click');
  it.tried('rowMenu');   // the sidebar's, not asked for here
  it.visibilityChanged(true);   // shown without being hidden first
  assert.deepEqual(it.practice.tried, new Set(['click']));
  it.visibilityChanged(false);
  it.visibilityChanged(true);
  it.tried('dismiss');
  it.remove(bubble.id);
  it.tried('menu');
  assert.deepEqual(it.petItems(), []);
  assert.deepEqual(it.practice.tried, new Set(['click', 'hide', 'dismiss', 'menu']));
  assert.ok(counter() >= 2, 'the pet draws again when the practice starts and when the bubble goes');
});

test("the sidebar's practice: two sessions on top, and Ctrl+Tab counts once both ways were pressed", () => {
  const { it } = gettingStarted();
  it.setPractice('folder');
  const host = it.folderHost();
  assert.equal(host.key, 'practice');
  assert.equal(host.kind, 'chat', 'drawn as the web chats are: the sessions right under the heading');
  assert.deepEqual(host.loose.map((s) => s.id), PRACTICE_ROWS);
  assert.deepEqual(it.folderHost(), host, 'the same each time, so the tree is not sent again for nothing');

  it.tried('step', 1);
  it.tried('step', 1);
  assert.equal(it.practice.tried.has('step'), false);
  it.tried('step', -1);
  assert.equal(it.practice.tried.has('step'), true);

  it.remove(PRACTICE_ROWS[0]);
  assert.deepEqual(it.folderHost().loose.map((s) => s.id), [PRACTICE_ROWS[1]]);
  it.remove(PRACTICE_ROWS[1]);
  assert.equal(it.folderHost(), null, 'with both gone, so is the heading');

  it.setPractice(null);
  it.tried('click');
  assert.equal(it.practice, null);
});

test('starting the practice again starts it from nothing tried', () => {
  const { it } = gettingStarted();
  it.setPractice('pet');
  it.tried('click');
  it.remove(PRACTICE_PET);
  it.setPractice('pet');
  assert.equal(it.practice.tried.size, 0);
  assert.equal(it.petItems().length, 1);
});
