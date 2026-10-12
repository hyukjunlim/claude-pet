'use strict';

// Gathers Claude's plan usage from everywhere Claude Pet's mod (claude-mod/) saves it, for the
// weekly-limit meter (usage.js reads the file, and combineClaudeUsage picks the newest):
//   - 'local': ~/.claude-pet/usage.json, which the mod writes after each reply of a Claude Code
//     session on this PC or in WSL.
//   - 'ssh:<host>:<port>': the same file on each SSH host the desktop app works on, sent by a
//     ClaudeRemote watcher, which also says whether the mod is set up there.
//
// Emits 'change' with the list of readings when one changes, and 'hosts' when what's known about
// the SSH hosts changes.

const fs = require('node:fs');
const fsp = fs.promises;
const { EventEmitter } = require('node:events');
const { ClaudeRemote } = require('./claude-remote');
const { parseModUsage } = require('./usage');

const POLL_MS = 3000;

// The desktop app's saved SSH connections: { configs: [{ name, sshHost, sshPort, sshIdentityFile }] }
function parseSshHosts(j) {
  const hosts = [];
  for (const c of Array.isArray(j?.configs) ? j.configs : []) {
    if (typeof c?.sshHost !== 'string' || !c.sshHost) continue;
    const port = Number(c.sshPort) || null;
    hosts.push({
      key: `ssh:${c.sshHost}:${port ?? 22}`,
      name: (typeof c.name === 'string' && c.name.trim()) || c.sshHost.replace(/^.*@/, ''),
      target: c.sshHost,
      port,
      identity: typeof c.sshIdentityFile === 'string' && c.sshIdentityFile ? c.sshIdentityFile : null,
    });
  }
  return hosts;
}

class ClaudeUsage extends EventEmitter {
  constructor({
    usageFile, sshConnections = null, watchHosts = true, remoteFactory = (o) => new ClaudeRemote(o), pollMs = POLL_MS,
  }) {
    super();
    Object.assign(this, { usageFile, sshConnections, watchHosts, remoteFactory, pollMs });
    this.readings = new Map();   // source -> { weekly, fiveHour, at } on our clock
    this.hosts = [];
    this.remotes = new Map();    // host key -> ClaudeRemote
    this.stamps = { usage: null, hosts: null };
    this.timer = null;
    this.running = false;
    this.busy = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    this.syncRemotes();
  }

  setWatchHosts(on) {
    this.watchHosts = on;
    this.syncRemotes();
    if (!on) for (const h of this.hosts) this.set(h.key, null);
  }

  list() {
    return [...this.readings.values()];
  }

  // [{ key, name, target, port, identity, mod }]: each SSH host, with { version, enabled } once its
  // watcher has said whether the mod is set up there.
  hostStates() {
    return this.hosts.map((h) => ({ ...h, mod: this.remotes.get(h.key)?.mod ?? null }));
  }

  set(source, reading) {
    const old = this.readings.get(source) ?? null;
    if (JSON.stringify(old) === JSON.stringify(reading ?? null)) return;
    if (reading) this.readings.set(source, reading);
    else this.readings.delete(source);
    this.emit('change', this.list());
  }

  async poll() {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      await this.loadLocal();
      await this.loadHosts();
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.busy = false;
    }
  }

  async loadLocal() {
    const stamp = await stampOf(this.usageFile);
    if (stamp === this.stamps.usage) return;
    let reading = null;
    if (stamp) {
      try {
        reading = parseModUsage(JSON.parse(await fsp.readFile(this.usageFile, 'utf8')));
      } catch {
        return;   // being written; read it again next time
      }
    }
    this.stamps.usage = stamp;
    this.set('local', reading);
  }

  async loadHosts() {
    if (!this.sshConnections) return;
    const stamp = await stampOf(this.sshConnections);
    if (stamp === this.stamps.hosts) return;
    let hosts = [];
    if (stamp) {
      try {
        hosts = parseSshHosts(JSON.parse(await fsp.readFile(this.sshConnections, 'utf8')));
      } catch {
        return;   // being written
      }
    }
    this.stamps.hosts = stamp;
    this.hosts = hosts;
    this.syncRemotes();
    this.emit('hosts');
  }

  // One watcher per SSH host, while this runs and hosts are watched.
  syncRemotes() {
    const wanted = new Map(this.running && this.watchHosts ? this.hosts.map((h) => [h.key, h]) : []);
    for (const [key, remote] of this.remotes) {
      const h = wanted.get(key);
      if (h && h.target === remote.target && h.port === remote.port && h.identity === remote.identity) continue;
      remote.stop();
      this.remotes.delete(key);
      this.set(key, null);
    }
    for (const [key, h] of wanted) {
      if (this.remotes.has(key)) continue;
      const remote = this.remoteFactory({ key, name: h.name, target: h.target, port: h.port, identity: h.identity });
      remote.on('change', () => {
        const u = remote.usage;
        this.set(key, u && { ...u, at: u.at - remote.skew });   // to our clock
      });
      remote.on('mod', () => this.emit('hosts'));
      remote.on('error', (err) => this.emit('error', err));
      this.remotes.set(key, remote);
      remote.start();
    }
  }
}

async function stampOf(file) {
  try {
    const st = await fsp.stat(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

module.exports = { ClaudeUsage, parseSshHosts };
