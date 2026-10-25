'use strict';

// An older install of the pet kept its things under the name PREVIOUS. The first time this one
// starts, they come over (main.js): the %APPDATA% folder (moveFolder), Start at login, and the
// web chats host's registration; ~/.<PREVIOUS> and the Claude Code mod in it move with the mod
// (claude-mod.js), on each machine it's set up on. Every name below comes from PREVIOUS.

const fs = require('node:fs');
const path = require('node:path');

const PREVIOUS = 'claude-pet';

const previous = {
  dir: PREVIOUS,                                                         // %APPDATA%\<dir>
  homeDir: `.${PREVIOUS}`,                                               // ~/.<homeDir>
  loginItem: PREVIOUS.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(''),   // its Run value
  hostName: `com.hyukjunlim.${PREVIOUS.replace(/-/g, '_')}`,             // its web chats host
};

const MARKER = 'moved.txt';   // left in `from` once it's copied: the rest there is leftovers

// Moves a folder that may be in use. It's renamed when it can be, all at once; otherwise it's
// copied, and the original emptied as far as it can be. What something still holds (a browser's
// web chats host keeps its folder while the browser runs) goes on a later call. What happened,
// for the log; null when there was nothing to do.
function moveFolder(from, to, { tries = 3, waitMs = 300 } = {}) {
  if (fs.existsSync(to)) {
    return fs.existsSync(path.join(from, MARKER)) && clearLeftovers(from) ? `removed what was left of ${from}` : null;
  }
  if (!fs.existsSync(from)) return null;
  for (let i = 1; i <= tries; i++) {
    try {
      fs.renameSync(from, to);
      return `moved ${from} to ${to}`;
    } catch {
      if (i < tries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);   // a file in it may be about to close
    }
  }
  const copy = `${to}.moving`;   // only renamed into place once whole
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(from, copy, { recursive: true });
  fs.renameSync(copy, to);
  fs.writeFileSync(path.join(from, MARKER), `Copied to ${to}. What's left here was still in use, and goes later.\n`);
  return clearLeftovers(from) ? `copied ${from} to ${to}` : `copied ${from} to ${to}; what was still in use goes later`;
}

// Empties `dir` but for MARKER, and takes it away once nothing else is left. Whether it's gone.
function clearLeftovers(dir) {
  let left = false;
  for (const name of fs.readdirSync(dir)) {
    if (name === MARKER) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      left = true;
    }
  }
  if (left) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { PREVIOUS, moveFolder, previous };
