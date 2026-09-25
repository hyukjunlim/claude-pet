'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  petKey: 'built-in:clay',
  scale: 0.75,
  visible: true,
  position: null,          // top-left of the pet sprite, in screen DIPs
  showActivity: true,
  showUsage: true,         // the weekly-limit meter next to the pet
  claudeWeeklyResetAt: null,   // one of the times Claude's weekly limit resets (ms); it's the same every week
  showCodex: true,         // also show Codex threads, when Codex is installed
  codexOverSsh: true,      // and follow the ones running on Codex's SSH hosts
  shortcut: 'CommandOrControl+Alt+P',
  dismissed: {},
};

class Settings {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // first run or unreadable file: keep defaults
    }
    this.timer = null;
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 400);
  }

  save() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS };
