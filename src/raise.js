'use strict';

// Brings the Codex app's window to the front after the pet hands it a codex:// link (Windows).
// With its window closed, Codex lives on in the tray: a link makes it open the window again, but
// Windows keeps that window behind the one in front, so a click on the pet seemed to do nothing.
// A small PowerShell helper waits up to 5 seconds for the window and raises it. (A tap of Alt
// first is what lets a background process set the front window.)

const { spawn } = require('node:child_process');

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetRaise {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static bool Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);              // SW_RESTORE
    keybd_event(0x12, 0, 0, UIntPtr.Zero);          // Alt down
    keybd_event(0x12, 0, 2, UIntPtr.Zero);          // Alt up
    return SetForegroundWindow(h);
  }
}
'@
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
  $w = Get-Process ChatGPT -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*OpenAI.Codex*' } | Select-Object -First 1
  if ($w) { [void][PetRaise]::Raise($w.MainWindowHandle); exit 0 }
  Start-Sleep -Milliseconds 150
}
exit 1
`;

// The same for a web chat's browser window, once the extension has brought the chat's tab forward
// in it. The browser is whichever one started the extension's native host (Chrome, Edge, Aside or
// another Chromium browser): up the host's parent chain, past the cmd.exe that ran its launcher.
// Its window is the one whose title starts with the tab's ("<tab> - Google Chrome"), or, for a
// site installed as an app, ends with it after the app's name ("ChatGPT - <tab>"). The title comes
// from a web page, so it reaches the script base64-encoded, as data, never as code.
const BROWSER_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PetRaiseBrowser {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static IntPtr Find(uint browser, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != browser) return true;
      var s = new StringBuilder(1024);
      GetWindowText(h, s, s.Capacity);
      if (!Shows(s.ToString(), title)) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
  // A browser window: "<tab> - <browser>". An app window: "<app> - <tab>", or just "<tab>".
  public static bool Shows(string window, string tab) {
    return window.StartsWith(tab, StringComparison.Ordinal) || window.EndsWith(" - " + tab, StringComparison.Ordinal);
  }
  public static bool Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);              // SW_RESTORE
    keybd_event(0x12, 0, 0, UIntPtr.Zero);          // Alt down
    keybd_event(0x12, 0, 2, UIntPtr.Zero);          // Alt up
    return SetForegroundWindow(h);
  }
}
'@
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PET_RAISE_TITLE))
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$env:PET_RAISE_HOST_PID)"
$browser = $null
for ($i = 0; $p -and $i -lt 4; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
  if ($p -and $p.Name -notmatch '^(cmd|conhost)\.exe$') { $browser = [uint32]$p.ProcessId; break }
}
if (-not $browser) { exit 1 }
$deadline = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $deadline) {
  $h = [PetRaiseBrowser]::Find($browser, $title)
  if ($h -ne [IntPtr]::Zero) { [void][PetRaiseBrowser]::Raise($h); exit 0 }
  Start-Sleep -Milliseconds 150
}
exit 1
`;
let child = null;

function runHelper(script, spawnFn, env) {
  child?.kill();
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const c = spawnFn('powershell.exe', args, { windowsHide: true, stdio: 'ignore', ...(env && { env }) });
  child = c;
  const done = () => { if (child === c) child = null; };
  c.on('exit', done);
  c.on('error', done);
  return c;
}

// Starts the helper (one at a time; a newer link replaces an older wait). Windows only.
function raiseCodexWindow({ spawnFn = spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  return runHelper(HELPER, spawnFn);
}

function raiseBrowserWindow({ hostPid, title, spawnFn = spawn, platform = process.platform, env = process.env }) {
  if (platform !== 'win32' || !Number.isSafeInteger(hostPid) || hostPid <= 0 || !title) return null;
  return runHelper(BROWSER_HELPER, spawnFn, {
    ...env,
    PET_RAISE_HOST_PID: String(hostPid),
    PET_RAISE_TITLE: Buffer.from(title, 'utf8').toString('base64'),
  });
}

module.exports = { BROWSER_HELPER, HELPER, raiseBrowserWindow, raiseCodexWindow };
