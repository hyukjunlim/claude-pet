'use strict';

// Folder mode's window: a sidebar docked to the left edge of a monitor (see appbar.js), showing
// folder-tree.js's tree, with the pet and the weekly limits at the bottom. Unlike the pet's
// window it takes focus: you search in it, and a click in it lets Windows hand the front to the
// app that opens the session.

const path = require('node:path');
const { BrowserWindow, nativeTheme, screen } = require('electron');
const { AppBar } = require('./appbar');

const WIDTH = 300;
const REDOCK_QUIET_MS = 2000;   // Windows tells every bar about each change, ours included
const REDOCK_DELAY_MS = 600;

class FolderWindow {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.win = null;
    this.bar = null;
    this.strip = null;              // where the window sits while docked, in DIPs
    this.lastDock = 0;
    this.redockTimer = null;
  }

  get open() {
    return Boolean(this.win && !this.win.isDestroyed());
  }

  owns(webContents) {
    return this.open && webContents === this.win.webContents;
  }

  // Opens the sidebar on `display` (the pet's monitor), or shows it again.
  show(display) {
    if (this.open) {
      this.win.show();
      return;
    }
    const wa = display.workArea;
    const win = new BrowserWindow({
      x: wa.x,
      y: wa.y,
      width: WIDTH,
      height: wa.height,
      title: 'Claude Pet',
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#f8f7f4',
      webPreferences: {
        preload: path.join(__dirname, 'folder-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.win = win;
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') this.log(`folder page ${e.level}:`, e.message, `(${e.sourceId}:${e.lineNumber})`);
    });
    win.webContents.on('did-fail-load', (_e, code, description, url) => this.log('folder page failed to load:', code, description, url));
    win.webContents.on('render-process-gone', (_e, details) => {
      this.log('folder page exited:', details.reason);
      if (details.reason !== 'clean-exit' && this.win === win) win.webContents.reload();
    });
    this.bar = new AppBar({
      win,
      toDip: (rect) => screen.screenToDipRect(win, rect),
      onMoved: () => this.redockSoon(),
      log: this.log,
    });
    // Docked, the window belongs in its strip. Windows has been seen to move it out right after
    // docking (behind the maximized window next to it), so it's put back whenever it moves.
    win.on('move', () => {
      if (this.win !== win || !this.strip) return;
      const b = win.getBounds();
      if (Math.abs(b.x - this.strip.x) > 2 || Math.abs(b.y - this.strip.y) > 2) {
        this.log('folder: put back in its strip from', JSON.stringify(b));
        setImmediate(() => !win.isDestroyed() && win.setBounds(this.strip));
      }
    });
    win.once('ready-to-show', () => {
      win.show();
      this.dock();
    });
    win.loadURL('pet://app/ui/folder.html');
  }

  // Takes the strip and fills it, from the monitor's top to its bottom (above a bottom taskbar).
  async dock() {
    if (!this.open) return;
    const win = this.win;
    const display = screen.getDisplayMatching(win.getBounds());
    const wa = display.workArea;
    const rect = await this.bar.dock(WIDTH, display.scaleFactor);
    this.lastDock = Date.now();
    if (this.win !== win || win.isDestroyed()) return;
    this.strip = rect ? { x: rect.x, y: wa.y, width: rect.width, height: wa.height } : null;
    win.setBounds(this.strip ?? { x: wa.x, y: wa.y, width: WIDTH, height: wa.height });
    const b = win.getBounds();
    if (this.strip && Math.abs(b.x - this.strip.x) > 2) {
      this.log('folder: docked at', JSON.stringify(rect), 'but placed at', JSON.stringify(b), '- placing again');
      setTimeout(() => !win.isDestroyed() && this.strip && win.setBounds(this.strip), 300);
    }
  }

  // Windows moved the strip (another bar, the taskbar), or the monitor changed: dock again, once
  // things settle. The notices our own docking causes are let go.
  redockSoon(force = false) {
    if (!this.open || (!force && Date.now() - this.lastDock < REDOCK_QUIET_MS)) return;
    clearTimeout(this.redockTimer);
    this.redockTimer = setTimeout(() => this.dock(), REDOCK_DELAY_MS);
  }

  // The monitors changed. A change to the work area alone is most likely our own strip.
  onDisplayChanged(changedMetrics = null) {
    if (changedMetrics && !changedMetrics.some((m) => m === 'bounds' || m === 'scaleFactor')) return;
    this.redockSoon(true);
  }

  send(channel, data) {
    if (this.open) this.win.webContents.send(channel, data);
  }

  // Gives the strip back and closes the window.
  async close() {
    clearTimeout(this.redockTimer);
    const win = this.win;
    const bar = this.bar;
    this.win = null;
    this.bar = null;
    this.strip = null;
    if (!win) return;
    await bar?.undock();
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { FolderWindow, WIDTH };
