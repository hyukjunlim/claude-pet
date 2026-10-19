'use strict';

const { probeWindow } = require('./window-probe');

// A normal window can cover the pet while its WS_EX_TOPMOST flag stays set.
// Check the actual order on native window events and repair only an inversion.
// Reasserting setAlwaysOnTop(true) alone can be a no-op in Electron.
function watchWindowOrder(win, { log, platform = process.platform, probe = probeWindow }) {
  if (platform !== 'win32') return;
  let stopped = false;
  let verifying = false;
  const stopProbe = probe(win, {
    onState(snapshot) {
      if (stopped || win.isDestroyed()) return;
      if (snapshot.reason === 'attached') log('window order monitor ready');
      const state = snapshot.state;
      // Reject incomplete enumeration and stale observations of a now-hidden pet.
      if (state.orderComplete !== true || !state.visible || state.minimized || state.cloaked ||
          !win.isVisible() || win.isMinimized()) return;
      const ordinaryAbove = state.overlappingAbove.filter((window) => !window.topmost &&
        !['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'].includes(window.windowClass));
      if (state.topmost && ordinaryAbove.length === 0) {
        if (verifying) log('window order verified:');
        verifying = false;
        return;
      }
      log('window order correction:');
      verifying = true;
      if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'pop-up-menu');
      // moveTop uses SWP_NOACTIVATE. Check visibility immediately above because
      // Electron also supplies SWP_SHOWWINDOW, which must not undo an explicit hide.
      win.moveTop();
    },
    onError: (error) => log('window order monitor error:', error),
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopProbe();
    win.removeListener('closed', stop);
  };
  win.once('closed', stop);
  return { stop };
}

module.exports = { watchWindowOrder };
