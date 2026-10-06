'use strict';

// Runs src/renderer/pet.js against stand-ins for the page, the sprite player and the preload API,
// recording what it asks the main process to do.

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture({ innerWidth = 400, innerHeight = 500, shapeRects = [[10, 20, 100, 120]] } = {}) {
  const filename = path.join(__dirname, '../src/renderer/pet.js');
  const calls = [];
  const callbacks = {};
  function element() {
    const listeners = new Map();
    const classes = new Set();
    const captured = new Set();
    return {
      style: { setProperty() {} },
      children: [],
      setAttribute() {},
      classList: {
        add: (s) => classes.add(s),
        remove: (s) => classes.delete(s),
        contains: (s) => classes.has(s),
        toggle: (s, on) => (on ? classes.add(s) : classes.delete(s)),
      },
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      dispatch(type, e) { for (const fn of listeners.get(type) || []) fn(e); },
      getBoundingClientRect: () => ({ left: 88, top: 284, right: 232, bottom: 440, width: 144, height: 156 }),
      setPointerCapture(id) { captured.add(id); },
      hasPointerCapture(id) { return captured.has(id); },
      releasePointerCapture(id) { captured.delete(id); this.dispatch('lostpointercapture', { pointerId: id, clientX: 100, clientY: 300 }); },
    };
  }
  const nodes = Object.fromEntries(['stage', 'pet', 'sprite', 'tray', 'badge'].map((id) => [id, element()]));
  nodes.badge.hidden = true;
  const api = {};
  for (const event of ['Pet', 'Motion', 'Layout', 'Sessions', 'Usage', 'Wake', 'Landed']) {
    api[`on${event}`] = (fn) => { callbacks[event] = fn; };
  }
  for (const method of ['ready', 'setShape', 'dragStart', 'dragMove', 'dragEnd', 'activate', 'dismiss', 'traySize', 'contextMenu']) {
    api[method] = (...args) => calls.push([method, ...args]);
  }
  let player = null;
  class SpritePlayer {
    constructor() {
      this.transient = null;
      this.rects = shapeRects;
      player = this;
    }
    hitTest() { return true; }
    shapeRects() { return this.rects; }
    hold(state) { this.transient = state; }
    release() { this.transient = null; calls.push(['release']); }
    playOnce() {}
  }
  const context = {
    window: { pet: api, SpritePlayer, innerWidth, innerHeight, addEventListener() {} },
    document: { getElementById: (id) => nodes[id], createElement: element, documentElement: element() },
    setInterval() {},
    matchMedia: () => ({ addEventListener() {} }),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const event = (extra = {}) => ({ pointerId: 1, button: 0, buttons: 1, screenX: 100, screenY: 300, clientX: 100, clientY: 300, timeStamp: 10, preventDefault() {}, ...extra });
  return { calls, callbacks, nodes, pet: nodes.pet, event, element, player: () => player };
}

module.exports = { fixture };
