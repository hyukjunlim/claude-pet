'use strict';

// Sessions you marked as Ready in folder mode's sidebar (a row's right-click menu). One shows as
// Ready, as a finished turn does, until you mark it done or send it a message. `marked`: session
// id -> when you marked it.

// The marks left once the lists say when you last sent each session a message (`lastPromptAt`,
// on our clock). A session the lists don't have, like one on an SSH host that's offline, keeps its
// mark. Returns `marked` itself when nothing changed.
function settleMarks(marked, sessions) {
  let left = marked;
  for (const s of sessions) {
    if (!Object.hasOwn(left, s.id) || !(s.lastPromptAt > left[s.id])) continue;
    if (left === marked) left = { ...marked };
    delete left[s.id];
  }
  return left;
}

module.exports = { settleMarks };
