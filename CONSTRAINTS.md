# Constraints

Hard constraints for Ttokttok Pet. Change them only with the owner's approval.

## Platform and runtime
- Windows 10/11 x64 only.
- Electron 44, plain JavaScript (CommonJS). No runtime npm dependencies: `dependencies`
  stays empty, and Win32 access goes through small PowerShell helpers, not native modules.
- `npm test` (`node --test`) passes on plain Node 22, where the release workflow runs it.

## Claude and Codex
- Read their files only (session index, transcripts, logs, Codex state and thread catalog).
  Never write to them or change their settings. The one exception is the opt-in Claude Code
  mod for live usage, installed only when the user turns it on.
- Open sessions only through the apps' own links: `claude://resume?session=<id>` and
  `codex://threads/<id>?hostId=<host>`.

## Network
- No server contact of its own, except SSH hosts from `~/.ssh/config` with key auth
  (read-only Python watchers) and SNU eTL once the user turns it on.

## Floating pet
- The pet's window never takes focus.

## Folder mode
- A second mode, chosen in the tray menu (or with `--mode=folder`): a sidebar docked to the
  left edge of the monitor as a Windows app bar, listing every Claude session and Codex thread
  as a host › folder tree. A session opened from a parent folder stays at that parent folder.
  The pet and the weekly limits sit at its bottom.
- Clicking a session opens it in the official app, which fills the rest of the screen:
  one conversation at a time.
- Out of scope: chatting in the sidebar, creating sessions, grouping by topic, sharing context
  between the two apps, mobile, embedding into the Claude app.

## Release
- A `v<version>` tag matches the version in `package.json`.
