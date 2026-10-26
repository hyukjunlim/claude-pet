'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHost, frame, frameReader } = require('../src/webchats/host');

test('native messages are read whole however the bytes arrive, and an oversized one stops the reader', () => {
  const got = [];
  const read = frameReader((m) => got.push(m), { max: 100 });
  const bytes = Buffer.concat([frame({ a: 1 }), frame({ b: '한글' }), Buffer.from([2, 0, 0, 0]), Buffer.from('{]')]);
  for (const b of bytes) read(Buffer.from([b]));              // one byte at a time
  assert.deepEqual(got, [{ a: 1 }, { b: '한글' }]);             // the broken one is skipped
  read(Buffer.concat([frame({ c: 3 }), frame({ d: 4 })]));      // two in one chunk
  assert.deepEqual(got.slice(2), [{ c: 3 }, { d: 4 }]);
  assert.throws(() => read(Buffer.from([0xff, 0xff, 0, 0])), /too big/);
});

// A stand-in for the connection to the pet: records lines, can be told to connect or close.
function fakePipe() {
  const pipes = [];
  const connect = () => {
    const sock = new EventEmitter();
    sock.lines = [];
    sock.setEncoding = () => {};
    sock.write = (text) => sock.lines.push(...text.trim().split('\n').map((l) => JSON.parse(l)));
    sock.end = () => sock.emit('close');
    sock.destroy = () => sock.emit('close');
    pipes.push(sock);
    return sock;
  };
  return { pipes, connect };
}

function framesOut(output) {
  const got = [];
  output.on('data', frameReader((m) => got.push(m)));
  return got;
}

const chat = (tabId, patch = {}) => ({ type: 'chat', tabId, site: 'claude', url: 'https://claude.ai/new', generating: true, ...patch });

test('the host keeps what the tabs said while the pet is away, and tells it all on connecting', async () => {
  const { pipes, connect } = fakePipe();
  const input = new PassThrough();
  const host = createHost({ input, output: new PassThrough(), connect, retryMs: 5, pid: 4321 });
  input.write(frame(chat(1)));
  input.write(frame(chat(2)));
  input.write(frame({ type: 'closed', tabId: 2 }));
  await new Promise((r) => setImmediate(r));
  pipes[0].emit('close');                                      // no pet yet
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pipes.length, 2);                               // tried again
  pipes[1].emit('connect');
  assert.deepEqual(pipes[1].lines, [{ type: 'hello', pid: 4321 }, chat(1)]);
  input.write(frame(chat(1, { generating: false })));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pipes[1].lines.at(-1), chat(1, { generating: false }));
  host.stop();
});

test("the pet's request to bring a tab forward goes to the browser, and the host ends with the browser", async () => {
  const { pipes, connect } = fakePipe();
  const input = new PassThrough();
  const output = new PassThrough();
  const got = framesOut(output);
  let exited = 0;
  createHost({ input, output, connect, onExit: () => { exited += 1; } });
  pipes[0].emit('connect');
  pipes[0].emit('data', `${JSON.stringify({ type: 'focus', tabId: 9 })}\n{"type":"focus","tabId":"x"}\nnot json\n`);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, [{ type: 'focus', tabId: 9 }]);
  input.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(exited, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pipes.length, 1);                               // no retry after the browser left
});

test('reports without a tab id, and other kinds of message, stay with the host', async () => {
  const { pipes, connect } = fakePipe();
  const input = new PassThrough();
  const host = createHost({ input, output: new PassThrough(), connect, pid: 7 });
  pipes[0].emit('connect');
  input.write(frame({ type: 'chat', site: 'claude' }));
  input.write(frame({ type: 'focus', tabId: 3 }));
  input.write(frame(chat(4)));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pipes[0].lines, [{ type: 'hello', pid: 7 }, chat(4)]);
  host.stop();
});
