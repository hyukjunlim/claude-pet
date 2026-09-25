'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, net, protocol, screen, shell,
} = require('electron');
const { Settings, DEFAULTS } = require('./settings');
const { discoverPets, petRoots } = require('./pets');
const { SessionTracker, defaultPaths } = require('./sessions');
const { CodexTracker, codexPaths } = require('./codex');
const { compareSessions } = require('./transcript');
const { DemoTracker } = require('./demo');

const DEMO = process.argv.includes('--demo');
const DEBUG_CAPTURE_DIR = process.env.CLAUDE_PET_CAPTURE_DIR || null;
const DEBUG_OPEN_AFTER_MS = Number(process.env.CLAUDE_PET_DEBUG_OPEN_AFTER_MS) || 0;

const APP_ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(__dirname, 'renderer');
const CELL = { width: 192, height: 208 };
const WIN_WIDTH = 400;
const TRAY_HEIGHT = 280;        // room kept free above (or below) the pet for activity pills
const TRAY_GAP = 6;
const EDGE_MARGIN = 24;
const BUBBLE_MARGIN = 12;       // bubbles keep this distance from the monitor's edge
const SCALES = [
  { label: 'Small', value: 0.5 },
  { label: 'Medium', value: 0.75 },
  { label: 'Large', value: 1 },
];
// Throw physics, same constants as ChatGPT's pet.
const MOMENTUM_TICK_MS = 16;
const MOMENTUM_MAX_DT_MS = 32;
const FRICTION_PER_TICK = 0.88;
const BOUNCE = 0.7;
const STOP_SPEED = 65;
const MAX_MOMENTUM_MS = 900;
const MIN_THROW_SPEED = 450;
const STATUS_LABEL = { waiting: 'Needs you', failed: 'Error', review: 'Ready', running: 'Running' };
const DESKTOP_SESSION_RE = /^local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const FOREGROUND_HANDOFF_MS = 1500;

