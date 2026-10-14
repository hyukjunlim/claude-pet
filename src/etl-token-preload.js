'use strict';

// The eTL token window's preload (see src/etl/token-window.js): just enough to hand over the
// token, open the page that issues tokens, and close the window.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('etlToken', {
  // -> Promise<{ ok: true, user? } | { ok: false, error }>
  submit: (token) => ipcRenderer.invoke('etl-token:submit', typeof token === 'string' ? token : ''),
  openGuide: () => ipcRenderer.send('etl-token:guide'),
  close: () => ipcRenderer.send('etl-token:close'),
});
