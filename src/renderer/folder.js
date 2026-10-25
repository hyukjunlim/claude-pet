'use strict';

// Folder mode's page: every Claude session and Codex thread under its machine and folder (the
// tree comes ready-made from src/folder-tree.js), eTL's notices under it, and the weekly limits
// and the pet docked at the bottom. A click on a session opens it in its app; a machine or a
// folder folds, and dragging it moves it among its siblings.

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
  const APP_NAME = { claude: 'Claude', codex: 'Codex', 'claude-web': 'claude.ai', chatgpt: 'ChatGPT', gemini: 'Gemini' };
  const FOLD_KEY = 'claude-pet:folder-fold';   // folder key -> open, where you changed it
  const ORDER_KEY = 'claude-pet:folder-order'; // parent key -> its folders' keys, in your order
  const MACHINES = '*';                        // ... where the parent is the list of machines
  const BASE_ZOOM = 1.2;                       // the text size at 100% (Ctrl 0), over folder.css's px
  let zoom = 1;                                // Ctrl + and Ctrl - from there, 80% to 200%

  let hosts = [];
  let notices = [];
  let query = '';
  let current = null;                          // the session you opened last
  let fold = load(FOLD_KEY);
  let order = load(ORDER_KEY);
  let press = null;                            // a folder row held down, maybe being dragged
  let dragged = false;                         // the click a drag ends with isn't one
  let treePending = false;                     // a tree that came during a drag

  // ---------------------------------------------------------- data from the main process

  api.onTree((list) => {
    hosts = Array.isArray(list) ? list : [];
    if (press?.dragging) treePending = true;   // the rows hold still under a drag
    else render();
  });
  api.onNotices((list) => {
    notices = Array.isArray(list) ? list : [];
    renderNotices();
  });
  api.onUsage((items) => renderMeter(Array.isArray(items) ? items : []));
  api.onPet((pet) => {
    player.setSheet(pet);
    petEl.setAttribute('aria-label', `${pet.displayName}, your Claude pet`);
    petScale = Number(pet.scale) || 0.5;
    sizePet();
  });

  // The atlas cell, 192 x 208, at the pet's scale (tray menu → Size), on screen: the page's
  // zoom is undone for it, so Ctrl + and Ctrl - size the text and leave the pet as it is.
  let petScale = 0.5;
  function sizePet() {
    const z = BASE_ZOOM * zoom;
    petEl.style.width = `${(192 * petScale) / z}px`;
    petEl.style.height = `${(208 * petScale) / z}px`;
  }
  api.onMotion(({ alwaysAnimate }) => player.setAlwaysAnimate(alwaysAnimate));
  api.onStatus((status) => player.setBase(status || 'idle'));
  api.onWake(() => player.playOnce('waving', 3));

  // ---------------------------------------------------------- folding

  function load(key) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // kept for this run only
    }
  }

  function setOpen(key, open) {
    fold[key] = open;
    saveFold();
    render();
  }

  const saveFold = () => save(FOLD_KEY, fold);

  // While searching, everything that matches is shown open.
  const isOpen = (key, byDefault) => (query ? true : fold[key] ?? byDefault);

  // Every folder row as [key, open by default]: the machines' folders, and each "No folder".
  function folderKeys() {
    const out = [];
    const walk = (n) => {
      out.push([n.key, n.open]);
      n.children.forEach(walk);
    };
    for (const h of hosts) {
      h.folders.forEach(walk);
      if (h.loose.length && h.kind !== 'chat') out.push([`${h.key}|loose`, true]);
    }
    return out;
  }

  // The machine and the folders on the way to session `id`.
  function pathTo(id) {
    const keys = new Set();
    const has = (list) => list.some((s) => s.id === id);
    const walk = (n) => {
      if (has(n.sessions) || n.children.some(walk)) {
        keys.add(n.key);
        return true;
      }
      return false;
    };
    for (const h of hosts) {
      const inFolders = h.folders.some(walk);
      if (!inFolders && has(h.loose)) keys.add(`${h.key}|loose`);
      if (inFolders || has(h.loose)) keys.add(h.key);
    }
    return keys;
  }

  // The folders on the way to the session you opened last, so folding everything leaves it in view.
  const keptKeys = () => pathTo(current);

  // The header's button folds every folder but those (the machines stay open, so their top
  // folders show), or, when they're all folded, opens everything.
  const foldAllEl = document.getElementById('fold-all');
  const allFolded = () => {
    const kept = keptKeys();
    return folderKeys().every(([key, byDefault]) => kept.has(key) || !(fold[key] ?? byDefault));
  };

  function updateFoldAll() {
    const folded = allFolded();
    const label = folded ? 'Expand all folders' : 'Collapse all folders';
    foldAllEl.classList.toggle('folded', folded);
    foldAllEl.title = label;
    foldAllEl.setAttribute('aria-label', label);
  }

  foldAllEl.addEventListener('click', () => {
    const open = allFolded();
    const kept = keptKeys();
    for (const [key] of folderKeys()) fold[key] = open || kept.has(key);
    for (const h of hosts) fold[h.key] = true;
    saveFold();
    render();
  });

  // ---------------------------------------------------------- Ctrl+Tab: the next session, in the list's order

  // Every session as the list shows it (what matches, while searching), folded folders included:
  // a step into one opens it.
  function listed() {
    const shown = query ? hosts.map(filterHost).filter(Boolean) : hosts;
    const out = [];
    const walk = (n) => {
      out.push(...n.sessions);
      arranged(n.key, n.children).forEach(walk);
    };
    for (const h of arranged(MACHINES, shown)) {
      arranged(h.key, h.folders).forEach(walk);
      out.push(...h.loose);
    }
    return out;
  }

  api.onStep((direction) => {
    const list = listed();
    if (!list.length) return;
    const at = list.findIndex((s) => s.id === current);
    const next = at < 0 ? (direction > 0 ? 0 : list.length - 1) : (at + direction + list.length) % list.length;
    current = list[next].id;
    for (const key of pathTo(current)) fold[key] = true;
    saveFold();
    render();
    treeEl.querySelector('.row.current')?.scrollIntoView({ block: 'nearest' });
    api.open(current, 'key');
  });

  // ---------------------------------------------------------- the tree

  function render() {
    const shown = query ? hosts.map(filterHost).filter(Boolean) : hosts;
    const scroll = treeEl.scrollTop;
    treeEl.replaceChildren(...arranged(MACHINES, shown).map(hostEl));
    if (!shown.length) treeEl.append(el('div', 'empty', query ? 'No sessions match.' : 'No Claude sessions or Codex threads yet.'));
    treeEl.scrollTop = scroll;
    updateFoldAll();
  }

  function hostEl(h) {
    const open = isOpen(h.key, true);
    const wrap = el('div', `host movable${open ? ' open' : ''}`);
    wrap.dataset.key = h.key;
    wrap.dataset.parent = MACHINES;
    wrap.setAttribute('role', 'group');
    const head = el('button', 'host-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    // A machine is a heading, as a group is in the Claude app's sidebar: just its name, which
    // folds it when clicked. The arrows on the left are the folders'.
    head.append(el('span', 'host-name', h.label));
    if (!open) head.append(...pips(h));
    head.addEventListener('click', () => {
      if (!dragged) setOpen(h.key, !open);
    });
    head.addEventListener('pointerdown', (e) => pressRow(e, wrap));
    wrap.append(head);
    if (open) {
      const kids = el('div', 'children');
      for (const f of arranged(h.key, h.folders)) kids.append(folderEl(f, 0, h.key));
      // Web chats sit right under "Chat"; a machine's sessions without a folder, under "No folder".
      if (h.kind === 'chat') for (const s of h.loose) kids.append(sessionEl(s, 0));
      else if (h.loose.length) {
        kids.append(folderEl({ key: `${h.key}|loose`, label: 'No folder', path: '', sessions: h.loose, children: [], open: true, attention: 0, busy: 0 }, 0));
      }
      wrap.append(kids);
    }
    return wrap;
  }

  // `parentKey`: the machine or folder it sits in, among whose folders it can be dragged ("No
  // folder" has none: it stays last).
  function folderEl(n, depth, parentKey = null) {
    const open = isOpen(n.key, n.open);
    const wrap = el('div', `folder${open ? ' open' : ''}`);
    wrap.dataset.key = n.key;
    if (parentKey) {
      wrap.classList.add('movable');
      wrap.dataset.parent = parentKey;
    }
    wrap.style.setProperty('--depth', String(depth));
    const row = el('button', 'row');
    row.type = 'button';
    row.style.setProperty('--depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(open));
    if (n.path) row.title = n.path;
    row.append(el('span', 'chevron', '▶'), withMatches(el('span', 'name'), n.label));
    if (!open) row.append(...pips(n));
    row.addEventListener('click', () => {
      if (!dragged) setOpen(n.key, !open);
    });
    if (parentKey) row.addEventListener('pointerdown', (e) => pressRow(e, wrap));
    wrap.append(row);
    if (open) {
      const kids = el('div', 'children');
      for (const s of n.sessions) kids.append(sessionEl(s, depth + 1));
      for (const c of arranged(n.key, n.children)) kids.append(folderEl(c, depth + 1, n.key));
      wrap.append(kids);
    }
    return wrap;
  }

  function sessionEl(s, depth) {
    const row = el('button', `row session status-${s.status}${s.flagged ? ' flagged' : ''}${s.id === current ? ' current' : ''}`);
    row.type = 'button';
    row.dataset.id = s.id;
    row.style.setProperty('--depth', String(depth));
    row.setAttribute('role', 'treeitem');
    const state = LABELS[s.status];
    row.setAttribute('aria-label', [s.title, APP_NAME[s.app], state, s.flagged && 'Flagged', `Click to open in ${APP_NAME[s.app]}`].filter(Boolean).join(', '));
    row.append(flagEl(s), el('span', `app ${s.app}`), withMatches(el('span', 'name'), s.title));
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

  // The follow-up flag, where a folder's row has its arrow: faint while you point at the row,
  // filled in once set. Opening the session leaves it; your next message to it takes it off
  // (main.js, flags.js).
  function flagEl(s) {
    const flag = el('span', 'flag');
    flag.title = s.flagged ? 'Clear flag' : 'Flag for follow-up';
    flag.append(flagIcon());
    flag.addEventListener('click', (e) => {
      e.stopPropagation();   // not an open
      s.flagged = !s.flagged;
      api.flag(s.id, s.flagged);
      render();
    });
    return flag;
  }

  // A flag on its pole; CSS fills the cloth in.
  function flagIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M4 14.5V2.5', 'M4 2.75h8.25L10.25 6l2 3.25H4z']) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
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

  // ---------------------------------------------------------- the weekly limits, beside the pet

  // A row per app, as the Claude app's account row sits at the foot of its sidebar: the name and
  // how much is used above a thin bar, with a tick for how far into the week it is (a fill past
  // the tick: faster than the week goes by). The rest is in the tooltip.
  function renderMeter(usage) {
    meterEl.hidden = !usage.length;
    meterEl.replaceChildren(...usage.map(gauge));
    meterEl.setAttribute('aria-label', `Weekly limits: ${usage.map(describe).join('; ')}`);
  }

  function describe(u) {
    return [
      `${u.name}: ${u.percent}% of the weekly limit used`,
      u.elapsed != null && `${u.elapsed}% into the week`,
      u.resetsIn && `resets in ${u.resetsIn}`,
      u.age && `as of ${u.age} ago`,
    ].filter(Boolean).join(' · ');
  }

  function gauge(u) {
    const g = el('div', `gauge ${u.app}`);
    g.title = describe(u);
    const label = el('div', 'gauge-label');
    label.append(el('span', 'name', u.name), el('span', 'pct', `${u.percent}%`));
    const track = el('div', 'track');
    const fill = el('span', 'fill');
    fill.style.width = `${Math.min(100, Math.max(0, u.percent))}%`;
    track.append(fill);
    if (u.elapsed != null) {
      const now = el('span', 'now');
      now.style.left = `${u.elapsed}%`;
      track.append(now);
    }
    g.append(label, track);
    return g;
  }

  // ---------------------------------------------------------- order: drag a machine or a folder

  // The machines, or a parent's folders (a machine's, or a folder's), in the order you dragged
  // them to; the sessions in a folder stay newest first. The first time a parent shows, its order
  // then is kept, so a folder doesn't move when a session in it gets busy; one that turns up later
  // goes on top. One that's gone keeps its place, for when it's back.
  function arranged(parentKey, folders) {
    if (!folders.length) return folders;
    const saved = order[parentKey];
    if (!saved) {
      if (!query) remember(parentKey, folders.map((f) => f.key));
      return folders;
    }
    const rank = new Map(saved.map((k, i) => [k, i]));
    const fresh = folders.filter((f) => !rank.has(f.key));
    const placed = folders.filter((f) => rank.has(f.key)).sort((a, b) => rank.get(a.key) - rank.get(b.key));
    if (fresh.length && !query) remember(parentKey, [...fresh.map((f) => f.key), ...saved]);
    return [...fresh, ...placed];
  }

  function remember(parentKey, keys) {
    order[parentKey] = keys;
    save(ORDER_KEY, order);
  }

  // Held down, a machine's heading or a folder's row starts a drag once the pointer has moved a
  // little; until then it's a click, which folds it. Not while searching, when the list shows
  // only part of each parent.
  const DRAG_PX = 5;

  function pressRow(e, wrap) {
    if (e.button !== 0 || query) return;
    press = { id: e.pointerId, row: e.currentTarget, wrap, y: e.clientY, dragging: false, cancelled: false, target: null, after: false };
  }

  document.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id || press.cancelled) return;
    if (!press.dragging) {
      if (Math.abs(e.clientY - press.y) < DRAG_PX) return;
      press.dragging = true;
      press.row.setPointerCapture(e.pointerId);
      press.wrap.classList.add('dragging');
      document.body.classList.add('reordering');
    }
    scrollNearEdge(e.clientY);
    mark(dropTarget(e.clientX, e.clientY));
  });
  document.addEventListener('pointerup', (e) => {
    if (press && e.pointerId === press.id) endDrag(true);
  });
  document.addEventListener('pointercancel', (e) => {
    if (press && e.pointerId === press.id) endDrag(false);
  });

  // The sibling under the pointer (or the sibling whose folders it's in), and whether the dragged
  // one goes after it: below its middle.
  function dropTarget(x, y) {
    const parent = press.wrap.dataset.parent;
    let f = document.elementFromPoint(x, y)?.closest('.movable');
    while (f && f.dataset.parent !== parent) f = f.parentElement?.closest('.movable');
    if (!f || f === press.wrap) return null;
    const r = f.getBoundingClientRect();
    return { wrap: f, after: y > r.top + r.height / 2 };
  }

  // A line where it would land.
  function mark(target) {
    if (press.target === (target?.wrap ?? null) && press.after === Boolean(target?.after)) return;
    press.target?.classList.remove('drop-before', 'drop-after');
    press.target = target?.wrap ?? null;
    press.after = Boolean(target?.after);
    press.target?.classList.add(press.after ? 'drop-after' : 'drop-before');
  }

  function scrollNearEdge(y) {
    const r = treeEl.getBoundingClientRect();
    if (y < r.top + 24) treeEl.scrollTop -= 12;
    else if (y > r.bottom - 24) treeEl.scrollTop += 12;
  }

  // Escape: it stays where it was. The drag still ends when the button comes up.
  function cancelDrag() {
    mark(null);
    press.cancelled = true;
    press.wrap.classList.remove('dragging');
    document.body.classList.remove('reordering');
  }

  function endDrag(drop) {
    const { dragging, cancelled, wrap, target, after } = press;
    press = null;
    if (!dragging) return;
    target?.classList.remove('drop-before', 'drop-after');
    wrap.classList.remove('dragging');
    document.body.classList.remove('reordering');
    if (drop && !cancelled && target) moveFolder(wrap.dataset.parent, wrap.dataset.key, target.dataset.key, after);
    // The click that comes with the release lands on the old rows; then the list redraws.
    dragged = true;
    setTimeout(() => {
      dragged = false;
      treePending = false;
      render();
    });
  }

  function moveFolder(parentKey, key, targetKey, after) {
    const keys = (order[parentKey] || []).filter((k) => k !== key);
    const at = keys.indexOf(targetKey);
    if (at < 0) return;
    keys.splice(after ? at + 1 : at, 0, key);
    remember(parentKey, keys);
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
    api.contextMenu(e.screenX, e.screenY, e.target.closest?.('.session')?.dataset.id);
  });

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
  let zoomTimer = null;

  function setZoom(z, show) {
    zoom = Math.min(ZOOMS.at(-1), Math.max(ZOOMS[0], Number(z) || 1));
    // The whole sidebar, as a browser's zoom does, from a 100% that is 1.2 times the CSS's sizes.
    document.documentElement.style.zoom = String(BASE_ZOOM * zoom);
    sizePet();
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
    if (e.key === 'Escape' && press?.dragging) {
      cancelDrag();
      e.preventDefault();
      return;
    }
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
