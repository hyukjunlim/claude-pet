# Local change map

These IDs group this checkout's custom changes. Search an ID in code comments or use the file list here when reviewing a diff or reapplying changes after a manual update. They are local labels, not GitHub issue numbers.

| ID | Issue and reason | Changed areas |
| --- | --- | --- |
| `PET-TENNIS` | Add an animated tennis ball as a selectable pet. | `pets/tennis/`, `tools/make_tennis.py`, `tools/tennis-preview.png`, `package.json`, pet section of `README.md` |
| `PET-SIZE` | Offer larger presets and Ctrl+wheel resizing. | `src/main.js`, `src/preload.js`, `src/renderer/pet.js`, run section of `README.md` |
| `PET-DRAG` | Reduce missed drags caused by the transparent window's delayed pointer handoff. | `src/main.js` (`POINTER_POLL_MS`, `watchPointer`) |
| `PET-USAGE` | Keep Claude and Codex visible together when Claude's usage sample is unavailable. | `src/main.js`, `src/renderer/pet.js`, `src/renderer/pet.css`, `src/renderer/index.html`, usage section of `README.md` |
| `PET-INPUT` | Keep a blocking question or approval in the activity stack as `Awaiting input`. Opening its thread must not count as an answer; a nonblocking async question leaves the turn `Running`. | `src/main.js`, `src/renderer/pet.js`, `src/rollout.js`, `src/transcript.js`, `src/sessions.js`, related tests |
| `PET-UPDATE` | Explain manual updates for a locally customized checkout. | install and updating sections of `README.md` |
| `PET-LOCAL` | Ignore the portable Node runtime used on this PC. | `.gitignore` |
