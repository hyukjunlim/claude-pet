'use strict';

// Tells whether the Claude app's window is the one in front (Windows only). A small PowerShell
// helper hooks the system's "foreground window changed" event, so it doesn't poll, and once the
// events have stopped for a moment prints the name of the process that owns the window then in
// front. It asks Windows which window that is rather than trusting the events' own: Windows 11's
// Alt+Tab switcher (explorer) reports itself once more just after the chosen window came to the
// front. The pet runs it only while it needs to know, and the helper exits by itself if the pet
// goes away.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class PetFront {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr hwnd, IntPtr id, uint ms, IntPtr proc);
  [DllImport("user32.dll")] static extern bool KillTimer(IntPtr hwnd, IntPtr id);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  const uint SETTLE_MS = 150;   // quiet this long after the last event before looking
  static WinEventProc keep;
  static IntPtr timer = IntPtr.Zero;
  static string last;
  static void Report(IntPtr hwnd) {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    string name = "";
    try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
    if (name == last) return;
    last = name;
    Console.Out.WriteLine(name);
    Console.Out.Flush();
  }
  public static void Run(int parent) {
    Thread watch = new Thread(() => {
      for (;;) {
        Thread.Sleep(5000);
        try { if (Process.GetProcessById(parent).HasExited) Environment.Exit(0); } catch { Environment.Exit(0); }
      }
    });
    watch.IsBackground = true;
    watch.Start();
    // Each event (re)starts the timer; passing the running timer's id resets it.
    keep = (hook, ev, hwnd, obj, child, thread, time) => { timer = SetTimer(IntPtr.Zero, timer, SETTLE_MS, IntPtr.Zero); };
    SetWinEventHook(3, 3, IntPtr.Zero, keep, 0, 0, 0);   // EVENT_SYSTEM_FOREGROUND, delivered here
    Report(GetForegroundWindow());
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
      if (msg.message != 0x0113 || msg.wParam != timer) continue;   // WM_TIMER
      KillTimer(IntPtr.Zero, timer);
      timer = IntPtr.Zero;
      Report(GetForegroundWindow());
    }
  }
}
'@
[PetFront]::Run(PARENT_PID)
`;

// Emits 'front' (true when Claude's window is in front, false otherwise) whenever that changes,
// 'name' (the process that owns the front window, as Windows names it) whenever that does, and
// 'exit' when the helper stops.
class ForegroundWatcher extends EventEmitter {
  constructor({ app = 'claude', spawnFn = spawn } = {}) {
    super();
    this.app = app.toLowerCase();
    this.spawnFn = spawnFn;
    this.child = null;
    this.inFront = null;
  }

  start() {
    if (this.child) return;
    const script = HELPER.replace('PARENT_PID', String(process.pid));
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    const child = this.spawnFn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const name = buffer.slice(0, nl).trim();
        const inFront = name.toLowerCase() === this.app;
        buffer = buffer.slice(nl + 1);
        this.emit('name', name);
        if (inFront !== this.inFront) {
          this.inFront = inFront;
          this.emit('front', inFront);
        }
      }
    });
    const done = () => {
      if (this.child !== child) return;
      this.child = null;
      this.inFront = null;
      this.emit('exit');
    };
    child.on('exit', done);
    child.on('error', done);
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.inFront = null;
    child?.kill();
  }
}

module.exports = { ForegroundWatcher, HELPER };
