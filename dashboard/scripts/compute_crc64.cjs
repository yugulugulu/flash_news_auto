#!/usr/bin/env node
// Compute CRC64-ECMA182 hash used by ChainThink admin (returns unsigned decimal string)
// Usage: node compute_crc64.js <file>

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: compute_crc64.js <file>');
  process.exit(1);
}

// Load vendor crc64.js (Emscripten bundle that exposes CRC64 global)
const crcPath = path.resolve(__dirname, '../vendor/crc64.js');
const code = fs.readFileSync(crcPath, 'utf8');

// Polyfill browser globals expected by the bundle
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

// Silence noisy logs from the bundle
const _log = console.log;
console.log = () => {};
try {
  // eslint-disable-next-line no-eval
  eval(code);
} finally {
  console.log = _log;
}

if (typeof CRC64 === 'undefined' || !CRC64.crc64) {
  console.error('CRC64 not available from vendor/crc64.js');
  process.exit(2);
}

const buf = fs.readFileSync(file);
const hash = CRC64.crc64(buf);
process.stdout.write(String(hash));
