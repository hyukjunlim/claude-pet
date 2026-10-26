'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// Read-only native states for the window-order guard. No polling or trace logging.
function probeWindow(win, { onState, onError, spawnFn = spawn }) {
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
  const child = spawnFn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'window-probe.ps1'), '-WindowHandle', hwnd, '-ParentProcess', String(process.pid),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  let error = '';
  let stopped = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (stopped) return;
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let snapshot;
      try { snapshot = JSON.parse(line); } catch (err) {
        onError(`invalid native snapshot: ${err.message}`);
        continue;
      }
      onState(snapshot);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-1500); });
  child.on('error', (err) => { if (!stopped) onError(err.message); });
  child.on('exit', (code) => { if (!stopped) onError(`native window probe exited (${code})${error ? `: ${error.trim()}` : ''}`); });
  return () => { stopped = true; child.kill(); };
}

module.exports = { probeWindow };
