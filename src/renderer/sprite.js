'use strict';

// Sprite-atlas animation engine for Codex-format pets (8 columns x 9 or 11 rows of 192x208 cells).
// Frame timings follow ChatGPT's pet. A state's animation (running, review, waiting, failed)
// plays twice and then comes to rest on its first frame, so the pet is still while you work; with
// nothing going on, it loops a slowed-down idle. Reactions to you (hover, clicks) play twice and
// a little slower, so they're easy to catch.

const ATLAS_COLUMNS = 8;
const CELL_W = 192;
const CELL_H = 208;
const STATE_LOOPS = 2;
const REACTION_LOOPS = 2;
const REACTION_PACE = 1.25;   // how much longer each frame of a reaction shows

const SHAPE_BLOCK = 4;        // the pet's outline is worked out in blocks of this many atlas pixels
const SHAPE_GROW = 2;         // and grown by this many blocks (8 atlas pixels), so a click just off the art still lands
const SHAPE_ALPHA = 4;        // anything fainter than this isn't visible, and needn't be inside the window's shape

// Rectangles, in cell pixels, that cover the pet in every frame of one row of the atlas. The window
// is cut to these (see src/shape.js), so a frame never draws outside them and a click beyond them
// goes to the window behind the pet. `data` is the atlas' RGBA.
function silhouetteRects(data, atlasWidth, atlasHeight, row) {
  const whole = [[0, 0, CELL_W, CELL_H]];
  const columns = Math.min(ATLAS_COLUMNS, Math.floor(atlasWidth / CELL_W));
  if (columns < 1 || (row + 1) * CELL_H > atlasHeight) return whole;
  const gw = Math.ceil(CELL_W / SHAPE_BLOCK);
  const gh = Math.ceil(CELL_H / SHAPE_BLOCK);
  let mask = new Uint8Array(gw * gh);
  for (let col = 0; col < columns; col += 1) {
    for (let y = 0; y < CELL_H; y += 1) {
      const start = ((row * CELL_H + y) * atlasWidth + col * CELL_W) * 4 + 3;
      const blockRow = Math.floor(y / SHAPE_BLOCK) * gw;
      for (let x = 0; x < CELL_W; x += 1) {
        if (data[start + x * 4] > SHAPE_ALPHA) mask[blockRow + Math.floor(x / SHAPE_BLOCK)] = 1;
      }
    }
  }
  const grown = (from, dx, dy) => {
    const to = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y += 1) {
      for (let x = 0; x < gw; x += 1) {
        if (!from[y * gw + x]) continue;
        for (let k = -SHAPE_GROW; k <= SHAPE_GROW; k += 1) {
          const nx = x + k * dx;
          const ny = y + k * dy;
          if (nx >= 0 && nx < gw && ny >= 0 && ny < gh) to[ny * gw + nx] = 1;
        }
      }
    }
    return to;
  };
  mask = grown(grown(mask, 1, 0), 0, 1);
  // Runs of blocks along each row; a run directly under one of the same extent joins it.
  const rects = [];
  let open = new Map();
  for (let by = 0; by < gh; by += 1) {
    const next = new Map();
    for (let bx = 0; bx < gw;) {
      if (!mask[by * gw + bx]) {
        bx += 1;
        continue;
      }
      let end = bx;
      while (end < gw && mask[by * gw + end]) end += 1;
      const key = `${bx}:${end}`;
      let rect = open.get(key);
      if (!rect) {
        rect = [bx * SHAPE_BLOCK, by * SHAPE_BLOCK, (end - bx) * SHAPE_BLOCK, 0];
        rects.push(rect);
      }
      rect[3] = (by + 1) * SHAPE_BLOCK - rect[1];
      next.set(key, rect);
      bx = end;
    }
    open = next;
  }
  return rects.length ? rects : whole;
}

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

class SpritePlayer {
  constructor(el) {
    this.el = el;
    this.rows = 11;
    this.base = 'idle';
    this.transient = null;     // one-shot or held state layered over the base state
    this.held = false;         // transient stays until release() (dragging, being thrown)
    this.timer = null;
    this.frame = IDLE_FRAMES[0];
    this.alpha = null;         // { data, width } of the atlas, for pixel-accurate hit testing
    this.headroom = 0;
    this.onMeasured = null;
    this.shapes = new Map();   // atlas row -> the rectangles covering it (see silhouetteRects)
    this.onShapeChange = null; // called when the frame about to show is in another row than the last
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion.addEventListener('change', () => this.restart());
    this.alwaysAnimate = true;   // the tray menu's "Animate even with Windows animation effects off"
  }

  // Still frames only: Windows' Animation effects are off, and you've unticked that menu item.
  get still() {
    return this.reducedMotion.matches && !this.alwaysAnimate;
  }

  setAlwaysAnimate(on) {
    if (Boolean(on) === this.alwaysAnimate) return;
    this.alwaysAnimate = Boolean(on);
    this.restart();
  }

  setSheet({ url, rows, pixelArt }) {
    this.rows = rows;
    this.el.style.backgroundImage = `url("${url}")`;
    this.el.style.backgroundSize = `${ATLAS_COLUMNS * 100}% ${rows * 100}%`;
    this.el.classList.toggle('pixel', Boolean(pixelArt));
    this.alpha = null;
    this.shapes.clear();
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

  playOnce(state, loops = REACTION_LOOPS) {
    if (!ANIMATIONS[state] || this.held) return;
    this.transient = state;
    this.play(state, {
      loops,
      pace: REACTION_PACE,
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

  play(state, { loops = STATE_LOOPS, pace = 1, onDone = null, hold = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    const frames = ANIMATIONS[state] || IDLE_FRAMES;
    const base = pace === 1 ? frames : frames.map((f) => ({ ...f, ms: f.ms * pace }));
    let seq;
    let loopStart;   // where the sequence starts over; null stops it at its end
    if (this.still) {
      seq = [base[0]];
      loopStart = null;
    } else if (hold) {
      seq = base;
      loopStart = 0;
    } else if (state === 'idle') {
      seq = SETTLED_IDLE;
      loopStart = 0;
    } else {
      seq = [];
      for (let i = 0; i < loops; i += 1) seq.push(...base);
      if (!onDone) seq.push(base[0]);   // a state comes to rest on its first frame
      loopStart = null;
    }
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
        this.show(seq[i]);
        tick();
      }, seq[i].ms);
    };
    tick();
  }

  show(frame) {
    const otherRow = frame.row !== this.frame.row;
    this.frame = frame;
    // The window's shape has to cover the new frame before it is drawn.
    if (otherRow) this.onShapeChange?.();
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

  // Where the pet is drawn in the row of the frame on show, as [x, y, width, height] rectangles in
  // CSS px relative to the sprite box. A pet whose atlas can't be read is taken to fill its box.
  shapeRects(boxWidth, boxHeight) {
    const row = this.frame.row;
    let cell = this.shapes.get(row);
    if (!cell && this.alpha) {
      cell = silhouetteRects(this.alpha.data, this.alpha.width, this.alpha.height, row);
      this.shapes.set(row, cell);
    }
    const sx = boxWidth / CELL_W;
    const sy = boxHeight / CELL_H;
    return (cell || [[0, 0, CELL_W, CELL_H]]).map(([x, y, w, h]) => [x * sx, y * sy, w * sx, h * sy]);
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

SpritePlayer.silhouetteRects = silhouetteRects;
window.SpritePlayer = SpritePlayer;
