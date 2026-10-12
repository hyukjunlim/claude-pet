'use strict';

// The pet's window is see-through, so it is cut to what's drawn (BrowserWindow.setShape): the pet
// and the bubbles take the mouse, and a click anywhere else goes to the window behind. Windows
// does that test itself, so there is no cursor to watch and no state for the page and the main
// process to keep in step.
//
// The page works out the rectangles. It measures each from the edge of the window its content
// sits against (the bottom while the bubbles are above the pet, else the top), and the main
// process lays them on the window as it is at that moment: when the window grows for a new
// bubble, the shape moves with the content at once instead of waiting for the page to reflow.

const MAX_RECTS = 512;

// setShape([]) would make the window rectangular again, so "nothing" is a single pixel.
const NO_SHAPE = Object.freeze([Object.freeze({ x: 0, y: 0, width: 1, height: 1 })]);

// What the page sent: { layout: 'above' | 'below', rects: [[x, y, width, height], ...] }, where y
// is the distance from the anchored edge to the rectangle's near side (its bottom, when 'above').
function cleanShape(payload) {
  if (!payload || (payload.layout !== 'above' && payload.layout !== 'below') || !Array.isArray(payload.rects)) return null;
  const rects = [];
  for (const r of payload.rects.slice(0, MAX_RECTS)) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) continue;
    const [x, y, width, height] = r.map(Math.round);
    if (width > 0 && height > 0) rects.push({ x, y, width, height });
  }
  return { layout: payload.layout, rects };
}

// The shape in the window's own coordinates, for a window of this size.
function shapeForWindow(shape, width, height) {
  const out = [];
  for (const r of shape.rects) {
    const top = shape.layout === 'above' ? height - r.y - r.height : r.y;
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, top);
    const x1 = Math.min(width, r.x + r.width);
    const y1 = Math.min(height, top + r.height);
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return out.length ? out : NO_SHAPE;
}

module.exports = { cleanShape, shapeForWindow, NO_SHAPE, MAX_RECTS };
