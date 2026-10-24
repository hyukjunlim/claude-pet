'use strict';

// Claude Pet's native messaging host for the browser extension (browser-extension/). Chrome or
// Edge starts it when the extension connects, through the launcher the pet writes when web chats
// are turned on (feature.js), and talks to it over stdin and stdout: each message is 4 bytes of
// length (little-endian), then that much UTF-8 JSON. The host passes the tabs' reports on to the
// running pet as JSON lines over a local named pipe, and the pet's requests to bring a tab forward
// back to the extension. It runs as plain Node (the pet's own exe, with ELECTRON_RUN_AS_NODE), uses
// only Node's built-in modules and exits when the browser closes its end.
//
// While the pet isn't running the host keeps each tab's newest report and tries the pipe again
// every few seconds, so a pet that starts later hears about every open chat at once.

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const MAX_FROM_BROWSER = 64 * 1024;   // a tab's report is a few hundred bytes
const MAX_FROM_PET = 64 * 1024;
const MAX_TABS = 500;
const RETRY_MS = 3000;

// The same as etl/bridge.js's: the pipe is named after the Windows user.
function userTag() {
  let name = '';
  try {
    name = os.userInfo().username;
  } catch {
    // no passwd entry (some containers): fall back to the environment
  }
  name = name || process.env.USERNAME || process.env.USER || 'user';
  return name.replace(/[^\p{L}\p{N}._-]/gu, '_');
}

function defaultPipePath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\claude-pet-webchats-${userTag()}`;
  return path.join(os.homedir(), '.claude-pet', 'webchats.sock');
}

function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Takes stdin's chunks as they come and calls onMessage with each whole message. A message over
// `max` bytes throws: the stream can't be trusted after that.
function frameReader(onMessage, { max = MAX_FROM_BROWSER } = {}) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > max) throw new Error(`a message of ${len} bytes is too big`);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(body.toString('utf8'));
      } catch {
        continue;
      }
      onMessage(msg);
    }
  };
}

// input/output: the browser's ends (stdin, stdout); connect(): a new connection to the pet. The
// hello carries this process's id: the browser that started it is up its parent chain (raise.js).
function createHost({
  input, output, connect = () => net.connect(defaultPipePath()), retryMs = RETRY_MS, onExit = () => {}, pid = process.pid,
}) {
  const tabs = new Map();          // tab id -> its newest report
  let pipe = null;
  let retry = null;
  let stopped = false;

  const toPet = (msg) => pipe?.write(`${JSON.stringify(msg)}\n`);

  function open() {
    retry = null;
    if (stopped) return;
    const sock = connect();
    let text = '';
    sock.setEncoding('utf8');
    sock.once('connect', () => {
      if (stopped) {
        sock.destroy();
        return;
      }
      pipe = sock;
      toPet({ type: 'hello', pid });
      for (const msg of tabs.values()) toPet(msg);
    });
    sock.on('data', (chunk) => {
      text += chunk;
      if (text.length > MAX_FROM_PET) {
        sock.destroy();
        return;
      }
      let nl;
      while ((nl = text.indexOf('\n')) !== -1) {
        const line = text.slice(0, nl);
        text = text.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.type === 'focus' && Number.isInteger(msg.tabId)) output.write(frame({ type: 'focus', tabId: msg.tabId }));
      }
    });
    sock.on('error', () => {});      // no pet yet, or it quit: 'close' follows
    sock.on('close', () => {
      if (pipe === sock) pipe = null;
      if (!stopped && !retry) retry = setTimeout(open, retryMs);
    });
  }

  const read = frameReader((msg) => {
    if (!Number.isInteger(msg?.tabId)) return;
    if (msg.type === 'chat') {
      if (!tabs.has(msg.tabId) && tabs.size >= MAX_TABS) return;
      tabs.set(msg.tabId, msg);
      toPet(msg);
    } else if (msg.type === 'closed') {
      tabs.delete(msg.tabId);
      toPet(msg);
    }
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(retry);
    pipe?.end();
    onExit();
  }

  input.on('data', (chunk) => {
    try {
      read(chunk);
    } catch {
      stop();
    }
  });
  input.on('end', stop);
  input.on('close', stop);
  open();
  return { stop, tabs };
}

if (require.main === module) {
  createHost({ input: process.stdin, output: process.stdout, onExit: () => setTimeout(() => process.exit(0), 100) });
}

module.exports = { createHost, defaultPipePath, frame, frameReader };
