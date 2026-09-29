'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ForegroundWatcher } = require('../src/foreground');

test('the front-window helper reports which app is in front, and stops', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const w = new ForegroundWatcher({ app: 'no-such-app' });
  const first = new Promise((resolve) => w.once('front', resolve));
  w.start();
  try {
    const inFront = await Promise.race([first, new Promise((r) => setTimeout(() => r('timeout'), 15_000))]);
    assert.equal(inFront, false);   // whatever is in front, it isn't "no-such-app"
  } finally {
    w.stop();
  }
  assert.equal(w.child, null);
});

test('the helper reports only changes, as true/false for the app', () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => {};
  const w = new ForegroundWatcher({ app: 'Claude', spawnFn: () => child });
  const seen = [];
  w.on('front', (v) => seen.push(v));
  w.start();
  child.stdout.write('explorer\r\nClaude\r\n');
  child.stdout.write('claude\nCode\n');
  return new Promise((resolve) => setImmediate(() => {
    assert.deepEqual(seen, [false, true, false]);
    w.stop();
    resolve();
  }));
});
