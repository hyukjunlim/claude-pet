'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  petKey: 'built-in:clay',
  scale: 0.75,
  visible: true,
  position: null,          // top-left of the pet sprite, in screen DIPs
  showActivity: true,
  alwaysAnimate: true,     // animate even when Windows' Animation effects are off
  showUsage: true,         // the weekly-limit meter next to the pet
  claudeUsageOverSsh: true,  // read Claude's usage from the mod on the desktop app's SSH hosts
  claudeModOffered: false,   // the pet has asked once whether to set up its Claude Code mod
  claudeModWsl: {},          // distro -> whether the mod is set up there, as last seen
  showCodex: true,         // also show Codex threads, when Codex is installed
  codexOverSsh: true,      // and follow the ones running on Codex's SSH hosts
  etlEnabled: false,       // watch SNU eTL for deadlines and notices (needs a token)
  etlOnboardingOffered: false, // the pet has offered the optional eTL connection once
  etlWorkspace: null,      // the eTL chat folder; null: Documents\etl-assistant
  etlAssistantBubble: false, // keep an "eTL 비서" bubble that opens the eTL chat
  etlAssistantAsked: false,  // asked once, when the first token was saved
  shortcut: 'CommandOrControl+Alt+P',
  dismissed: {},
  seen: {},                // sessions you saw in the app with its window in front, and when
};

class Settings {
  constructor(file) {
    this.file = file;
    this.firstRun = !fs.existsSync(file);   // nothing saved yet: a new install
    this.data = { ...DEFAULTS };
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // first run or unreadable file: keep defaults
    }
    // Settings an older pet kept but this one doesn't use are dropped, and the file saved without them.
    let retired = false;
    for (const [key, value] of Object.entries(saved ?? {})) {
      if (Object.hasOwn(DEFAULTS, key)) this.data[key] = value;
      else retired = true;
    }
    this.timer = null;
    if (retired) {
      try {
        this.save();
      } catch {
        // saved again with the next change
      }
    }
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