protocol.registerSchemesAsPrivileged([
  { scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let settings;
let tracker;
let codex = null;               // Codex threads, when Codex is installed and shown
let win = null;
let tray = null;
let pets = [];
let currentPet = null;
let petPos = null;              // top-left of the pet sprite, screen DIPs
let layout = 'above';           // pills above or below the pet
let pointerInteractive = false;
let drag = null;
let momentumTimer = null;
let cursorTimer = null;
let lastCursor = null;
let sessions = [];              // Claude and Codex together, most urgent first
let claudeSessions = [];
let codexSessions = [];

function log(...args) {
  console.log(`[claude-pet ${new Date().toTimeString().slice(0, 8)}.${String(Date.now() % 1000).padStart(3, '0')}]`, ...args);
}

// ---------------------------------------------------------------- geometry

function petScale() {
  let s = settings.get('scale');
  if (currentPet?.pixelArt) {
    // Snap so every art pixel (4 atlas px) covers a whole number of device pixels.
    const dpr = displayForPet().scaleFactor || 1;
    s = Math.max(1, Math.round(4 * s * dpr)) / (4 * dpr);
  }
  return s;
}

function petSize() {
  const s = petScale();
  return { width: CELL.width * s, height: CELL.height * s, scale: s };
}

function displayForPet(pos = petPos) {
  if (!pos) return screen.getPrimaryDisplay();
  const s = settings.get('scale');
  return screen.getDisplayNearestPoint({
    x: Math.round(pos.x + (CELL.width * s) / 2),
    y: Math.round(pos.y + (CELL.height * s) / 2),
  });
}

function clampPet(pos) {
  const { width, height } = petSize();
  const wa = displayForPet(pos).workArea;
  return {
    x: Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - height),
  };
}

function defaultPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  const { width, height } = petSize();
  return { x: wa.x + wa.width - width - EDGE_MARGIN - 40, y: wa.y + wa.height - height - EDGE_MARGIN };
}

// Bubbles only go above the pet when all of them would fit on the pet's monitor.
function chooseLayout(pos) {
  const room = pos.y - displayForPet(pos).workArea.y;
  const need = TRAY_HEIGHT + TRAY_GAP;
  if (layout === 'above' && room < need) return 'below';
  if (layout === 'below' && room > need + 40) return 'above';
  return layout;
}

// The window stays on the pet's monitor so the bubbles belong to it. Near an edge the
// window stops at the edge and the pet moves within it, so the pet can still reach the edge.
function windowBounds() {
  const { width, height } = petSize();
  const h = Math.ceil(height) + TRAY_GAP + TRAY_HEIGHT;
  const wa = displayForPet().workArea;
  const centered = petPos.x + width / 2 - WIN_WIDTH / 2;
  const x = wa.width >= WIN_WIDTH ? Math.min(Math.max(centered, wa.x), wa.x + wa.width - WIN_WIDTH) : wa.x;
  return {
    x: Math.round(x),
    y: layout === 'above' ? Math.round(petPos.y + height - h) : Math.round(petPos.y),
    width: WIN_WIDTH,
    height: h,
  };
}

// Always set the full bounds: when the pet crosses onto a monitor with different
// scaling, Windows rescales the window and only moving it would keep the wrong size.
let lastLayoutKey = '';
function placeWindow() {
  if (!win || win.isDestroyed()) return;
  const b = windowBounds();
  win.setBounds(b);
  if (layoutKey(b) !== lastLayoutKey) sendLayout();
}

function layoutKey(b) {
  return `${layout}|${petScale()}|${Math.round((petPos.x - b.x) * 4)}`;
}

function sendLayout() {
  if (!win || win.isDestroyed()) return;
  const b = windowBounds();
  lastLayoutKey = layoutKey(b);
  win.webContents.send('pet:layout', {
    layout,
    scale: petScale(),
    petLeft: petPos.x - b.x,
    margin: BUBBLE_MARGIN,
  });
}

// Apply a change that alters the pet's size while keeping its feet where they were.
function resizeInPlace(change) {
  const before = petSize();
  const anchor = { x: petPos.x + before.width / 2, y: petPos.y + before.height };
  change();
  const after = petSize();
  petPos = clampPet({ x: anchor.x - after.width / 2, y: anchor.y - after.height });
  finishMove();
}

function finishMove() {
  const next = chooseLayout(petPos);
  const changed = next !== layout;
  layout = next;
  placeWindow();
  sendLayout();
  if (changed) log(`pills now ${layout} the pet`);
  settings.set({ position: petPos });
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    ...windowBounds(),
    title: 'Claude Pet',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    ...(process.platform === 'win32' ? { thickFrame: false, roundedCorners: false, accentColor: false } : {}),
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);
  applyPointerPolicy();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', (_e, details) => {
    log('renderer exited:', details.reason);
    if (details.reason !== 'clean-exit') setTimeout(() => win?.reload(), 1000);
  });
  win.once('ready-to-show', () => {
    if (settings.get('visible')) {
      win.showInactive();
      wake();
    }
  });
  win.loadURL('pet://app/ui/index.html');
}

function applyPointerPolicy() {
  if (!win || win.isDestroyed()) return;
  if (pointerInteractive || drag) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
}

function setVisible(visible) {
  settings.set({ visible });
  if (!win || win.isDestroyed()) return;
  if (visible) {
    win.showInactive();
    wake();
  } else {
    win.hide();
  }
}

function wake() {
  win?.webContents.send('pet:wake');
}

// ---------------------------------------------------------------- pets

function sheetUrl(pet) {
  let v = 0;
  try {
    v = Math.round(fs.statSync(pet.sheet).mtimeMs);
  } catch {
    // keep 0
  }
  return `pet://app/sheet/${encodeURIComponent(pet.key)}?v=${v}`;
}

function loadPets() {
  pets = discoverPets(APP_ROOT, log);
  currentPet = pets.find((p) => p.key === settings.get('petKey')) || pets.find((p) => p.key === DEFAULTS.petKey) || pets[0] || null;
  log(`pets: ${pets.map((p) => p.key).join(', ') || 'none'}; using ${currentPet?.key}`);
}

