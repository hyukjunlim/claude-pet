'use strict';

// Docks folder mode's window to the left edge of its monitor as a Windows "app bar", the way the
// taskbar is docked: Windows takes that strip out of the monitor's work area, so maximized
// windows (Claude's, Codex's) fill the rest instead of going under the sidebar. Registering is
// one call to the shell for the window's handle, which a small PowerShell helper makes (the pet
// has no native modules). Windows then sends the window a message when the strip has to move
// (another bar, the taskbar, a display change), and the main process docks it again.

const { spawn } = require('node:child_process');

const CALLBACK_MESSAGE = 0x8000 + 0x50;   // WM_APP + 0x50: Windows' notices about the bar
const ABN_POSCHANGED = 1;
const ABN_FULLSCREENAPP = 2;

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetAppBar {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA {
    public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam;
  }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint msg, ref APPBARDATA data);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  static APPBARDATA Data(IntPtr h, uint cb) {
    APPBARDATA d = new APPBARDATA();
    d.cbSize = Marshal.SizeOf(d);
    d.hWnd = h;
    d.uCallbackMessage = cb;
    return d;
  }
  // Physical pixels, like the shell's own: this process would otherwise get scaled coordinates.
  static void Aware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }
  public static string Dock(IntPtr h, uint cb, int width) {
    Aware();
    APPBARDATA d = Data(h, cb);
    SHAppBarMessage(0, ref d);                       // ABM_NEW (already registered: no harm)
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(mi);
    GetMonitorInfo(MonitorFromWindow(h, 2), ref mi); // MONITOR_DEFAULTTONEAREST
    d.uEdge = 0;                                     // ABE_LEFT
    d.rc = mi.rcMonitor;
    d.rc.right = d.rc.left + width;
    SHAppBarMessage(2, ref d);                       // ABM_QUERYPOS: the shell moves it past other bars
    d.rc.right = d.rc.left + width;
    SHAppBarMessage(3, ref d);                       // ABM_SETPOS
    return d.rc.left + "," + d.rc.top + "," + d.rc.right + "," + d.rc.bottom;
  }
  public static void Undock(IntPtr h) {
    APPBARDATA d = Data(h, 0);
    SHAppBarMessage(1, ref d);                       // ABM_REMOVE
  }
}
'@
$h = [IntPtr]::new([long]'HWND')
if ('ACTION' -eq 'dock') { [Console]::Out.WriteLine([PetAppBar]::Dock($h, CALLBACK, WIDTH)) }
else { [PetAppBar]::Undock($h) }
`;

// A message's WPARAM or LPARAM, which Electron hands over as a Buffer.
function numberOf(param) {
  if (!Buffer.isBuffer(param)) return Number(param) || 0;
  return param.length >= 8 ? Number(param.readBigUInt64LE(0)) : param.readUInt32LE(0);
}

// The window handle Electron gives as a Buffer, as a number.
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function script(action, hwnd, width = 0) {
  return HELPER.replace("'HWND'", `'${hwnd}'`).replace("'ACTION'", `'${action}'`)
    .replace('CALLBACK', String(CALLBACK_MESSAGE)).replace('WIDTH', String(Math.max(1, Math.round(width))));
}

function runHelper(text, spawnFn) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')];
    let out = '';
    let err = '';
    let c;
    try {
      c = spawnFn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, out: '', error: e.message });
      return;
    }
    c.stdout?.on('data', (d) => { out += d; });
    c.stderr?.on('data', (d) => { err += d; });
    c.on('error', (e) => resolve({ ok: false, out, error: e.message }));
    c.on('exit', (code) => resolve({ ok: code === 0, out, error: err.trim() || (code ? `exit code ${code}` : '') }));
  });
}

// "left,top,right,bottom" in physical pixels, or null.
function parseRect(text) {
  const m = /^\s*(-?\d+),(-?\d+),(-?\d+),(-?\d+)\s*$/m.exec(String(text));
  if (!m) return null;
  const [left, top, right, bottom] = m.slice(1).map(Number);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

class AppBar {
  // `win`: the BrowserWindow. `toDip(rect)`: physical pixels to the window's DIPs (Electron's
  // screen.screenToDipRect on Windows). `onMoved()`: Windows moved the strip; dock again.
  // `onFullscreen(on)`: an app went full screen on the bar's monitor (on) or stopped being so.
  constructor({ win, toDip, onMoved = () => {}, onFullscreen = () => {}, spawnFn = spawn, platform = process.platform, log = () => {} }) {
    this.win = win;
    this.hwnd = platform === 'win32' ? hwndOf(win) : 0n;   // kept: the bar is given back by it, even after the window is gone
    this.toDip = toDip;
    this.spawnFn = spawnFn;
    this.platform = platform;
    this.log = log;
    this.docked = false;
    this.queue = Promise.resolve();
    if (platform === 'win32' && typeof win.hookWindowMessage === 'function') {
      win.hookWindowMessage(CALLBACK_MESSAGE, (wParam, lParam) => {
        if (!this.docked) return;
        const code = numberOf(wParam);
        if (code === ABN_POSCHANGED) onMoved();
        else if (code === ABN_FULLSCREENAPP) onFullscreen(numberOf(lParam) !== 0);
      });
    }
  }

  // Reserves a strip `width` DIPs wide (times the monitor's `scaleFactor`) on the left of the
  // window's monitor. Resolves to the strip in DIPs, for the window to take, or null if Windows
  // wouldn't have it (then the window just sits there, over whatever is maximized).
  dock(width, scaleFactor = 1) {
    return this.enqueue(async () => {
      if (this.platform !== 'win32' || this.win.isDestroyed()) return null;
      const r = await runHelper(script('dock', this.hwnd, width * scaleFactor), this.spawnFn);
      const rect = r.ok ? parseRect(r.out) : null;
      if (!rect) {
        this.log('app bar: could not dock', r.error || r.out.trim());
        return null;
      }
      this.docked = true;
      return this.toDip(rect);
    });
  }

  // Gives the strip back to the other windows.
  undock() {
    return this.enqueue(async () => {
      if (this.platform !== 'win32' || !this.docked) return;
      this.docked = false;
      const r = await runHelper(script('undock', this.hwnd), this.spawnFn);
      if (!r.ok) this.log('app bar: could not undock', r.error);
    });
  }

  enqueue(task) {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }
}

module.exports = { AppBar, CALLBACK_MESSAGE, HELPER, parseRect, script };
