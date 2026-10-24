'use strict';

// Folder mode's follow-up flags. A chat you flag stays flagged, opened or not, until you send it
// your next message (or click its flag again). `flags`: session id -> when you flagged it.

// The flags left once the lists say when you last sent each session a message
// (`lastPromptAt`, on our clock). A session the lists don't have, like one on an SSH host that's
// offline, keeps its flag. Returns `flags` itself when nothing changed.
function settleFlags(flags, sessions) {
  let left = flags;
  for (const s of sessions) {
    if (!Object.hasOwn(left, s.id) || !(s.lastPromptAt > left[s.id])) continue;
    if (left === flags) left = { ...flags };
    delete left[s.id];
  }
  return left;
}

module.exports = { settleFlags };
