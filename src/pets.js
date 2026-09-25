'use strict';

// Finds pets in the Codex pet format (so pets made for ChatGPT/Codex work here too):
//   <dir>/<pet-id>/pet.json + spritesheet (PNG or WebP)
//   v1: 1536x1872, 8x9 cells of 192x208 (no look directions)
//   v2: 1536x2288, 8x11 cells of 192x208 (rows 9-10 = 16 look directions)
//
// Search order: bundled pets, ~/.claude-pet/pets, ${CODEX_HOME:-~/.codex}/pets.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ATLAS_SPECS = [
  { version: 1, width: 1536, height: 1872, rows: 9 },
  { version: 2, width: 1536, height: 2288, rows: 11 },
];
const MAX_SHEET_BYTES = 20 * 1024 * 1024;

function petRoots(appRoot) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [
    { source: 'built-in', dir: path.join(appRoot, 'pets') },
    { source: 'user', dir: path.join(os.homedir(), '.claude-pet', 'pets') },
    { source: 'codex', dir: path.join(codexHome, 'pets') },
  ];
}

function imageSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(40);
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'image/png' };
    }
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), type: 'image/webp' };
      }
      if (chunk === 'VP8L' && buf[20] === 0x2f) {
        const bits = buf.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), type: 'image/webp' };
      }
      if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, type: 'image/webp' };
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function loadPet(dir, source) {
  const manifestFile = path.join(dir, 'pet.json');
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const id = typeof manifest.id === 'string' && manifest.id ? manifest.id : path.basename(dir);
  const rel = typeof manifest.spritesheetPath === 'string' ? manifest.spritesheetPath : 'spritesheet.webp';
  const sheet = path.resolve(dir, rel);
  if (path.relative(dir, sheet).startsWith('..') || path.isAbsolute(path.relative(dir, sheet))) {
    throw new Error(`spritesheetPath escapes the pet folder`);
  }
  const st = fs.statSync(sheet);
  if (st.size > MAX_SHEET_BYTES) throw new Error('spritesheet is larger than 20 MiB');
  const size = imageSize(sheet);
  if (!size) throw new Error('spritesheet must be a PNG or WebP');
  const spec = ATLAS_SPECS.find((s) => s.width === size.width && s.height === size.height);
  if (!spec) {
    throw new Error(`spritesheet is ${size.width}x${size.height}; expected 1536x2288 (v2) or 1536x1872 (v1)`);
  }
  return {
    key: `${source}:${id}`,
    id,
    source,
    displayName: typeof manifest.displayName === 'string' && manifest.displayName ? manifest.displayName : id,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    version: spec.version,
    rows: spec.rows,
    pixelArt: manifest.pixelArt === true,
    sheet,
    mimeType: size.type,
    dir,
  };
}

function discoverPets(appRoot, log = () => {}) {
  const pets = [];
  for (const root of petRoots(appRoot)) {
    let names = [];
    try {
      names = fs.readdirSync(root.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      try {
        const pet = loadPet(path.join(root.dir, name), root.source);
        if (pet && !pets.some((p) => p.key === pet.key)) pets.push(pet);
      } catch (err) {
        log(`Skipping pet ${path.join(root.dir, name)}: ${err.message}`);
      }
    }
  }
  return pets;
}

module.exports = { ATLAS_SPECS, discoverPets, imageSize, loadPet, petRoots };
