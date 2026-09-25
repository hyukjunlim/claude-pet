'use strict';

(() => {
  const api = window.pet;
  const stage = document.getElementById('stage');
  const petEl = document.getElementById('pet');
  const spriteEl = document.getElementById('sprite');
  const trayEl = document.getElementById('tray');
  const meterEl = document.createElement('div');   // the weekly limits, at the pet's end of the stack
  const badgeEl = document.getElementById('badge');
  const player = new window.SpritePlayer(spriteEl);
  player.onMeasured = (headroom) => stage.style.setProperty('--headroom', String(Math.min(0.5, headroom)));

  const LABELS = { waiting: 'Needs you', failed: 'Error', review: 'Ready', running: 'Running' };
  const ATTENTION = new Set(['waiting', 'failed', 'review']);
  const SHADOW_ROOM = 16;          // px kept around the bubbles so their shadows aren't cut off
  const REMIND_MS = 45_000;

  let sessions = [];
  let showActivity = true;
  let usage = [];              // weekly limits: [{ app, name, percent, elapsed, resetsIn }]
  let lookTimer = null;
  let remindTimer = null;
  let drag = null;
  let awaitingLanding = false;
  let isInteractive = false;
  let scale = 0.75;
  let petCenterX = window.innerWidth / 2;
  let bubbleMargin = 12;
  let previous = new Map();

  // ---------------------------------------------------------- layout

  api.onPet((pet) => {
    player.setSheet(pet);
    petEl.setAttribute('aria-label', `${pet.displayName}, your Claude pet`);
  });

  let lastLayout = null;
  window.addEventListener('resize', () => lastLayout && applyLayout(lastLayout));
  api.onLayout(applyLayout);

  function applyLayout(l) {
    lastLayout = l;
    scale = l.scale;
    bubbleMargin = l.margin;
    const dpr = window.devicePixelRatio || 1;
    const w = 192 * scale;
    const h = 208 * scale;
    const left = Math.round(l.petLeft * dpr) / dpr;    // whole device pixels keep pixel art crisp
    petCenterX = left + w / 2;
    stage.style.setProperty('--pet-w', `${w}px`);
    stage.style.setProperty('--pet-h', `${h}px`);
    stage.style.setProperty('--pet-left', `${left}px`);
    stage.classList.toggle('above', l.layout === 'above');
    stage.classList.toggle('below', l.layout === 'below');
    placeBubbles();
  }

  // Center each bubble over the pet, but keep it inside the window (which stays on the
  // pet's monitor) with a margin, so near an edge the bubbles slide inward.
  function placeBubbles() {
    const width = window.innerWidth;
    const maxWidth = width - 2 * bubbleMargin;
    for (const el of trayEl.children) {
      el.style.maxWidth = `${maxWidth}px`;
      const w = el.offsetWidth;
      const x = Math.min(Math.max(petCenterX - w / 2, bubbleMargin), width - bubbleMargin - w);
      el.style.marginLeft = `${Math.round(x)}px`;
    }
    fitTray();
  }

  // Every session gets a bubble. The window grows to fit the stack (up to the monitor's edge);
  // if even that isn't enough, the stack scrolls.
  let reportedHeight = -1;
  function fitTray() {
    const needed = trayEl.children.length ? trayEl.scrollHeight + SHADOW_ROOM : 0;
    if (Math.abs(needed - reportedHeight) > 1) {
      reportedHeight = needed;
      api.traySize(needed);
    }
    trayEl.classList.toggle('scroll', trayEl.scrollHeight > trayEl.clientHeight + 1);
  }

  // ---------------------------------------------------------- sessions

  api.onSessions((payload) => {
    sessions = payload.sessions || [];
    showActivity = payload.showActivity !== false;
    reactToChanges();
    render();
    const top = sessions[0]?.status || 'idle';
    player.setBase(top);
    scheduleReminder(top);
  });

  api.onUsage((items) => {
    usage = Array.isArray(items) ? items : [];
    renderMeter();
    render();
  });

  function reactToChanges() {
    const next = new Map(sessions.map((s) => [s.id, s.status]));
    let finished = false;
    for (const [id, status] of next) {
      const before = previous.get(id);
      if (before === 'running' && status === 'review') finished = true;
    }
    previous = next;
    if (finished && sessions[0]?.status === 'review') player.playOnce('jumping');
  }

  function scheduleReminder(top) {
    clearInterval(remindTimer);
    remindTimer = null;
    if (top === 'waiting' || top === 'failed') {
      remindTimer = setInterval(() => player.replayBase(), REMIND_MS);
    }
  }

  let renderedIds = new Set();

  function render() {
    trayEl.replaceChildren();
    if (usage.length) trayEl.append(meterEl);   // next to the pet, with the bubbles beyond it
    const visible = showActivity ? sessions : [];
    for (const s of visible) {
      const el = pill(s);
      if (!renderedIds.has(s.id)) el.classList.add('enter');
      trayEl.append(el);
    }
    renderedIds = new Set(visible.map((s) => s.id));
    placeBubbles();

    // With bubbles hidden, a badge on the pet counts sessions that need attention.
    const attention = sessions.filter((s) => ATTENTION.has(s.status)).length;
    const badge = showActivity ? 0 : attention;
    badgeEl.hidden = badge <= 0;
    badgeEl.textContent = badge > 9 ? '9+' : String(badge);
    badgeEl.className = attention ? 'attention' : '';
  }

  function pill(s) {
    const el = document.createElement('div');
    el.className = `pill status-${s.status}`;
    el.dataset.interactive = '';
    el.setAttribute('role', 'listitem');
    const codex = s.kind === 'codex';
    // No hover tooltip (it pops up over the other bubbles); screen readers still get the details.
    const where = s.remote ? (codex ? `on ${s.remote}` : `SSH · ${s.remote}`) : '';
    const action = s.kind === 'cli' ? 'Terminal session (no link)' : `Click to open in ${codex ? 'Codex' : 'Claude'}`;
    el.setAttribute('aria-label', [s.title, s.detail, where, action].filter(Boolean).join(', '));

    const icon = document.createElement('span');
    icon.className = 'icon';
    el.append(icon);

    const text = document.createElement('span');
    text.className = 'text';
    const line = document.createElement('span');
    line.className = 'line1';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = LABELS[s.status] || s.status;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = s.title;
    line.append(label, title);
    // "Claude · tokenizer · 5m": which app, the project, how long. A long project name gets cut
    // short, but the time stays visible.
    const detail = document.createElement('span');
    detail.className = 'detail';
    const ago = formatAgo(s.since);
    detail.append(span('what', [codex ? 'Codex' : 'Claude', s.project].filter(Boolean).join(' · ')));
    if (ago) detail.append(span('ago', `· ${ago}`));
    text.append(line, detail);
    el.append(text);

    if (s.status !== 'running') {
      const close = document.createElement('button');
      close.className = 'close';
      close.type = 'button';
      close.dataset.interactive = '';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        api.dismiss(s.id);
      });
      el.append(close);
    }

    el.addEventListener('click', () => {
      api.activate(s.id);
      player.playOnce('waving');
    });
    return el;
  }

  // One bubble with a row per app: how much of its weekly limit is used (the fill, and the number
  // on the right), against how far into the week it is (the line across the row). A fill past the
  // line means you're using it faster than the week goes by. Clicks go through it, like through
  // the empty parts of the window.
  meterEl.className = 'meter';
  meterEl.setAttribute('role', 'listitem');

  function renderMeter() {
    meterEl.replaceChildren(...usage.map(gauge));
    const said = usage.map((u) => [`${u.name} ${u.percent}% used`, u.elapsed != null && `${u.elapsed}% into the week`]
      .filter(Boolean).join(', '));
    meterEl.setAttribute('aria-label', `Weekly limits: ${said.join('; ')}`);
  }

  function gauge(u) {
    const el = document.createElement('div');
    el.className = `gauge ${u.app}`;
    const fill = span('fill', '');
    fill.style.width = `${u.percent}%`;
    el.append(fill);
    if (u.elapsed != null) {
      const now = span('now', '');
      now.style.left = `${u.elapsed}%`;
      el.append(now);
    }
    el.append(span('name', u.name), span('pct', `${u.percent}%`));
    // Rows with a solid fill (Claude's) draw their text twice more, each copy cut at the fill's
    // edge: the usual color outside the fill, and the fill's own text color over it.
    for (const [layer, clip] of [['base', `inset(0 0 0 ${u.percent}%)`], ['ink', `inset(0 ${100 - u.percent}% 0 0)`]]) {
      const copy = span(layer, '');
      copy.append(span('name', u.name), span('pct', `${u.percent}%`));
      copy.style.clipPath = clip;
      el.append(copy);
    }
    return el;
  }

  function span(className, text) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  function formatAgo(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  setInterval(render, 30_000);     // keep "3m ago" fresh

  // ---------------------------------------------------------- click-through

  function overPet(clientX, clientY) {
    const r = spriteEl.getBoundingClientRect();
    return player.hitTest(clientX - r.left, clientY - r.top, r.width, r.height);
  }

  function hitTest(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    if (el === petEl || el === spriteEl) return overPet(x, y);
    return Boolean(el.closest('[data-interactive]'));
  }

  function setInteractive(value) {
    if (value === isInteractive) return;
    isInteractive = value;
    api.setInteractive(value);
  }

  window.addEventListener('mousemove', (e) => {
    if (!drag) setInteractive(hitTest(e.clientX, e.clientY));
  });
  document.documentElement.addEventListener('mouseleave', () => {
    if (!drag) setInteractive(false);
  });

  // ---------------------------------------------------------- hover, drag, throw, click

  let hoverArmed = true;
  spriteEl.addEventListener('pointermove', (e) => {
    const over = overPet(e.clientX, e.clientY);
    if (over && hoverArmed && !drag && !player.transient) {
      hoverArmed = false;
      player.playOnce('jumping');
    }
    if (!over) hoverArmed = true;
  });
  petEl.addEventListener('pointerleave', () => {
    hoverArmed = true;
  });

  petEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !overPet(e.clientX, e.clientY)) return;
    e.preventDefault();
    petEl.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.screenX, y: e.screenY, moved: false, samples: [{ x: e.screenX, y: e.screenY, t: e.timeStamp }] };
    petEl.classList.add('dragging');
    setInteractive(true);
    api.dragStart(e.screenX, e.screenY);
  });

  petEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.samples.push({ x: e.screenX, y: e.screenY, t: e.timeStamp });
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > 100) drag.samples.shift();
    const dx = e.screenX - drag.x;
    const dy = e.screenY - drag.y;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    drag.x = e.screenX;
    drag.y = e.screenY;
    if (dx >= 4) player.hold('running-right');
    else if (dx <= -4) player.hold('running-left');
    api.dragMove(e.screenX, e.screenY);
  });

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    petEl.classList.remove('dragging');
    if (petEl.hasPointerCapture(e.pointerId)) petEl.releasePointerCapture(e.pointerId);
    let vx = 0;
    let vy = 0;
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (d.moved && !cancelled && dt > 0.01) {
      vx = ((last.x - first.x) / dt) * 1.6;
      vy = ((last.y - first.y) / dt) * 1.6;
    }
    awaitingLanding = d.moved;
    api.dragEnd(vx, vy);
    if (!d.moved && !cancelled) {
      api.activate(null);
      player.playOnce('waving');
    }
    setInteractive(hitTest(e.clientX, e.clientY));
  }

  petEl.addEventListener('pointerup', (e) => endDrag(e, false));
  petEl.addEventListener('pointercancel', (e) => endDrag(e, true));

  api.onLanded(() => {
    if (awaitingLanding) {
      awaitingLanding = false;
      player.release();
    }
  });

  petEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.contextMenu(e.screenX, e.screenY);
  });

  api.onWake(() => player.playOnce('waving', 2));

  // ---------------------------------------------------------- eyes follow the cursor

  api.onCursor(({ dx, dy }) => {
    if (drag) return;
    const dist = Math.hypot(dx, dy);
    const near = 208 * scale * 0.35;
    if (dist < near || dist > 1200) {
      player.unlook();
      return;
    }
    if (player.look(dx, dy)) {
      clearTimeout(lookTimer);
      lookTimer = setTimeout(() => player.unlook(), 1600);
    }
  });

  api.ready();
})();
