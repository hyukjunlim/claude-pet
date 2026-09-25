'use strict';

// Sprite-atlas animation engine for Codex-format pets (8 columns x 9 or 11 rows of 192x208 cells).
// Frame timings and sequencing follow ChatGPT's pet: a state's animation plays three times,
// then the pet settles into a slowed-down idle loop so it stays calm while you work.

const ATLAS_COLUMNS = 8;
const CELL_W = 192;
const CELL_H = 208;

function frames(row, count, ms, lastMs) {
  return Array.from({ length: count }, (_, col) => ({ row, col, ms: col === count - 1 ? lastMs : ms }));
}

const IDLE_FRAMES = [
  { row: 0, col: 0, ms: 280 },
  { row: 0, col: 1, ms: 110 },
  { row: 0, col: 2, ms: 110 },
  { row: 0, col: 3, ms: 140 },
  { row: 0, col: 4, ms: 140 },
  { row: 0, col: 5, ms: 320 },
];
const SETTLED_IDLE = IDLE_FRAMES.map((f) => ({ ...f, ms: f.ms * 6 }));

const ANIMATIONS = {
  idle: IDLE_FRAMES,
  'running-right': frames(1, 8, 120, 220),
  'running-left': frames(2, 8, 120, 220),
  waving: frames(3, 4, 140, 280),
  jumping: frames(4, 5, 140, 280),
  failed: frames(5, 8, 140, 240),
  waiting: frames(6, 6, 150, 260),
  running: frames(7, 6, 120, 220),
  review: frames(8, 6, 150, 280),
};

// 16 clockwise look directions in rows 9-10; 0 degrees = straight up.
function lookFrameFor(dx, dy) {
  const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const index = Math.round(angle / 22.5) % 16;
  return { row: 9 + Math.floor(index / 8), col: index % 8, ms: 0 };
}

class SpritePlayer {
  constructor(el) {
    this.el = el;
    this.rows = 11;
    this.version = 2;
    this.base = 'idle';
    this.transient = null;     // one-shot or held state layered over the base state
    this.held = false;         // transient stays until release() (dragging, being thrown)
    this.settled = true;       // true once we're in the calm idle loop (safe to look around)
    this.looking = false;
    this.timer = null;
    this.frame = IDLE_FRAMES[0];
    this.alpha = null;         // { data, width } of the atlas, for pixel-accurate hit testing
    this.headroom = 0;
    this.onMeasured = null;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion.addEventListener('change', () => this.restart());
  }

  get supportsLook() {
    return this.version >= 2 && this.rows >= 11;
  }