function sendPet() {
  if (!win || win.isDestroyed() || !currentPet) return;
  win.webContents.send('pet:pet', {
    key: currentPet.key,
    displayName: currentPet.displayName,
    url: sheetUrl(currentPet),
    rows: currentPet.rows,
    version: currentPet.version,
    pixelArt: currentPet.pixelArt,
  });
}

function selectPet(key) {
  const pet = pets.find((p) => p.key === key);
  if (!pet) return;
  resizeInPlace(() => {
    currentPet = pet;
    settings.set({ petKey: key });
  });
  tray?.setImage(trayImageFor(pet));
  sendPet();
  wake();
}

// A pet can ship its own tray icon (tray.png, plus @1.5x/@2x variants) next to its sprite
// sheet; otherwise the default icon is used.
function trayImageFor(pet) {
  const own = pet ? path.join(pet.dir, 'tray.png') : null;
  const file = own && fs.existsSync(own) ? own : path.join(APP_ROOT, 'assets', 'tray.png');
  log(`tray icon: ${path.relative(APP_ROOT, file) || file}`);
  return nativeImage.createFromPath(file);
}

function handleProtocol(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
  if (url.pathname.startsWith('/sheet/')) {
    const key = decodeURIComponent(url.pathname.slice('/sheet/'.length));
    const pet = pets.find((p) => p.key === key);
    if (!pet) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(pet.sheet).toString());
  }
  if (url.pathname.startsWith('/ui/')) {
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(url.pathname.slice('/ui/'.length))));
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  }
  return new Response('Not found', { status: 404 });
}

// ---------------------------------------------------------------- sessions

function sendSessions() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('pet:sessions', { sessions, showActivity: settings.get('showActivity') });
  if (tray) tray.setToolTip(trayTooltip());
}

function mergeSessions() {
  sessions = [...claudeSessions, ...codexSessions].sort(compareSessions);
  sendSessions();
  if (DEBUG_CAPTURE_DIR) debugCapture(sessions);
}

function codexInstalled() {
  return fs.existsSync(codexPaths().home);
}

function startCodex() {
  if (codex || DEMO || !settings.get('showCodex') || !codexInstalled()) return;
  codex = new CodexTracker({
    ...codexPaths(),
    watchHosts: settings.get('codexOverSsh'),
    dismissed: settings.get('dismissed') || {},
  });
  codex.on('change', (list) => {
    codexSessions = list;
    mergeSessions();
  });
  codex.on('error', (err) => log('codex tracker error:', err?.message || err));
  codex.start();
}

function stopCodex() {
  codex?.stop();
  codex = null;
  codexSessions = [];
  mergeSessions();
}

function trackerFor(id) {
  return String(id).startsWith('codex:') ? codex : tracker;
}

function trayTooltip() {
  if (!sessions.length) return 'Claude Pet: all quiet';
  const top = sessions[0];
  return `Claude Pet: ${STATUS_LABEL[top.status]} · ${top.title}`.slice(0, 120);
}

// Claude's claude://code/continue?session=… links sit behind a server-side flag and quietly
// do nothing on some accounts. claude://resume is always on: given the id part of an existing
// desktop session (local_<uuid>), it opens that session as-is, SSH sessions included. Only
// sessions that are still in the desktop index get a link, so resume never imports a copy.
function sessionUrl(s) {
  if (s?.kind === 'codex') return s.url || null;   // codex://threads/<id>?hostId=…
  const m = DESKTOP_SESSION_RE.exec(s?.hostSessionId || '');
  if (!m || !tracker.desktop?.has(s.hostSessionId)) return null;
  return `claude://resume?session=${m[1]}`;
}

// Launching any claude:// link makes the running app restore and focus its main window;
// claude://hotkey does nothing else (codex:// links work the same way for Codex). On Windows
// an app may only bring another app forward
// if it's the one in front, and the pet window never takes focus. So a click first focuses
// a tiny invisible helper window, then launches the link, and hides the helper once Claude
// has taken over. (Toggling the pet window's own focusability doesn't work: Electron then
// deactivates it, which hands focus to whatever window sits under the pet.)
let handoffWin = null;
let handoffTimer = null;

