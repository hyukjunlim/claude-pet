'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { probeWindow } = require('../src/window-probe');

function fixture(t) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; };
  const states = [];
  const errors = [];
  const stop = probeWindow({ getNativeWindowHandle: () => Buffer.alloc(8) }, {
    spawnFn: () => child, onState: (state) => states.push(state), onError: (error) => errors.push(error),
  });
  t.after(stop);
  return { child, states, errors, stop, killed: () => killed };
}

test('native snapshots survive split stdout chunks and Windows line endings', (t) => {
  const { child, states, errors } = fixture(t);
  child.stdout.write('{"state":{"topmost":');
  assert.equal(states.length, 0);
  child.stdout.write('false}}\r\n{"state":{"topmost":true}}\n');
  assert.deepEqual(states, [{ state: { topmost: false } }, { state: { topmost: true } }]);
  assert.deepEqual(errors, []);
});

test('malformed output and unexpected probe exit are reported rather than ignored', (t) => {
  const { child, states, errors } = fixture(t);
  child.stdout.write('invalid\n{"state":{"topmost":false}}\n');
  child.stderr.write('hook installation failed');
  child.emit('exit', 1);
  assert.equal(states.length, 1);
  assert.match(errors[0], /invalid native snapshot/);
  assert.match(errors[1], /exited \(1\).*hook installation failed/);
});

test('stopping the probe kills the helper and suppresses late output and exit errors', (t) => {
  const { child, states, errors, stop, killed } = fixture(t);
  stop();
  child.stdout.write('{"state":{"topmost":false}}\n');
  child.emit('exit', null);
  assert.equal(killed(), true);
  assert.deepEqual(states, []);
  assert.deepEqual(errors, []);
});
