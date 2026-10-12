'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanShape, shapeForWindow, NO_SHAPE, MAX_RECTS } = require('../src/shape');

// ---------------------------------------------------------------- the main process's side

test('a shape from the page is checked and rounded', () => {
  assert.equal(cleanShape(null), null);
  assert.equal(cleanShape({ layout: 'sideways', rects: [] }), null);
  assert.equal(cleanShape({ layout: 'above', rects: 'no' }), null);
  const shape = cleanShape({
    layout: 'below',
    rects: [[10.4, 20.6, 30.2, 40.5], [0, 0, 0, 5], [1, 2, 3], ['1', 2, 3, 4], [NaN, 0, 5, 5], 'x', [5, 5, 10, -1]],
  });
  assert.deepEqual(shape, { layout: 'below', rects: [{ x: 10, y: 21, width: 30, height: 41 }] });
});

test('a page cannot send more rectangles than the limit', () => {
  const rects = Array.from({ length: MAX_RECTS + 50 }, (_, i) => [i, 0, 1, 1]);
  assert.equal(cleanShape({ layout: 'above', rects }).rects.length, MAX_RECTS);
});

test('rectangles measured from the bottom are laid on the window from its bottom', () => {
  const shape = cleanShape({ layout: 'above', rects: [[100, 0, 50, 60], [20, 90, 200, 40]] });
  assert.deepEqual(shapeForWindow(shape, 400, 500), [
    { x: 100, y: 440, width: 50, height: 60 },
    { x: 20, y: 370, width: 200, height: 40 },
  ]);
});

test('rectangles measured from the top are laid on the window as they are', () => {
  const shape = cleanShape({ layout: 'below', rects: [[100, 0, 50, 60], [20, 90, 200, 40]] });
  assert.deepEqual(shapeForWindow(shape, 400, 500), [
    { x: 100, y: 0, width: 50, height: 60 },
    { x: 20, y: 90, width: 200, height: 40 },
  ]);
});

test('when the window grows upward for a new bubble, the pet stays with the bottom', () => {
  const shape = cleanShape({ layout: 'above', rects: [[100, 0, 50, 60]] });
  const before = shapeForWindow(shape, 400, 300)[0];
  const after = shapeForWindow(shape, 400, 400)[0];
  assert.equal(after.y - before.y, 100);                  // the window's top moved up by 100, the pet did not
  assert.equal(after.y + after.height, 400);
});

test('parts outside the window are cut off, and nothing left is a single pixel', () => {
  const shape = cleanShape({ layout: 'below', rects: [[-10, -10, 30, 30], [380, 480, 50, 50], [500, 0, 10, 10]] });
  assert.deepEqual(shapeForWindow(shape, 400, 500), [
    { x: 0, y: 0, width: 20, height: 20 },
    { x: 380, y: 480, width: 20, height: 20 },
  ]);
  assert.deepEqual(shapeForWindow(cleanShape({ layout: 'above', rects: [] }), 400, 500), NO_SHAPE);
  assert.equal(NO_SHAPE.length, 1);                        // an empty list would make the window rectangular
});

// ---------------------------------------------------------------- the pet's outline

const { SpritePlayer } = (() => {
  const filename = path.join(__dirname, '../src/renderer/sprite.js');
  const window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { window }, { filename });
  return window;
})();

const CELL_W = 192;
const CELL_H = 208;
const COLUMNS = 8;
const ROWS = 11;

function atlas(paint) {
  const width = COLUMNS * CELL_W;
  const height = ROWS * CELL_H;
  const data = new Uint8Array(width * height * 4);
  const fill = (row, col, x0, y0, x1, y1, alpha) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) data[((row * CELL_H + y) * width + col * CELL_W + x) * 4 + 3] = alpha;
    }
  };
  paint(fill);
  return { data, width, height };
}

// Arrays made inside the vm context have another Array prototype, which strict deepEqual refuses.
const plain = (value) => JSON.parse(JSON.stringify(value));

