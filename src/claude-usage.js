'use strict';

// Gathers Claude's plan usage from everywhere Ttokttok Pet's mod (claude-mod/) saves it, for the
// weekly-limit meter (usage.js reads the file, and combineClaudeUsage picks the newest):
//   - 'local': ~/.ttokttok-pet/usage.json, which the mod writes after each reply of a Claude Code
//     session on this PC or in WSL.
//   - 'ssh:<host>:<port>': the same file on each SSH host the desktop app works on, sent by a
//     ClaudeRemote watcher, which also says whether the mod is set up there.
//   - 'ssh-config:<name>': the same, for each host from ~/.ssh/config you picked in the tray menu
//     (for Claude Code run over SSH from a terminal; see ssh-config.js).
//
// Emits 'change' with the list of readings when one changes, 'hosts' when what's known about
// the SSH hosts changes, and 'chats' with the hosts' VS Code and terminal sessions (chats()).

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

// A host from ~/.ssh/config, by its name there: ssh takes the rest from the config.
function configHost(alias) {
  return { key: `ssh-config:${alias}`, name: alias, target: alias, port: null, identity: null, fromConfig: true };
}

// The machineKey a host's sessions have: a host the desktop app connects to goes by the key its
// sessions have (ssh:<host>:<port>); one from ~/.ssh/config, by its name there.
function machineKeyOf(key, remote) {
  return key.startsWith('ssh-config:') ? `ssh:${remote.target}:${remote.port ?? 22}` : key;
}

class ClaudeUsage extends EventEmitter {
  // configHosts: the names of the hosts from ~/.ssh/config to read too
  constructor({
    usageFile, sshConnections = null, configHosts = [], watchHosts = true, remoteFactory = (o) => new ClaudeRemote(o), pollMs = POLL_MS,
  }) {
    super();
    Object.assign(this, { usageFile, sshConnections, watchHosts, remoteFactory, pollMs });
    this.readings = new Map();   // source -> { weekly, fiveHour, at } on our clock
    this.desktopHosts = [];      // the desktop app's saved connections
    this.configHosts = configHosts.map(configHost);
    this.hosts = [...this.configHosts];
    this.remotes = new Map();    // host key -> ClaudeRemote
    this.stamps = { usage: null, hosts: null };
    this.timer = null;
    this.running = false;
    this.busy = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.syncRemotes();
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

  // The hosts from ~/.ssh/config to read, by their names there.
  setConfigHosts(aliases) {
    this.configHosts = aliases.map(configHost);
    this.mergeHosts();
  }

  // [{ key, name, target, port, identity, fromConfig?, mod }]: each SSH host, the desktop app's
  // first, with { version, enabled } once its watcher has said whether the mod is set up there.
  hostStates() {
    return this.hosts.map((h) => ({ ...h, mod: this.remotes.get(h.key)?.mod ?? null }));
  }

  // The SSH hosts' VS Code and terminal sessions, for SessionTracker.setRemoteChats.
  chats() {
    const out = [];
    for (const [key, remote] of this.remotes) {
      const machineKey = machineKeyOf(key, remote);
      const add = (id, state, quiet) => out.push({
        id: `cli:${id}`, sessionId: id, state, quiet, machineKey, machine: remote.name, remote: remote.name, skew: remote.skew,
      });
      for (const [id, state] of remote.chats ?? []) add(id, state, false);
      for (const [id, state] of remote.peeks ?? []) if (!remote.chats?.has(id)) add(id, state, true);
    }
    return out;
  }

  // The SSH host behind a session's machineKey (as chats() gives it), for the sidebar's Delete:
  // { target, port, identity, name }, or null.
  hostFor(machineKey) {
    for (const [key, remote] of this.remotes) {
      if (machineKeyOf(key, remote) === machineKey) return { target: remote.target, port: remote.port, identity: remote.identity, name: remote.name };
    }
    return null;
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
    this.desktopHosts = hosts;
    this.mergeHosts();
  }

  mergeHosts() {
    this.hosts = [...this.desktopHosts, ...this.configHosts];
    this.syncRemotes();
    this.emit('hosts');
  }

  // One watcher per SSH host, while this runs and hosts are watched.
  syncRemotes() {
    const wanted = new Map(this.running && this.watchHosts ? this.hosts.map((h) => [h.key, h]) : []);
    let dropped = false;
    for (const [key, remote] of this.remotes) {
      const h = wanted.get(key);
      if (h && h.target === remote.target && h.port === remote.port && h.identity === remote.identity) continue;
      remote.stop();
      this.remotes.delete(key);
      this.set(key, null);
      dropped ||= remote.chats?.size > 0 || remote.peeks?.size > 0;
    }
    if (dropped) this.emit('chats', this.chats());
    for (const [key, h] of wanted) {
      if (this.remotes.has(key)) continue;
      const remote = this.remoteFactory({ key, name: h.name, target: h.target, port: h.port, identity: h.identity });
      remote.on('change', () => {
        const u = remote.usage;
        this.set(key, u && { ...u, at: u.at - remote.skew });   // to our clock
      });
      remote.on('mod', () => this.emit('hosts'));
      remote.on('chats', () => this.emit('chats', this.chats()));
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

module.exports = { ClaudeUsage, configHost, parseSshHosts };
