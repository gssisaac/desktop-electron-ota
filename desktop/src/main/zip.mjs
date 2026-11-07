/**
 * Minimal, dependency-free zip reader for OTA bundles.
 *
 * The launcher must stay auditable and free of native modules, so instead of pulling an
 * archive library it reads the central directory itself and inflates each entry with
 * `node:zlib`. Only what `release-ota-bundle.mjs` produces is supported: stored and
 * deflated entries, zip64 sizes, and Unix permission bits (`zip -X` strips modes, so
 * `spawn-helper` is forced executable the way the Rust launcher did).
 *
 * Security rules, applied before anything is written:
 *  - no `..` component and no absolute path (zip slip)
 *  - every resolved path must stay inside the destination directory
 *  - encrypted entries and symlinks are rejected rather than silently mangled
 */
import { inflateRawSync } from 'node:zlib';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** The comment is up to 64 KiB, so the end-of-central-directory record is within that window. */
const EOCD_SEARCH_WINDOW = 0xffff + EOCD_MIN_SIZE;
const ZIP64_EXTRA_ID = 0x0001;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const UNIX_MADE_BY = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function readU64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('zip entry is too large');
  return Number(value);
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('not a zip archive (no end-of-central-directory record)');
}

/** @returns {{ entryCount: number, centralOffset: number }} */
function readDirectoryBounds(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  let entryCount = buffer.readUInt16LE(eocd + 10);
  let centralOffset = buffer.readUInt32LE(eocd + 16);

  // zip64: the 32-bit fields are saturated and the real values live in a separate record.
  const locator = eocd - 20;
  if (
    (entryCount === 0xffff || centralOffset === 0xffffffff) &&
    locator >= 0 &&
    buffer.readUInt32LE(locator) === EOCD64_LOCATOR_SIGNATURE
  ) {
    const eocd64 = readU64(buffer, locator + 8);
    if (eocd64 < 0 || eocd64 + 56 > buffer.length || buffer.readUInt32LE(eocd64) !== EOCD64_SIGNATURE) {
      throw new Error('zip64 end-of-central-directory record is unreadable');
    }
    entryCount = readU64(buffer, eocd64 + 32);
    centralOffset = readU64(buffer, eocd64 + 48);
  }
  if (centralOffset + 4 > buffer.length) throw new Error('zip central directory is out of bounds');
  return { entryCount, centralOffset };
}

function readZip64Extra(extra, entry) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    if (id === ZIP64_EXTRA_ID) {
      let at = 0;
      // Present only for the fields that were saturated, in this order.
      if (entry.uncompressedSize === 0xffffffff && at + 8 <= body.length) {
        entry.uncompressedSize = readU64(body, at);
        at += 8;
      }
      if (entry.compressedSize === 0xffffffff && at + 8 <= body.length) {
        entry.compressedSize = readU64(body, at);
        at += 8;
      }
      if (entry.localOffset === 0xffffffff && at + 8 <= body.length) {
        entry.localOffset = readU64(body, at);
      }
      return;
    }
    offset += 4 + size;
  }
}

/** Parse the central directory. Entry data is read lazily by `extractZip`. */
export function readEntries(buffer) {
  const { entryCount, centralOffset } = readDirectoryBounds(buffer);
  const entries = [];
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`zip central directory entry ${i} is malformed`);
    }
    const madeBy = buffer.readUInt16LE(offset + 4) >> 8;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const entry = {
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      flags,
      method,
      crc,
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42),
      unixMode: madeBy === UNIX_MADE_BY ? (externalAttributes >>> 16) & 0xffff : null,
    };
    readZip64Extra(buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength), entry);
    entries.push(entry);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryData(buffer, entry) {
  const { localOffset } = entry;
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`zip local header for ${entry.name} is malformed`);
  }
  // The local header repeats name and extra with its own lengths; trust those for the data start.
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error(`zip entry ${entry.name} is truncated`);
  const raw = buffer.subarray(start, end);

  let data;
  if (entry.method === METHOD_STORE) data = raw;
  else if (entry.method === METHOD_DEFLATE) data = inflateRawSync(raw);
  else throw new Error(`zip entry ${entry.name} uses unsupported compression method ${entry.method}`);

  if (data.length !== entry.uncompressedSize) {
    throw new Error(`zip entry ${entry.name} has the wrong size (${data.length} ≠ ${entry.uncompressedSize})`);
  }
  if (crc32(data) !== entry.crc) throw new Error(`zip entry ${entry.name} failed its CRC-32 check`);
  return data;
}

/** Reject zip slip, absolute paths and Windows drive letters before touching the disk. */
function safeJoin(destRoot, name) {
  if (name.includes('\0')) throw new Error(`zip slip rejected: ${name}`);
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`zip slip rejected: ${name}`);
  }
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error(`zip slip rejected: ${name}`);
  const out = resolve(destRoot, ...parts);
  if (out !== destRoot && !out.startsWith(destRoot + sep)) {
    throw new Error(`zip slip rejected: ${name}`);
  }
  return out;
}

/**
 * Replace `dest` with the archive's contents.
 *
 * @param {Buffer} buffer the whole archive, already SHA-256 + Ed25519 verified
 * @param {string} dest directory to (re)create
 * @returns {number} number of files written
 */
export function extractZip(buffer, dest) {
  const destRoot = resolve(dest);
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destRoot, { recursive: true });

  let written = 0;
  for (const entry of readEntries(buffer)) {
    if (entry.flags & FLAG_ENCRYPTED) throw new Error(`zip entry ${entry.name} is encrypted`);
    if (entry.unixMode !== null && (entry.unixMode & S_IFMT) === S_IFLNK) {
      throw new Error(`zip entry ${entry.name} is a symlink; OTA bundles must contain real files`);
    }
    const isDirectory = entry.name.endsWith('/') || entry.name.endsWith('\\');
    const outPath = safeJoin(destRoot, entry.name);
    if (isDirectory) {
      mkdirSync(outPath, { recursive: true });
      continue;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, entryData(buffer, entry));
    written += 1;
    if (process.platform === 'win32') continue;
    let mode = (entry.unixMode ?? 0) & 0o7777;
    if (mode === 0) mode = 0o644;
    // `zip -X` drops modes. node-pty's spawn-helper has to stay executable.
    if (outPath.endsWith(`${sep}spawn-helper`)) mode |= 0o755;
    chmodSync(outPath, mode);
  }
  return written;
}

/** Read one entry's bytes without extracting the archive (used for the seed `version` file). */
export function readZipEntry(buffer, name) {
  const entry = readEntries(buffer).find((candidate) => candidate.name === name);
  return entry ? entryData(buffer, entry) : null;
}