function focusHandoffWindow() {
  if (!handoffWin || handoffWin.isDestroyed()) {
    handoffWin = new BrowserWindow({
      width: 1,
      height: 1,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      show: false,
      title: 'Claude Pet focus helper',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
  }
  const { width, height } = petSize();
  handoffWin.setBounds({ x: Math.round(petPos.x + width / 2), y: Math.round(petPos.y + height / 2), width: 1, height: 1 });
  handoffWin.showInactive();
  handoffWin.focus();
}

function openApp(url = 'claude://hotkey') {
  if (process.platform === 'win32') {
    clearTimeout(handoffTimer);
    focusHandoffWindow();
    handoffTimer = setTimeout(() => {
      if (!handoffWin || handoffWin.isDestroyed()) return;
      if (DEBUG_OPEN_AFTER_MS) log(`debug: hiding focus helper (focused=${handoffWin.isFocused()})`);
      handoffWin.hide();
    }, FOREGROUND_HANDOFF_MS);
  }
  shell.openExternal(url).catch((err) => log(`could not open ${url.split(':')[0]}:`, err.message));
}

function openSession(id) {
  const s = sessions.find((x) => x.id === id);
  const url = s && sessionUrl(s);
  if (!url) return false;
  openApp(url);
  if (s.status !== 'running') {
    trackerFor(s.id)?.dismiss(s.id);
    persistDismissed();
  }
  return true;
}

function persistDismissed() {
  settings.set({ dismissed: { ...tracker.dismissedSnapshot(), ...codex?.dismissedSnapshot() } });
}

// ---------------------------------------------------------------- drag & throw

function stopMomentum() {
  clearTimeout(momentumTimer);
  momentumTimer = null;
}

function startMomentum(vx, vy) {
  stopMomentum();
  const started = Date.now();
  let last = started;
  const step = () => {
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    const dt = Math.min(Math.max(0, now - last), MOMENTUM_MAX_DT_MS);
    last = now;
    const next = { x: petPos.x + (vx * dt) / 1000, y: petPos.y + (vy * dt) / 1000 };
    const clamped = clampPet(next);
    if (clamped.x !== next.x) vx = -vx * BOUNCE;
    if (clamped.y !== next.y) vy = -vy * BOUNCE;
    petPos = clamped;
    placeWindow();
    const friction = FRICTION_PER_TICK ** (dt / MOMENTUM_TICK_MS);
    vx *= friction;
    vy *= friction;
    if (now - started >= MAX_MOMENTUM_MS || Math.hypot(vx, vy) < STOP_SPEED) {
      momentumTimer = null;
      win.webContents.send('pet:landed');
      finishMove();
      return;
    }
    momentumTimer = setTimeout(step, MOMENTUM_TICK_MS);
  };
  momentumTimer = setTimeout(step, MOMENTUM_TICK_MS);
}

function fromPet(event) {
  return win && !win.isDestroyed() && event.sender === win.webContents;
}

function registerIpc() {
  ipcMain.on('pet:ready', (e) => {
    if (!fromPet(e)) return;
    sendPet();
    sendLayout();
    sendSessions();
  });
  ipcMain.on('pet:interactive', (e, value) => {
    if (!fromPet(e)) return;
    pointerInteractive = value === true;
    applyPointerPolicy();
  });
  ipcMain.on('pet:drag-start', (e, p) => {
    if (!fromPet(e) || !isPoint(p)) return;
    stopMomentum();
    drag = { dx: p.screenX - petPos.x, dy: p.screenY - petPos.y };
    applyPointerPolicy();
  });
  ipcMain.on('pet:drag-move', (e, p) => {
    if (!fromPet(e) || !drag || !isPoint(p)) return;
    petPos = clampPet({ x: p.screenX - drag.dx, y: p.screenY - drag.dy });
    placeWindow();
  });
  ipcMain.on('pet:drag-end', (e, v) => {
    if (!fromPet(e) || !drag) return;
    drag = null;
    applyPointerPolicy();
    const vx = Number(v?.vx) || 0;
    const vy = Number(v?.vy) || 0;
    if (Math.hypot(vx, vy) >= MIN_THROW_SPEED) startMomentum(vx, vy);
    else {
      win.webContents.send('pet:landed');
      finishMove();
    }
  });
  ipcMain.on('pet:activate', (e, id) => {
    if (!fromPet(e)) return;
    if (typeof id === 'string') {
      if (!openSession(id)) wake();     // terminal sessions have nothing to open
      return;
    }
    openApp();                          // clicking the pet opens Claude, like ChatGPT's pet
  });
  ipcMain.on('pet:dismiss', (e, id) => {
    if (!fromPet(e) || typeof id !== 'string') return;
    trackerFor(id)?.dismiss(id);
    persistDismissed();
  });
  ipcMain.on('pet:context-menu', (e, p) => {
    if (!fromPet(e)) return;
    const position = isPoint(p) ? { x: Math.round(p.screenX), y: Math.round(p.screenY) } : undefined;
    tray?.popUpContextMenu(buildMenu(), position);
  });
}

function isPoint(p) {
  return p && Number.isFinite(p.screenX) && Number.isFinite(p.screenY);
}

// Eyes follow the cursor (look-direction rows of v2 pets).
function startCursorTracking() {
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || drag || momentumTimer) return;
    const p = screen.getCursorScreenPoint();
    if (lastCursor && p.x === lastCursor.x && p.y === lastCursor.y) return;
    lastCursor = p;
    const { width, height } = petSize();
    win.webContents.send('pet:cursor', { dx: p.x - (petPos.x + width / 2), dy: p.y - (petPos.y + height / 2) });
  }, 50);
}

