'use strict';

// The small window that asks for the eTL access token. It is UI only: the caller's verify(token)
// checks the token against eTL and saves it, and this module only reports how that went.
//
// The page gets a minimal API from etl-token-preload.js. Its messages are handled on its own
// webContents (webContents.ipc), so no other window can submit a token or close this one.

const path = require('node:path');
const { BrowserWindow, Menu, nativeTheme, shell } = require('electron');
const { normalizeToken } = require('./token');

const GUIDE_URL = 'https://myetl.snu.ac.kr/profile/settings';
const ETL_ORIGIN = 'https://myetl.snu.ac.kr';
const SUCCESS_CLOSE_MS = 1200;          // long enough to read "저장했습니다"
const MAX_ERROR_LENGTH = 300;

let current = null;                     // { win, done } while the window is open

function isEtlUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === ETL_ORIGIN && !u.username && !u.password;
  } catch {
    return false;
  }
}

function openEtlUrl(url) {
  if (isEtlUrl(url)) shell.openExternal(url).catch(() => {});
}

// What the page may show when verify fails: its Korean message, with the token cut out in case
// some lower layer quoted it.
function errorText(err, token) {
  let text = err && typeof err.message === 'string' && err.message.trim()
    ? err.message.trim()
    : '토큰을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  if (token) text = text.split(token).join('(토큰)');
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

// Opens the window (or brings the open one forward) and resolves once it closes:
// { saved: true, user } when a token went through verify, else { saved: false }.
function openTokenWindow({ parent = null, verify } = {}) {
  if (typeof verify !== 'function') throw new TypeError('openTokenWindow needs verify(token)');
  if (current && !current.win.isDestroyed()) {
    if (current.win.isMinimized()) current.win.restore();
    current.win.show();
    current.win.focus();
    return current.done;
  }

  const win = new BrowserWindow({
    width: 440,
    height: 320,
    useContentSize: true,
    title: 'eTL 토큰 등록',
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#282623' : '#fffdfa',
    webPreferences: {
      preload: path.join(__dirname, '..', 'etl-token-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu();

  let result = { saved: false };
  let inFlight = null;                  // the verify call under way, if any
  let closeTimer = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  current = { win, done };

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    openEtlUrl(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    e.preventDefault();
    openEtlUrl(url);
  });
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.close();
  });
  // Right-click paste, since the token is usually pasted in.
  wc.on('context-menu', (_e, params) => {
    if (!params.isEditable || win.isDestroyed()) return;
    Menu.buildFromTemplate([
      { role: 'paste', label: '붙여넣기' },
      { role: 'selectAll', label: '모두 선택' },
    ]).popup({ window: win });
  });

  const fromPage = (event) => !win.isDestroyed() && event.sender === wc;

  wc.ipc.handle('etl-token:submit', async (event, raw) => {
    if (!fromPage(event)) return { ok: false, error: '잘못된 요청입니다.' };
    if (inFlight) return { ok: false, error: '확인 중입니다. 잠시만 기다려 주세요.' };
    let token;
    try {
      token = normalizeToken(raw);
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
    inFlight = Promise.resolve().then(() => verify(token));
    try {
      const info = await inFlight;
      const user = info && typeof info.user === 'string' ? info.user.slice(0, 100) : undefined;
      result = user ? { saved: true, user } : { saved: true };
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!win.isDestroyed()) win.close();
      }, SUCCESS_CLOSE_MS);
      return user ? { ok: true, user } : { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err, token) };
    } finally {
      inFlight = null;
    }
  });
  wc.ipc.on('etl-token:guide', (event) => {
    if (fromPage(event)) openEtlUrl(GUIDE_URL);
  });
  wc.ipc.on('etl-token:close', (event) => {
    if (fromPage(event)) win.close();
  });

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    clearTimeout(closeTimer);
    if (current && current.win === win) current = null;
    // Closed while verify was still running: its outcome (it may have saved the token) decides.
    const pending = inFlight;
    if (pending) pending.then(() => resolveDone(result), () => resolveDone(result));
    else resolveDone(result);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'etl-token.html')).catch(() => {
    if (!win.isDestroyed()) win.close();
  });
  return done;
}

module.exports = { openTokenWindow, isEtlUrl, GUIDE_URL };
