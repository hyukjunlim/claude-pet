'use strict';

// One SSH connection to a host, running a small read-only Python watcher there that sends its
// news back one JSON object per line. Subclasses give the watcher and read its messages; this keeps
// the connection up, waiting longer between retries the more often it fails, and measures the
// host's clock from the {"now": <host time, s>} line every watcher sends every few seconds.
//
// The connection uses your ~/.ssh/config, so `ssh <host>` must work without a prompt, and the host
// needs python3.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

// The watcher arrives as the first line on stdin, and stdin then stays open: each watcher reads it
// to the end and exits when it closes, which is when the pet quits, or dies.
const LOADER = 'import sys, json; exec(json.loads(sys.stdin.readline()))';
const BOOTSTRAP = `exec python3 -u -c '${LOADER}'`;
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-T'];
const RETRY_MS = [5000, 30_000, 2 * 60_000, 10 * 60_000];
const STEADY_MS = 60_000;   // a connection that lasted this long resets the retry delay

// JSON with only ASCII in it, which reaches Python intact whatever the host's locale.
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// The arguments to run `command` on a host, `target` being what you'd pass to ssh (a ~/.ssh/config
// alias or a host name).
function sshArgs({ target, port = null, identity = null }, command) {
  const args = [...SSH_OPTIONS];
  if (port) args.push('-p', String(port));
  if (identity) args.push('-i', identity);
  args.push(target, command);
  return args;
}

class SshWatcher extends EventEmitter {
  // script: the Python watcher; label: what it watches, for error messages ("Codex on lab-server: …")
  constructor({ target, port = null, identity = null, script, label, spawnFn = spawn, now = Date.now }) {
    super();
    Object.assign(this, { target, port, identity, script, label, spawnFn, now });
    this.skew = 0;              // how far the host's clock is ahead of ours, ms
    this.child = null;
    this.stopped = true;
    this.attempt = 0;
    this.retryTimer = null;
    this.lastError = '';
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.onDisconnect();
  }

  connect() {
    let child;
    try {
      child = this.spawnFn('ssh', sshArgs(this, BOOTSTRAP), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.onExit(null, err.message);
      return;
    }
    this.child = child;
    const startedAt = this.now();
    let buffer = '';
    const stderr = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        this.handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s) => {
      stderr.push(...String(s).split(/\r?\n/).filter(Boolean));
      stderr.splice(0, Math.max(0, stderr.length - 3));
    });
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      if (this.now() - startedAt >= STEADY_MS) this.attempt = 0;
      this.onExit(child, stderr.join(' ') || reason);
    };
    child.on('error', (err) => finish(err.message));
    child.on('exit', (code) => finish(`exited with ${code}`));
    child.stdin.on('error', () => {});
    child.stdin.write(`${asciiJson(this.script)}\n`);   // and no end(): see LOADER
  }

  onExit(child, reason) {
    if (child && child !== this.child) return;   // an old connection we already replaced or stopped
    this.child = null;
    this.onDisconnect();
    if (this.stopped) return;
    const message = `${this.label} on ${this.target}: ${reason}`;
    if (message !== this.lastError) this.emit('error', new Error(message));
    this.lastError = message;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  handle(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof m?.now === 'number') {
      this.lastError = '';
      const skew = Math.round(m.now * 1000 - this.now());
      const moved = Math.abs(skew - this.skew) > 1000;
      this.skew = skew;
      if (moved) this.emit('change');
    } else if (m && typeof m === 'object') {
      this.onMessage(m);
    }
  }

  // For subclasses: a message from the watcher other than the clock.
  onMessage() {}

  // For subclasses: the connection ended, or was stopped.
  onDisconnect() {}
}

module.exports = { BOOTSTRAP, LOADER, SshWatcher, asciiJson, sshArgs };