function covers(rects, x, y) {
  return rects.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
}

test('the outline covers every frame of a row, a little beyond the art', () => {
  const a = atlas((fill) => {
    fill(1, 0, 48, 64, 60, 80, 255);       // one frame's art
    fill(1, 3, 120, 100, 132, 112, 255);   // another frame's, elsewhere in the cell
    fill(2, 0, 10, 10, 20, 20, 255);       // a different row
  });
  const rects = SpritePlayer.silhouetteRects(a.data, a.width, a.height, 1);
  assert.ok(covers(rects, 54, 70) && covers(rects, 126, 106), 'the art of both frames is covered');
  assert.ok(covers(rects, 67, 70), 'a click just off the art still lands');
  assert.ok(!covers(rects, 70, 70) && !covers(rects, 54, 40), 'the empty cell is not');
  assert.ok(!covers(rects, 15, 15), 'another row is not');
  assert.ok(rects.length <= 20, `rows of blocks with the same extent are merged (${rects.length} rectangles)`);
});

test('a round shape needs only a handful of rectangles', () => {
  const a = atlas((fill) => {
    for (let y = 0; y < CELL_H; y += 1) {
      const half = Math.round(Math.sqrt(Math.max(0, 80 * 80 - (y - 104) * (y - 104))));
      fill(0, 0, 96 - half, y, 96 + half, y + 1, 255);
    }
  });
  const rects = SpritePlayer.silhouetteRects(a.data, a.width, a.height, 0);
  assert.ok(rects.length <= 60, `${rects.length} rectangles`);
  assert.ok(covers(rects, 96, 104));
  assert.ok(!covers(rects, 5, 5));
});

test('pixels too faint to see are not part of the outline', () => {
  const a = atlas((fill) => {
    fill(0, 0, 40, 40, 60, 60, 255);
    fill(0, 0, 150, 150, 170, 170, 3);
  });
  const rects = SpritePlayer.silhouetteRects(a.data, a.width, a.height, 0);
  assert.ok(covers(rects, 50, 50));
  assert.ok(!covers(rects, 160, 160));
});

test('an empty row, or one the atlas does not have, is taken to fill its cell', () => {
  const a = atlas(() => {});
  assert.deepEqual(plain(SpritePlayer.silhouetteRects(a.data, a.width, a.height, 4)), [[0, 0, CELL_W, CELL_H]]);
  assert.deepEqual(plain(SpritePlayer.silhouetteRects(a.data, a.width, a.height, ROWS + 3)), [[0, 0, CELL_W, CELL_H]]);
  assert.deepEqual(plain(SpritePlayer.silhouetteRects(a.data, 10, 10, 0)), [[0, 0, CELL_W, CELL_H]]);
});

test('the player outlines the row on show, scaled to its box, and says when the row changes', () => {
  const a = atlas((fill) => {
    fill(0, 0, 80, 80, 100, 100, 255);
    fill(1, 0, 10, 10, 30, 30, 255);
  });
  const el = { style: {}, classList: { toggle() {} } };
  const player = new SpritePlayer(el);
  player.alpha = a;
  let changes = 0;
  player.onShapeChange = () => { changes += 1; };
  player.frame = { row: 0, col: 0, ms: 1 };
  const idle = player.shapeRects(96, 104);                 // half size
  assert.ok(covers(idle, 45, 45) && !covers(idle, 10, 10));
  player.show({ row: 0, col: 1, ms: 1 });
  assert.equal(changes, 0);
  player.show({ row: 1, col: 0, ms: 1 });
  assert.equal(changes, 1);
  const other = player.shapeRects(96, 104);
  assert.ok(covers(other, 10, 10) && !covers(other, 45, 45));
});

test('a pet whose atlas could not be read fills its box', () => {
  const player = new SpritePlayer({ style: {}, classList: { toggle() {} } });
  assert.deepEqual(plain(player.shapeRects(144, 156)), [[0, 0, 144, 156]]);
});
