'use strict';

// Sessions you hid from folder mode's sidebar (a row's right-click menu). Only the sidebar leaves
// them out: Claude and Codex keep them, and so do the pet's bubbles. `hidden`: session id -> when
// you hid it.

// The hidden sessions left once the lists say what's new. One you've since sent a message, or
// that has started something since (a turn, a question, a reply), shows again. A session the lists
// don't have, like one on an SSH host that's offline, stays hidden. Returns `hidden` itself when
// nothing changed.
function settleHidden(hidden, sessions) {
  let left = hidden;
  for (const s of sessions) {
    if (!Object.hasOwn(left, s.id)) continue;
    const at = left[s.id];
    if (!(s.lastPromptAt > at) && !(s.status !== 'idle' && s.since > at)) continue;
    if (left === hidden) left = { ...hidden };
    delete left[s.id];
  }
  return left;
}

module.exports = { settleHidden };
