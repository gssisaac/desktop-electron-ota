import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { crc32, extractZip, readEntries, readZipEntry } from '../src/main/zip.mjs';

function workdir() {
  return mkdtempSync(join(tmpdir(), 'ota-zip-test-'));
}

/** Build a bundle-shaped tree and zip it the way `release-ota-bundle.mjs` does. */
function fixtureZip() {
  const work = workdir();
  const src = join(work, 'bundle');
  mkdirSync(join(src, 'node_modules', 'node-pty', 'build', 'Release'), { recursive: true });
  mkdirSync(join(src, '.next-standalone', 'static'), { recursive: true });
  writeFileSync(join(src, 'server.js'), 'require("./app");\n');
  writeFileSync(join(src, '.next-standalone', 'static', 'app.css'), 'body{color:red}'.repeat(400));
  const helper = join(src, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper');
  writeFileSync(helper, '#!/bin/sh\nexit 0\n');
  chmodSync(helper, 0o644);
  const zip = join(work, 'bundle.zip');
  const result = spawnSync('zip', ['-r', '-q', '-X', zip, '.'], { cwd: src });
  assert.equal(result.status, 0, 'zip CLI must be available for this test');
  return { work, zip };
}

test('crc32 matches known values', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('extracts a real zip -X archive and keeps spawn-helper executable', (t) => {
  const { work, zip } = fixtureZip();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const dest = join(work, 'out');

  const written = extractZip(readFileSync(zip), dest);
  assert.ok(written >= 3, `expected at least 3 files, got ${written}`);
  assert.equal(readFileSync(join(dest, 'server.js'), 'utf8'), 'require("./app");\n');
  assert.equal(
    readFileSync(join(dest, '.next-standalone', 'static', 'app.css'), 'utf8').length,
    'body{color:red}'.repeat(400).length,
  );
  const helper = join(dest, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper');
  assert.equal((statSync(helper).mode & 0o111) !== 0, true, 'spawn-helper must stay executable');
});

test('extraction replaces whatever was in the destination', (t) => {
  const { work, zip } = fixtureZip();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const dest = join(work, 'out');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'stale.txt'), 'old');

  extractZip(readFileSync(zip), dest);
  assert.equal(statSync(join(dest, 'server.js')).isFile(), true);
  assert.throws(() => statSync(join(dest, 'stale.txt')));
});

test('reads a single entry without extracting', (t) => {
  const { work, zip } = fixtureZip();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  assert.equal(readZipEntry(readFileSync(zip), 'server.js')?.toString(), 'require("./app");\n');
  assert.equal(readZipEntry(readFileSync(zip), 'nope.js'), null);
});

test('reads stored (uncompressed) entries', (t) => {
  const { work } = { work: workdir() };
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const src = join(work, 'bundle');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'server.js'), 'stored\n');
  const zip = join(work, 'stored.zip');
  assert.equal(spawnSync('zip', ['-0', '-r', '-q', '-X', zip, '.'], { cwd: src }).status, 0);

  const entries = readEntries(readFileSync(zip));
  assert.ok(entries.some((entry) => entry.method === 0));
  extractZip(readFileSync(zip), join(work, 'out'));
  assert.equal(readFileSync(join(work, 'out', 'server.js'), 'utf8'), 'stored\n');
});

/** Hand-rolled archive so the path can be anything, including a traversal attempt. */
function singleEntryZip(name, content, { unixMode = 0o644 } = {}) {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = Buffer.from(content);
  const deflated = deflateRawSync(data);
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(((unixMode & 0xffff) * 0x10000) >>> 0, 38);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBuf.length + deflated.length;
  const centralSize = central.length + nameBuf.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBuf, deflated, central, nameBuf, eocd]);
}

test('rejects zip slip', (t) => {
  const work = workdir();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  for (const name of ['../escape.js', 'a/../../escape.js', '/etc/passwd', 'C:/Windows/x.js', '..\\escape.js']) {
    assert.throws(
      () => extractZip(singleEntryZip(name, 'pwned'), join(work, 'out')),
      /zip slip rejected/,
      name,
    );
  }
});

test('rejects symlink entries', (t) => {
  const work = workdir();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  assert.throws(
    () => extractZip(singleEntryZip('link', '/etc/passwd', { unixMode: 0o120777 }), join(work, 'out')),
    /symlink/,
  );
});

test('rejects a corrupted entry', (t) => {
  const work = workdir();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const name = 'server.js';
  const zip = singleEntryZip(name, 'hello world hello world hello world');
  // Flip a byte inside the deflate stream (just past the local header + name); CRC must catch it.
  const broken = Buffer.from(zip);
  broken[30 + name.length + 3] ^= 0xff;
  assert.throws(() => extractZip(broken, join(work, 'out')), /server\.js/);
});

test('rejects data that is not a zip', (t) => {
  const work = workdir();
  t.after(() => rmSync(work, { recursive: true, force: true }));
  assert.throws(
    () => extractZip(Buffer.alloc(512, 7), join(work, 'out')),
    /not a zip archive/,
  );
});