  setSheet({ url, rows, version, pixelArt }) {
    this.rows = rows;
    this.version = version;
    this.el.style.backgroundImage = `url("${url}")`;
    this.el.style.backgroundSize = `${ATLAS_COLUMNS * 100}% ${rows * 100}%`;
    this.el.classList.toggle('pixel', Boolean(pixelArt));
    this.alpha = null;
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        this.alpha = { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
        this.headroom = this.measureHeadroom();
        this.onMeasured?.(this.headroom);
      } catch {
        this.alpha = null;     // fall back to box hit testing
      }
    };
    img.src = url;
    this.restart();
  }

  setBase(state) {
    if (!ANIMATIONS[state]) state = 'idle';
    if (state === this.base) return;
    this.base = state;
    if (!this.transient) this.play(state);
  }

  // Replay the current base state (used as a periodic gentle reminder).
  replayBase() {
    if (!this.transient && !this.looking) this.play(this.base);
  }

  playOnce(state, loops = 1) {
    if (!ANIMATIONS[state] || this.held) return;
    this.transient = state;
    this.play(state, {
      loops,
      onDone: () => {
        this.transient = null;
        this.play(this.base);
      },
    });
  }

  hold(state) {
    if (this.transient === state && this.held) return;
    this.transient = state;
    this.held = true;
    this.play(state, { hold: true });
  }

  release() {
    if (!this.transient) return;
    this.transient = null;
    this.held = false;
    this.play(this.base);
  }

  restart() {
    if (this.held && this.transient) {
      this.play(this.transient, { hold: true });
      return;
    }
    this.transient = null;
    this.play(this.base);
  }

  play(state, { loops = 3, onDone = null, hold = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    this.looking = false;
    const base = ANIMATIONS[state] || IDLE_FRAMES;
    let seq;
    let loopStart;
    if (this.reducedMotion.matches) {
      seq = [base[0]];
      loopStart = null;
    } else if (hold) {
      seq = base;
      loopStart = 0;
    } else if (state === 'idle') {
      seq = SETTLED_IDLE;
      loopStart = 0;
    } else {
      const repeated = [];
      for (let i = 0; i < loops; i += 1) repeated.push(...base);
      seq = onDone ? repeated : [...repeated, ...SETTLED_IDLE];
      loopStart = onDone ? null : repeated.length;
    }
    this.settled = !hold && state === 'idle';
    let i = 0;
    this.show(seq[0]);
    if (seq.length === 1 && !onDone) return;
    const tick = () => {
      this.timer = setTimeout(() => {
        i += 1;
        if (i >= seq.length) {
          if (loopStart == null) {
            this.timer = null;
            if (onDone) onDone();
            return;
          }
          i = loopStart;
        }
        if (loopStart != null && i >= loopStart && !hold) this.settled = true;
        this.show(seq[i]);
        tick();
      }, seq[i].ms);
    };
    tick();
  }

  // Show a look-direction frame while calm; returns false if busy animating.
  look(dx, dy) {
    if (!this.supportsLook || !this.settled || this.transient || this.reducedMotion.matches) return false;
    if (!this.looking) {
      clearTimeout(this.timer);
      this.timer = null;
      this.looking = true;
    }
    this.show(lookFrameFor(dx, dy));
    return true;
  }

  unlook() {
    if (!this.looking) return;
    this.looking = false;
    // Resume the calm loop without replaying the state's attention animation.
    const seq = SETTLED_IDLE;
    let i = 0;
    this.show(seq[0]);
    const tick = () => {
      this.timer = setTimeout(() => {
        i = (i + 1) % seq.length;
        this.show(seq[i]);
        tick();
      }, seq[i].ms);
    };
    tick();
  }

  show(frame) {
    this.frame = frame;
    this.el.style.backgroundPosition = `${(frame.col / (ATLAS_COLUMNS - 1)) * 100}% ${(frame.row / (this.rows - 1)) * 100}%`;
  }

  // Fraction of the cell above the art in the states shown next to bubbles
  // (idle, failed, waiting, running, review), so bubbles can sit just above the pet.
  measureHeadroom() {
    const { data, width } = this.alpha;
    let top = CELL_H;
    for (const row of [0, 5, 6, 7, 8]) {
      for (let col = 0; col < ATLAS_COLUMNS; col += 1) {
        const x0 = col * CELL_W;
        const y0 = row * CELL_H;
        for (let y = 0; y < top; y += 1) {
          let opaque = false;
          for (let x = 0; x < CELL_W; x += 2) {
            if (data[((y0 + y) * width + x0 + x) * 4 + 3] > 24) {
              opaque = true;
              break;
            }
          }
          if (opaque) {
            top = y;
            break;
          }
        }
      }
    }
    return top >= CELL_H ? 0 : top / CELL_H;
  }

  // Is the pixel under (x, y) (relative to the sprite box, CSS px) part of the pet?
  hitTest(x, y, boxWidth, boxHeight) {
    if (x < 0 || y < 0 || x > boxWidth || y > boxHeight) return false;
    if (!this.alpha) return true;
    const sx = CELL_W / boxWidth;
    const sy = CELL_H / boxHeight;
    const ax = this.frame.col * CELL_W + x * sx;
    const ay = this.frame.row * CELL_H + y * sy;
    const r = 8;   // forgiving radius in atlas pixels
    for (const [ox, oy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const px = Math.round(ax + ox);
      const py = Math.round(ay + oy);
      const cellX = px - this.frame.col * CELL_W;
      const cellY = py - this.frame.row * CELL_H;
      if (cellX < 0 || cellY < 0 || cellX >= CELL_W || cellY >= CELL_H) continue;
      if (this.alpha.data[(py * this.alpha.width + px) * 4 + 3] > 24) return true;
    }
    return false;
  }
}

window.SpritePlayer = SpritePlayer;
