'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { homeOf, homeDisplay, homePosition, validHome } = require('../src/home');

const main = { id: 1, label: 'LS32A80', workArea: { x: 0, y: 0, width: 2560, height: 1440 } };
const side = { id: 2, label: 'LG ULTRAFINE', workArea: { x: 2560, y: 0, width: 1235, height: 2195 } };

test('home is the place on the monitor, measured from its work area', () => {
  assert.deepEqual(homeOf({ x: 2600, y: 1448 }, side), { display: 2, label: 'LG ULTRAFINE', x: 40, y: 1448 });
  assert.deepEqual(homePosition({ display: 2, x: 40, y: 1448 }, side), { x: 2600, y: 1448 });
});

test('the pet keeps its place when the work area moves', () => {
  const home = homeOf({ x: 2600, y: 1448 }, side);
  const taskbarOnTop = { ...side, workArea: { ...side.workArea, y: 48, height: 2147 } };
  assert.deepEqual(homePosition(home, taskbarOnTop), { x: 2600, y: 1496 });
});

test('the home monitor is found by id, or by name when only one has it', () => {
  const home = homeOf({ x: 2600, y: 1448 }, side);
  assert.equal(homeDisplay(home, [main, side]), side);
  const sideReplugged = { ...side, id: 7 };
  assert.equal(homeDisplay(home, [main, sideReplugged]), sideReplugged);
  const twin = { ...side, id: 8, workArea: { ...side.workArea, x: 3795 } };
  assert.equal(homeDisplay(home, [main, sideReplugged, twin]), null);
  const unnamed = { ...side, id: 9, label: '' };
  assert.equal(homeDisplay(home, [main, unnamed]), null);
});

test('a monitor that is away, or no home at all, has nowhere to go', () => {
  const home = homeOf({ x: 2600, y: 1448 }, side);
  assert.equal(homeDisplay(home, [main]), null);
  assert.equal(homeDisplay(null, [main, side]), null);
  assert.equal(homeDisplay({ display: 2, x: 'left', y: 1448 }, [main, side]), null);
});

test('only a complete home counts', () => {
  assert.equal(validHome(homeOf({ x: 10, y: 20 }, main)), true);
  assert.equal(validHome({ display: 1, x: 10 }), false);
  assert.equal(validHome({ x: 10, y: 20 }), false);
  assert.equal(validHome(null), false);
  assert.equal(validHome('home'), false);
});
