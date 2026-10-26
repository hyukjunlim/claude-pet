'use strict';

// The Getting started window's preload (see onboarding.js): what it shows comes in as one state,
// and each step asks for what it does by name.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gettingStarted', {
  onState: (fn) => ipcRenderer.on('onboarding:state', (_e, state) => fn(state)),
  ready: () => ipcRenderer.send('onboarding:ready'),
  act: (name, arg) => ipcRenderer.send('onboarding:act', String(name), arg),
});
