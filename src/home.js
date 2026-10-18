'use strict';

// Where the pet lives: the monitor it was put on, and its place on that monitor. A monitor can go
// away for a while (an LG UltraFine drops off whenever it sleeps) and come back, and the pet
// should come back with it rather than stay wherever the remaining monitor had room for it.

// The pet's place on its monitor, from the corner of the work area, so a taskbar that moves or
// a monitor whose scaling changes keeps the pet at the same spot.
function homeOf(pos, display) {
  return {
    display: display.id,
    label: display.label || '',
    x: pos.x - display.workArea.x,
    y: pos.y - display.workArea.y,
  };
}

function validHome(home) {
  return Boolean(home) && typeof home === 'object' && home.display != null
    && Number.isFinite(home.x) && Number.isFinite(home.y);
}

// The home monitor among the ones plugged in now: by id, else by name while only one monitor
// has that name (Windows can give a monitor a new id when it is plugged in again).
function homeDisplay(home, displays) {
  if (!validHome(home)) return null;
  const byId = displays.find((d) => d.id === home.display);
  if (byId) return byId;
  if (!home.label) return null;
  const named = displays.filter((d) => d.label === home.label);
  return named.length === 1 ? named[0] : null;
}

function homePosition(home, display) {
  return { x: display.workArea.x + home.x, y: display.workArea.y + home.y };
}

module.exports = { homeOf, homeDisplay, homePosition, validHome };
