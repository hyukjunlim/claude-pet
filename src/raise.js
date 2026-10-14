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

let child = null;

// Starts the helper (one at a time; a newer link replaces an older wait). Windows only.
function raiseCodexWindow({ spawnFn = spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  child?.kill();
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(HELPER, 'utf16le').toString('base64')];
  const c = spawnFn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
  child = c;
  const done = () => { if (child === c) child = null; };
  c.on('exit', done);
  c.on('error', done);
  return c;
}

module.exports = { HELPER, raiseCodexWindow };
