'use strict';

// Folder mode's page: every Claude session and Codex thread under its machine and folder (the
// tree comes ready-made from src/folder-tree.js), eTL's notices under it, and the weekly limits
// and the pet docked at the bottom. A click on a session opens it in its app; a folder folds.

(() => {
  const api = window.folder;
  const treeEl = document.getElementById('tree');
  const searchEl = document.getElementById('search');
  const noticesEl = document.getElementById('notices');
  const meterEl = document.getElementById('meter');
  const petEl = document.getElementById('pet');
  const spriteEl = document.getElementById('sprite');
  const player = new window.SpritePlayer(spriteEl);

  const LABELS = { waiting: 'Needs you', failed: 'Error', review: 'Ready', running: 'Running', background: 'Background' };
  const APP_NAME = { claude: 'Claude', codex: 'Codex' };
  const FOLD_KEY = 'claude-pet:folder-fold';   // folder key -> open, where you changed it

  let hosts = [];
  let notices = [];
  let query = '';
  let current = null;                          // the session you opened last
  let fold = loadFold();

  // ---------------------------------------------------------- data from the main process

  api.onTree((list) => {
    hosts = Array.isArray(list) ? list : [];
    render();
  });
  api.onNotices((list) => {
    notices = Array.isArray(list) ? list : [];
    renderNotices();
  });
  api.onUsage((items) => renderMeter(Array.isArray(items) ? items : []));
  api.onPet((pet) => {
    player.setSheet(pet);
    petEl.setAttribute('aria-label', `${pet.displayName}, your Claude pet`);
  });
  api.onMotion(({ alwaysAnimate }) => player.setAlwaysAnimate(alwaysAnimate));
  api.onStatus((status) => player.setBase(status || 'idle'));
  api.onWake(() => player.playOnce('waving', 3));

  // ---------------------------------------------------------- folding

  function loadFold() {
    try {
      const saved = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  }

  function setOpen(key, open) {
    fold[key] = open;
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(fold));
    } catch {
      // kept for this run only
    }
    render();
  }

  // While searching, everything that matches is shown open.
  const isOpen = (key, byDefault) => (query ? true : fold[key] ?? byDefault);

  // ---------------------------------------------------------- the tree

  function render() {
    const shown = query ? hosts.map(filterHost).filter(Boolean) : hosts;
    const scroll = treeEl.scrollTop;
    treeEl.replaceChildren(...shown.map(hostEl));
    if (!shown.length) treeEl.append(el('div', 'empty', query ? 'No sessions match.' : 'No Claude sessions or Codex threads yet.'));
    treeEl.scrollTop = scroll;
  }

  function hostEl(h) {
    const open = isOpen(h.key, true);
    const wrap = el('div', `host${open ? ' open' : ''}`);
    wrap.setAttribute('role', 'group');
    const head = el('button', 'host-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.append(el('span', 'chevron', '▶'), el('span', 'name', h.label));
    if (!open) head.append(...pips(h));
    head.addEventListener('click', () => setOpen(h.key, !open));
    wrap.append(head);
    if (open) {
      const kids = el('div', 'children');
      for (const f of h.folders) kids.append(folderEl(f, 0));
      if (h.loose.length) {
        kids.append(folderEl({ key: `${h.key}|loose`, label: 'No folder', path: '', sessions: h.loose, children: [], open: true, attention: 0, busy: 0 }, 0));
      }
      wrap.append(kids);
    }
    return wrap;
  }

  function folderEl(n, depth) {
    const open = isOpen(n.key, n.open);
    const wrap = el('div', `folder${open ? ' open' : ''}`);
    const row = el('button', 'row');
    row.type = 'button';
    row.style.setProperty('--depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(open));
    if (n.path) row.title = n.path;
    row.append(el('span', 'chevron', '▶'), withMatches(el('span', 'name'), n.label));
    if (!open) row.append(...pips(n));
    row.addEventListener('click', () => setOpen(n.key, !open));
    wrap.append(row);
    if (open) {
      const kids = el('div', 'children');
      for (const s of n.sessions) kids.append(sessionEl(s, depth + 1));
      for (const c of n.children) kids.append(folderEl(c, depth + 1));
      wrap.append(kids);
    }
    return wrap;
  }

  function sessionEl(s, depth) {
    const row = el('button', `row session status-${s.status}${s.id === current ? ' current' : ''}`);
    row.type = 'button';
    row.style.setProperty('--depth', String(depth));
    row.setAttribute('role', 'treeitem');
    const state = LABELS[s.status];
    row.setAttribute('aria-label', [s.title, APP_NAME[s.app], state, `Click to open in ${APP_NAME[s.app]}`].filter(Boolean).join(', '));
    row.append(el('span', 'chevron'), el('span', `app ${s.app}`), withMatches(el('span', 'name'), s.title));
    if (state) row.append(el('span', 'state', state));
    else {
      const ago = el('span', 'ago', formatAgo(s.lastActivityAt));
      ago.dataset.at = String(s.lastActivityAt || 0);
      row.append(ago);
    }
    row.addEventListener('click', () => {
      current = s.id;
      api.open(s.id);
      render();
    });
    return row;
  }

  // A folded folder's news: something needs you, or is working.
  function pips(n) {
    if (n.attention > 0) return [el('span', 'pip attention')];
    if (n.busy > 0) return [el('span', 'pip busy')];
    return [];
  }

  // ---------------------------------------------------------- search

  function matches(text) {
    return String(text || '').toLowerCase().includes(query);
  }

  function filterHost(h) {
    const folders = h.folders.map(filterFolder).filter(Boolean);
    const loose = h.loose.filter((s) => matches(s.title));
    return folders.length || loose.length ? { ...h, folders, loose } : null;
  }

  // A folder whose name matches keeps all its sessions; otherwise only the sessions that match.
  function filterFolder(n) {
    const named = matches(n.label);
    const sessions = named ? n.sessions : n.sessions.filter((s) => matches(s.title));
    const children = n.children.map(filterFolder).filter(Boolean);
    return named || sessions.length || children.length ? { ...n, sessions, children } : null;
  }

  function withMatches(target, text) {
    const s = String(text || '');
    if (!query) {
      target.textContent = s;
      return target;
    }
    const lower = s.toLowerCase();
    let at = 0;
    for (let i = lower.indexOf(query); i >= 0; i = lower.indexOf(query, at)) {
      if (i > at) target.append(s.slice(at, i));
      target.append(el('mark', '', s.slice(i, i + query.length)));
      at = i + query.length;
    }
    if (at < s.length) target.append(s.slice(at));
    return target;
  }

  searchEl.addEventListener('input', () => {
    query = searchEl.value.trim().toLowerCase();
    render();
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    searchEl.value = '';
    query = '';
    render();
  });

  // ---------------------------------------------------------- eTL

  function renderNotices() {
    noticesEl.hidden = !notices.length;
    noticesEl.replaceChildren(...notices.map((s) => {
      const row = el('button', `row session status-${s.status}`);
      row.type = 'button';
      row.title = s.project || '';
      row.append(el('span', 'state', s.badge || LABELS[s.status] || ''), el('span', 'name', s.title));
      row.addEventListener('click', () => api.open(s.id));
      return row;
    }));
  }

  // ---------------------------------------------------------- the weekly limits (as pet.js draws them)

  function renderMeter(usage) {
    meterEl.hidden = !usage.length;
    meterEl.replaceChildren(...usage.map(gauge));
    meterEl.setAttribute('aria-label', `Weekly limits: ${usage.map((u) => `${u.name} ${u.percent}% used`).join('; ')}`);
  }

  function gauge(u) {
    const g = el('div', `gauge ${u.app}`);
    const fill = el('span', 'fill');
    fill.style.width = `${u.percent}%`;
    g.append(fill);
    if (u.elapsed != null) {
      const now = el('span', 'now');
      now.style.left = `${u.elapsed}%`;
      g.append(now);
    }
    g.append(el('span', 'name', u.name), el('span', 'pct', `${u.percent}%`));
    for (const [layer, clip] of [['base', `inset(0 0 0 ${u.percent}%)`], ['ink', `inset(0 ${100 - u.percent}% 0 0)`]]) {
      const copy = el('span', layer);
      copy.append(el('span', 'name', u.name), el('span', 'pct', `${u.percent}%`));
      copy.style.clipPath = clip;
      g.append(copy);
    }
    return g;
  }

  // ---------------------------------------------------------- the pet

  petEl.addEventListener('click', () => {
    api.activatePet();
    player.playOnce('waving');
  });
  petEl.addEventListener('pointerenter', () => {
    if (!player.transient) player.playOnce('jumping');
  });

  document.addEventListener('contextmenu', (e) => {
    if (e.target === searchEl) return;   // the field's own menu (cut, copy, paste)
    e.preventDefault();
    api.contextMenu(e.screenX, e.screenY);
  });

  document.getElementById('pet-mode').addEventListener('click', () => api.petMode());

  // ---------------------------------------------------------- width: drag the right edge

  // The page only says when the drag moves and ends: the window resizes under the pointer, so
  // its coordinates aren't to be trusted then, and the main process goes by the cursor itself.
  const edgeEl = document.getElementById('edge');
  let resizing = null;

  edgeEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    edgeEl.setPointerCapture(e.pointerId);
    edgeEl.classList.add('dragging');
    resizing = { id: e.pointerId, frame: 0, moved: false };
  });
  edgeEl.addEventListener('pointermove', (e) => {
    if (!resizing || e.pointerId !== resizing.id || resizing.frame) return;
    resizing.moved = true;
    resizing.frame = requestAnimationFrame(() => {   // one move per frame
      if (!resizing) return;
      resizing.frame = 0;
      api.resize('move');
    });
  });
  // A click without a drag changes nothing, so the second click of a double-click lands too.
  const endResize = (e) => {
    if (!resizing || e.pointerId !== resizing.id) return;
    const { moved } = resizing;
    resizing = null;
    edgeEl.classList.remove('dragging');
    if (moved) api.resize('end');
  };
  edgeEl.addEventListener('pointerup', endResize);
  edgeEl.addEventListener('pointercancel', endResize);
  edgeEl.addEventListener('dblclick', () => api.resize('reset'));

  // ---------------------------------------------------------- text size: Ctrl +, Ctrl -, Ctrl 0

  const ZOOM_KEY = 'claude-pet:folder-zoom';
  const ZOOMS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];
  const zoomLevelEl = document.getElementById('zoom-level');
  let zoom = 1;
  let zoomTimer = null;

  function setZoom(z, show) {
    zoom = Math.min(ZOOMS.at(-1), Math.max(ZOOMS[0], Number(z) || 1));
    document.documentElement.style.zoom = String(zoom);   // the whole sidebar, as a browser's zoom does
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {
      // kept for this run only
    }
    if (!show) return;
    zoomLevelEl.textContent = `${Math.round(zoom * 100)}%`;
    zoomLevelEl.hidden = false;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => { zoomLevelEl.hidden = true; }, 1200);
  }

  function zoomBy(step) {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
    const at = i < 0 ? ZOOMS.length - 1 : i;
    setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + step))], true);
  }

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === '=' || e.key === '+') zoomBy(1);
    else if (e.key === '-' || e.key === '_') zoomBy(-1);
    else if (e.key === '0') setZoom(1, true);
    else return;
    e.preventDefault();
  });
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  try {
    setZoom(localStorage.getItem(ZOOM_KEY) || 1, false);
  } catch {
    setZoom(1, false);
  }

  // ---------------------------------------------------------- helpers

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function formatAgo(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  // Keep "3m" fresh without redrawing the tree (which would take the keyboard focus away).
  setInterval(() => {
    for (const e of treeEl.querySelectorAll('.ago[data-at]')) e.textContent = formatAgo(Number(e.dataset.at));
  }, 30_000);

  api.ready();
})();
