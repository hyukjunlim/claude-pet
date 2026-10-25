# Constraints

Hard constraints for Ttokttok Pet. Change them only with the owner's approval.

## Platform and runtime
- Windows 10/11 x64 only.
- Electron 44, plain JavaScript (CommonJS). No runtime npm dependencies: `dependencies`
  stays empty, and Win32 access goes through small PowerShell helpers, not native modules.
- `npm test` (`node --test`) passes on plain Node 22, where the release workflow runs it.

## Claude and Codex
- Read their files only (session index, transcripts, logs, Codex state and thread catalog).
  Never write to them or change their settings. Two exceptions: the opt-in Claude Code mod for
  live usage, installed only when the user turns it on, and the sidebar's Delete for a chat run
  in VS Code or a terminal, only after the user confirms it. A Claude Code session's transcript
  and its folder are deleted (to the Recycle Bin on this PC); a Codex chat is archived through
  Codex's own app-server (`thread/archive`), never by editing its files.
- Open sessions only through the apps' own links: `claude://resume?session=<id>`,
  `codex://threads/<id>?hostId=<host>`, and the VS Code extensions' links:
  Claude Code's `vscode://anthropic.claude-code/open?session=<id>` and Codex's
  `vscode://openai.chatgpt/local/<id>`, sent once the VS Code window for that session's machine
  is in front. With no such window, VS Code's own `vscode://vscode-remote/<wsl+distro or
  ssh-remote+host><folder>` (or `vscode://file/<folder>` on this PC) opens the folder there first.

## Network
- No server contact of its own, except SSH hosts from `~/.ssh/config` with key auth and SNU eTL
  once the user turns it on. On SSH hosts the pet runs read-only Python watchers, plus one
  command per Delete the user confirms in the sidebar (remove that Claude Code session's files,
  or archive that Codex chat through Codex's app-server).

## Floating pet
- The pet's window never takes focus.

## Folder mode
- A second mode, chosen in the tray menu (or with `--mode=folder`): a sidebar docked to the
  left or right edge of a monitor, both chosen in the tray menu, as a Windows app bar, listing
  every Claude session and Codex thread as a host › folder tree. A session opened from a
  parent folder stays at that parent folder.
  The pet and the weekly limits sit at its bottom.
- Clicking a session opens it in the official app, which fills the rest of the screen:
  one conversation at a time.
- Out of scope: chatting in the sidebar, creating sessions, grouping by topic, sharing context
  between the two apps, mobile, embedding into the Claude app.

## Release
- A `v<version>` tag matches the version in `package.json`.
