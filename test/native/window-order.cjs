// Run on Windows with node_modules/electron/dist/electron.exe test/native/window-order.cjs
'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, BrowserWindow } = require('electron');
const { watchWindowOrder } = require(path.resolve(__dirname, '../../src/window-order'));
app.setPath('userData', path.join(app.getPath('temp'), `claude-pet-order-test-${process.pid}`));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const records = [], checks = [];
const check = (name, pass) => { checks.push({ name, pass }); console.log(JSON.stringify({name,pass})); };
app.whenReady().then(async () => {
  let pet, cover, watcher;
  const nativeStates = [];
  try {
    const options = { x: -20000, y: -20000, width: 24, height: 24, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, minimizable: false, focusable: false, skipTaskbar: true, show: false, type: 'toolbar', webPreferences: { sandbox: true } };
    pet = new BrowserWindow({ ...options, alwaysOnTop: true });
    cover = new BrowserWindow({ ...options, focusable: true });
    pet.setAlwaysOnTop(true, 'pop-up-menu');
    pet.showInactive(); cover.showInactive(); cover.focus();
    const handle = (win) => win.getNativeWindowHandle().readBigUInt64LE().toString();
    const native = async (mode = 'snapshot') => {
      const state=JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'window-order.ps1'), mode, handle(pet), handle(cover), String(process.pid)], { encoding: 'utf8', windowsHide: true, timeout: 15000 })).stdout);
      nativeStates.push({ mode, state }); return state;
    };
    const inverted = await native('demote');
    await wait(1600);
    const stillInverted = await native();
    check('external native demotion remains observable without the monitor', !inverted.topmost && !inverted.above && !stillInverted.topmost && !stillInverted.above);
    watcher = watchWindowOrder(pet, { log: (event, data) => records.push({ event, data }) });
    await wait(1400);
    const fixed = await native();
    check('event monitor repairs native demotion without a recovery timer', fixed.topmost && fixed.above && records.some((r) => r.event === 'window order correction:'));
    check('repair leaves the foreground handle unchanged', inverted.foreground === fixed.foreground);
    check('native event confirms corrected order after the action', records.some((r) => r.event === 'window order verified:'));
    const correctedCount = records.filter((r) => r.event === 'window order correction:').length;
    pet.setBounds({ x: -20001, y: -20000, width: 24, height: 24 });
    cover.focus();
    await wait(600);
    check('healthy app/window events do not reassert order', records.filter((r) => r.event === 'window order correction:').length === correctedCount);
    await native('cover'); cover.focus(); await wait(600);
    const competing = await native();
    check('another topmost window is allowed above the pet', competing.topmost && !competing.above && records.filter((r) => r.event === 'window order correction:').length === correctedCount);
    pet.hide();
    await native('demote'); cover.focus(); await wait(1600);
    const hidden = await native();
    check('explicitly hidden pet stays hidden and is not raised on app events', !hidden.visible && !hidden.topmost && records.filter((r) => r.event === 'window order correction:').length === correctedCount);
    pet.showInactive(); await wait(1000);
    const shown = await native();
    check('showing the pet restores its topmost flag through the show event', shown.visible && shown.topmost);
  } catch(error) { records.push({ error: error.stack }); check('validation completed', false); console.error(error.stack); }
  finally {
    watcher?.stop(); pet?.destroy(); cover?.destroy();
    console.log(JSON.stringify({ checks, nativeStates, records }));
    app.exit(checks.some((c)=>!c.pass)?1:0);
  }
});
