# Local change map

These IDs group this checkout's custom changes. Search an ID in code comments or use the file list here when reviewing a diff or reapplying changes after a manual update. They are local labels, not GitHub issue numbers.

| ID | Issue and reason | Changed areas |
| --- | --- | --- |
| `PET-TENNIS` | Add an animated tennis ball as a selectable pet. | `pets/tennis/`, `tools/make_tennis.py`, `tools/tennis-preview.png`, `package.json`, pet section of `README.md` |
| `PET-SIZE` | Offer larger presets and Ctrl+wheel resizing. | `src/main.js`, `src/preload.js`, `src/renderer/pet.js`, run section of `README.md` |
| `PET-DRAG` | Keep Windows mouse input on the pet and visible status cards so a quick drag cannot beat the transparent window's hover handoff. Reapply the input region after window/display changes and when the cursor returns, accept the pet box as a drag handle, keep tracking moves if pointer capture fails, and log drag starts/ends for diagnosis. End a gesture if pointer capture is lost or a new press arrives before its release. Polling remains the fallback on other platforms. | `src/main.js`, `src/preload.js`, `src/renderer/pet.js` |
| `PET-FREEZE` | Replace a pet page that stops painting while its Electron process remains alive. Log renderer readiness and usage changes so stale display and stale source data can be distinguished. | `src/main.js`, `src/preload.js`, `src/renderer/pet.js` |
| `PET-LOG` | Keep writing the app log when a GUI launch inherits a closed stdout pipe. Limit console output to an attached terminal so clicking or dragging cannot raise `EPIPE`. | `src/main.js` |
| `PET-USAGE` | Keep Claude and Codex visible together when Claude's usage sample is unavailable. | `src/main.js`, `src/renderer/pet.js`, `src/renderer/pet.css`, `src/renderer/index.html`, usage section of `README.md` |
| `PET-INPUT` | Keep a blocking question or approval in the activity stack as `Awaiting input`. Opening its thread must not count as an answer; a nonblocking async question leaves the turn `Running`. | `src/main.js`, `src/renderer/pet.js`, `src/rollout.js`, `src/transcript.js`, `src/sessions.js`, related tests |
| `PET-UPDATE` | Explain manual updates for a locally customized checkout. | install and updating sections of `README.md` |
| `PET-LOCAL` | Ignore the portable Node runtime used on this PC. | `.gitignore` |
