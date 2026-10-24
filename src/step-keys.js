'use strict';

// Ctrl+Tab and Ctrl+Shift+Tab step through folder mode's sidebar, Claude's sessions and Codex's
// threads alike, while Claude, Codex or the sidebar itself is the app in front. Both apps use
// these keys for their own lists; the sidebar's list has both, so it takes them over there. Any
// other app keeps them (a browser's tabs): the keys are registered only while one of these is in
// front, which a small helper reports (see foreground.js).

const { ForegroundWatcher } = require('./foreground');

const KEYS = { 'Control+Tab': 1, 'Control+Shift+Tab': -1 };
const RETRY_MS = 30_000;   // after the helper stopped on its own, start it again this much later

class StepKeys {
  // `apps`: the process names (any case) the keys are taken in. `onStep(direction)`: +1 or -1.
  // `globalShortcut`: Electron's.
  constructor({ apps, onStep, globalShortcut, watcherFactory = () => new ForegroundWatcher(), log = () => {} }) {
    this.apps = new Set(apps.map((a) => a.toLowerCase()));
    this.onStep = onStep;
    this.globalShortcut = globalShortcut;
    this.watcherFactory = watcherFactory;
    this.log = log;
    this.watcher = null;
    this.active = false;
    this.retryTimer = null;
  }

  start() {
    if (this.watcher) return;
    clearTimeout(this.retryTimer);
    const w = this.watcherFactory();
    this.watcher = w;
    w.on('name', (name) => {
      if (this.watcher === w) this.setActive(this.apps.has(String(name).toLowerCase()));
    });
    w.on('exit', () => {
      if (this.watcher !== w) return;   // we stopped it
      this.watcher = null;
      this.setActive(false);
      this.retryTimer = setTimeout(() => this.start(), RETRY_MS);
    });
    w.start();
  }

  stop() {
    clearTimeout(this.retryTimer);
    const w = this.watcher;
    this.watcher = null;
    w?.stop();
    this.setActive(false);
  }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    for (const [key, direction] of Object.entries(KEYS)) {
      if (!on) {
        this.globalShortcut.unregister(key);
        continue;
      }
      let ok = false;
      try {
        ok = this.globalShortcut.register(key, () => this.onStep(direction));
      } catch (err) {
        this.log(`step keys: ${key}:`, err.message);
      }
      if (!ok) this.log(`step keys: ${key} is taken by another app`);
    }
  }
}

module.exports = { StepKeys, KEYS };
