'use strict';

// claude.ai and ChatGPT chats in the pet, from the browser extension (browser-extension/), as
// bubbles like Claude's sessions (chats.js). Off by default; while it's off the pet registers
// nothing and listens on nothing.
//
// Turning it on:
//   - writes a native messaging host manifest and its launcher into the pet's folder in AppData
//     (webchats\), and points Chrome's and Edge's HKCU\Software\…\NativeMessagingHosts at it, which
//     needs no admin rights (other Chromium browsers, such as Aside, read Chrome's). Only the
//     extension with this key may start the host;
//   - listens on a local named pipe, \\.\pipe\claude-pet-webchats-<user>, which the hosts (host.js)
//     connect to. Nothing is reachable from the network, and the pet contacts no server.
// The extension is loaded by hand (Developer mode, then Load unpacked) from the folder that the
// menu's "Open the extension folder" shows. Turning web chats off removes the registration.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { defaultPipePath } = require('./host');
const { WebChats } = require('./chats');

const HOST_NAME = 'com.hyukjunlim.claude_pet';
const REGISTRY = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
};
const MAX_LINE = 64 * 1024;
const MAX_HOSTS = 16;          // one per browser profile with the extension

// The id Chrome and Edge give an extension whose manifest has this public key: the first 128 bits
// of the key's SHA-256, written with the letters a–p for 0–f.
function extensionId(publicKeyBase64) {
  const hex = crypto.createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
  return [...hex.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// A path for a batch file. cmd reads a batch file in the console's code page, so a user name
// outside it (a Korean one, say) would come out garbled; starting the path from %LOCALAPPDATA%,
// %APPDATA% or %USERPROFILE% keeps that part out of the file, and cmd fills it in itself.
function batchPath(p, env) {
  const win = path.win32;
  let best = null;
  for (const name of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE']) {
    const dir = env[name] && win.resolve(env[name]);
    if (!dir) continue;
    const inside = p.toLowerCase().startsWith(`${dir.toLowerCase()}\\`);
    if (inside && (!best || dir.length > best.dir.length)) best = { name, dir };
  }
  const rest = (best ? p.slice(best.dir.length) : p).replace(/%/g, '%%');
  return best ? `%${best.name}%${rest}` : rest;
}

function launcher({ exe, script, env }) {
  return [
    '@echo off',
    'set ELECTRON_RUN_AS_NODE=1',
    `"${batchPath(exe, env)}" "${batchPath(script, env)}" %*`,
    '',
  ].join('\r\n');
}

class WebChatsFeature extends EventEmitter {
  // electron: { dialog, shell }; exe: the program that runs host.js as Node (the pet's own exe).
  constructor({
    electron, settings, appRoot, userData, exe, log = () => {}, platform = process.platform, env = process.env,
    pipePath = defaultPipePath(), execFileFn = execFile, chats = new WebChats(),
  }) {
    super();
    Object.assign(this, { electron, settings, appRoot, exe, log, platform, env, pipePath, execFileFn, chats });
    this.hostDir = path.join(userData, 'webchats');
    this.server = null;
    this.sockets = new Map();        // source id -> its host's connection
    this.nextSource = 0;
    this.chats.on('change', (list) => this.emit('change', list));
    this.chats.on('list', (list) => this.emit('list', list));      // every chat, for folder mode
  }

  get enabled() {
    return this.settings.get('webChats') === true;
  }

  extensionDir() {
    return path.join(this.appRoot, 'browser-extension');
  }

  extensionId() {
    const manifest = JSON.parse(fs.readFileSync(path.join(this.extensionDir(), 'manifest.json'), 'utf8'));
    return extensionId(manifest.key);
  }

  // At launch: picks up where the last run left off.
  async start() {
    if (this.enabled) await this.#run();
  }

  stop() {
    const server = this.server;
    this.server = null;
    server?.close();
    for (const sock of this.sockets.values()) sock.destroy();
    this.sockets.clear();
    this.chats.clear();
  }

  async setEnabled(on) {
    this.settings.set({ webChats: on });
    if (!on) {
      this.stop();
      await this.unregister();
      return;
    }
    await this.#run();
    const { response } = await this.electron.dialog.showMessageBox({
      type: 'info',
      title: 'Claude Pet',
      message: 'Load the Claude Pet extension in Chrome or Edge',
      detail: 'Open the extensions page (chrome://extensions or edge://extensions), turn on Developer mode, '
        + 'choose "Load unpacked" and pick the folder the pet opens. A browser that already has it picks the pet '
        + 'up within half a minute.',
      buttons: ['Open the extension folder', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) this.openExtensionFolder();
  }

  openExtensionFolder() {
    this.electron.shell.openPath(this.extensionDir());
  }

  // Writes the host manifest and its launcher, and registers them with both browsers.
  async register() {
    if (this.platform !== 'win32') return;
    fs.mkdirSync(this.hostDir, { recursive: true });
    const cmd = path.join(this.hostDir, 'host.cmd');
    const manifest = path.join(this.hostDir, 'host.json');
    const script = path.join(this.appRoot, 'src', 'webchats', 'host.js');
    fs.writeFileSync(cmd, launcher({ exe: this.exe, script, env: this.env }));
    fs.writeFileSync(manifest, `${JSON.stringify({
      name: HOST_NAME,
      description: 'Claude Pet web chats',
      path: cmd,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${this.extensionId()}/`],
    }, null, 2)}\n`);
    for (const key of Object.values(REGISTRY)) await this.#reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f']);
  }

  async unregister() {
    if (this.platform !== 'win32') return;
    for (const key of Object.values(REGISTRY)) {
      await this.#reg(['delete', key, '/f']).catch(() => {});   // already gone
    }
  }

  dismiss(id) {
    this.chats.dismiss(id);
  }

  // The chats keep their own "seen", not in settings.dismissed.
  dismissedSnapshot() {
    return {};
  }

  target(id) {
    return this.chats.target(id);
  }

  // Asks the extension to bring the conversation's tab and window forward; false if no tab shows it.
  focus(id) {
    const tab = this.chats.target(id)?.tab;
    const sock = tab && this.sockets.get(tab.source);
    if (!sock) return false;
    sock.write(`${JSON.stringify({ type: 'focus', tabId: tab.tabId })}\n`);
    return true;
  }

  // The tray menu's Sources → "Web chats" submenu.
  menu() {
    const on = this.enabled;
    const items = [
      {
        label: 'Show claude.ai, ChatGPT and Gemini chats',
        type: 'checkbox',
        checked: on,
        click: (mi) => this.setEnabled(mi.checked).catch((err) => this.log('web chats:', err.message)),
      },
      { label: 'Open the extension folder', click: () => this.openExtensionFolder() },
    ];
    if (on) {
      const n = this.chats.connected();
      const status = n === 0 ? 'Waiting for the extension' : `Extension connected${n > 1 ? ` in ${n} browsers` : ''}`;
      items.push({ type: 'separator' }, { label: status, enabled: false });
    }
    return { label: 'Web chats', submenu: items };
  }

  async #run() {
    try {
      await this.register();
    } catch (err) {
      this.log('web chats register:', err.message);
    }
    this.#listen();
  }

  #listen() {
    if (this.server) return;
    const server = net.createServer((sock) => this.#serve(sock));
    server.on('error', (err) => {
      this.log('web chats pipe:', err.message);
      if (this.server === server) this.server = null;
    });
    server.listen(this.pipePath);
    this.server = server;
  }

  // One host: a hello line with its process id, then the tabs' reports.
  #serve(sock) {
    sock.on('error', () => {});      // a host that went away; 'close' follows
    if (this.sockets.size >= MAX_HOSTS) {
      sock.destroy();
      return;
    }
    const source = `h${++this.nextSource}`;
    this.sockets.set(source, sock);
    let text = '';
    let hello = false;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      text += chunk;
      if (text.length > MAX_LINE) {
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
        if (msg?.type === 'hello' && !hello) {
          hello = true;
          this.chats.addSource(source, { hostPid: msg.pid });
        } else if (hello && msg?.type === 'chat') this.chats.report(source, msg);
        else if (hello && msg?.type === 'closed') this.chats.closed(source, msg.tabId);
      }
    });
    sock.on('close', () => {
      this.sockets.delete(source);
      this.chats.removeSource(source);
    });
  }

  #reg(args) {
    return new Promise((resolve, reject) => {
      this.execFileFn('reg.exe', args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
  }
}

module.exports = { HOST_NAME, REGISTRY, WebChatsFeature, batchPath, extensionId, launcher };