// ---------------------------------------------------------------- tray

function loginItemOptions() {
  return app.isPackaged ? {} : { path: process.execPath, args: [APP_ROOT] };
}

// `--start-at-login` / `--no-start-at-login` set the same option as the tray menu's checkbox.
function applyLoginFlag(argv) {
  const on = argv.includes('--start-at-login');
  const off = argv.includes('--no-start-at-login');
  if (!on && !off) return;
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: on });
  log(`start at login: ${app.getLoginItemSettings(loginItemOptions()).openAtLogin ? 'on' : 'off'}`);
}

function buildMenu() {
  const items = [];
  items.push({ label: sessions.length ? `Sessions (${sessions.length} active)` : 'No active sessions', enabled: false });
  const tags = { cli: ' (terminal)', codex: ' (Codex)' };
  for (const s of sessions.slice(0, 8)) {
    items.push({
      label: `${STATUS_LABEL[s.status]} · ${truncate(s.title, 42)}${tags[s.kind] || ''}`,
      enabled: Boolean(sessionUrl(s)),
      click: () => openSession(s.id),
    });
  }
  items.push({ type: 'separator' });
  items.push({
    label: 'Show pet',
    type: 'checkbox',
    checked: settings.get('visible'),
    accelerator: settings.get('shortcut'),
    click: (mi) => setVisible(mi.checked),
  });
  items.push({
    label: 'Show activity bubbles',
    type: 'checkbox',
    checked: settings.get('showActivity'),
    click: (mi) => {
      settings.set({ showActivity: mi.checked });
      sendSessions();
    },
  });
  if (codexInstalled() && !DEMO) {
    items.push({
      label: 'Show Codex threads',
      type: 'checkbox',
      checked: settings.get('showCodex'),
      click: (mi) => {
        settings.set({ showCodex: mi.checked });
        if (mi.checked) startCodex();
        else stopCodex();
      },
    });
    items.push({
      label: 'Follow Codex on SSH hosts',
      type: 'checkbox',
      checked: settings.get('codexOverSsh'),
      enabled: settings.get('showCodex'),
      click: (mi) => {
        settings.set({ codexOverSsh: mi.checked });
        codex?.setWatchHosts(mi.checked);
      },
    });
  }
  items.push({
    label: 'Pet',
    submenu: [
      ...pets.map((p) => ({
        label: `${p.displayName}${p.source === 'codex' ? '  (from Codex)' : ''}${p.version === 1 ? '  (v1)' : ''}`,
        type: 'radio',
        checked: p.key === currentPet?.key,
        click: () => selectPet(p.key),
      })),
      { type: 'separator' },
      { label: 'Open my pets folder', click: openPetsFolder },
      { label: 'Reload pets', click: () => { loadPets(); selectPet(currentPet?.key); } },
    ],
  });
  items.push({
    label: 'Size',
    submenu: SCALES.map((s) => ({
      label: s.label,
      type: 'radio',
      checked: settings.get('scale') === s.value,
      click: () => resizeInPlace(() => settings.set({ scale: s.value })),
    })),
  });
  items.push({
    label: 'Reset position',
    click: () => {
      layout = 'above';
      petPos = clampPet(defaultPosition());
      finishMove();
      wake();
    },
  });
  items.push({
    label: 'Start at login',
    type: 'checkbox',
    checked: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
    click: (mi) => app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: mi.checked }),
  });
  items.push({ type: 'separator' });
  items.push({ label: 'Open Claude', click: () => openApp() });
  items.push({ label: 'Quit Claude Pet', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

function openPetsFolder() {
  const dir = petRoots(APP_ROOT).find((r) => r.source === 'user').dir;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

function createTray() {
  tray = new Tray(trayImageFor(currentPet));
  tray.setToolTip(trayTooltip());
  const show = () => tray.popUpContextMenu(buildMenu());
  tray.on('click', show);
  tray.on('right-click', show);
}

// Debug aid: CLAUDE_PET_CAPTURE_DIR=<dir> saves a PNG of the pet window after each change.
let captureCount = 0;
function debugCapture(list) {
  const n = ++captureCount;
  setTimeout(async () => {
    if (!win || win.isDestroyed()) return;
    const image = await win.webContents.capturePage();
    const status = list[0]?.status || 'idle';
    fs.mkdirSync(DEBUG_CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_CAPTURE_DIR, `capture-${String(n).padStart(2, '0')}-${status}.png`), image.toPNG());
    log(`captured ${status} (${list.length} sessions), window ${JSON.stringify(win.getBounds())}, menu items ${buildMenu().items.length}`);
  }, 1800);
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    applyLoginFlag(argv);
    setVisible(true);
  });
  app.setAppUserModelId('ClaudePet');

  app.whenReady().then(() => {
    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    applyLoginFlag(process.argv);
    protocol.handle('pet', handleProtocol);
    loadPets();
    const saved = settings.get('position');
    petPos = clampPet(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : defaultPosition());
    layout = 'above';
    layout = chooseLayout(petPos);

    registerIpc();
    createTray();
    createWindow();
    startCursorTracking();

    tracker = DEMO
      ? new DemoTracker()
      : new SessionTracker({ ...defaultPaths(app.getPath('appData')), dismissed: settings.get('dismissed') || {} });
    tracker.on('change', (list) => {
      claudeSessions = list;
      mergeSessions();
    });
    tracker.on('error', (err) => log('tracker error:', err?.message || err));
    tracker.start();
    startCodex();

    const shortcut = settings.get('shortcut');
    try {
      if (shortcut && !globalShortcut.register(shortcut, () => setVisible(!win?.isVisible()))) {
        log(`shortcut ${shortcut} is taken by another app`);
      }
    } catch (err) {
      log(`invalid shortcut ${shortcut}: ${err.message}`);
    }

    const onDisplaysChanged = () => {
      petPos = clampPet(petPos);
      finishMove();
    };
    // Debug aid: CLAUDE_PET_DEBUG_OPEN_AFTER_MS=<ms> simulates clicking the pet.
    if (DEBUG_OPEN_AFTER_MS) {
      setTimeout(() => {
        log('debug: simulating a pet click (openApp)');
        openApp();
      }, DEBUG_OPEN_AFTER_MS);
    }
    screen.on('display-metrics-changed', onDisplaysChanged);
    screen.on('display-added', onDisplaysChanged);
    screen.on('display-removed', onDisplaysChanged);
    log(`watching ${os.homedir()} sessions${codex ? ' and Codex threads' : ''}; press ${shortcut} to show/hide`);
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray.
  });

  app.on('before-quit', () => {
    clearInterval(cursorTimer);
    stopMomentum();
    tracker?.stop();
    codex?.stop();
    if (settings) settings.save();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
