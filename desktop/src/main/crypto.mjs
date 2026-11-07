/**
 * Ed25519 + SHA-256 verification for full-stack OTA bundles.
 *
 * Replace the public keys below with your production keys (see docs/OTA_DEPLOYMENT.md).
 * `scripts/ota-credentials.mjs` keeps each constant in sync with its signing key on the
 * first `pnpm release:ota`, so a key change always needs a launcher rebuild.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * 32-byte Ed25519 public keys (hex). macOS and Windows bundles are signed with separate keys
 * (`.ota/credentials.env`, `.ota/credentials-windows.env`) because each platform has its own
 * release feed and native modules.
 */
export const OTA_PUBLIC_KEY_HEX_DARWIN =
  '0000000000000000000000000000000000000000000000000000000000000000';
export const OTA_PUBLIC_KEY_HEX_WIN32 =
  '0000000000000000000000000000000000000000000000000000000000000000';

/** The key this platform's bundles are signed with. */
export function otaPublicKeyHex() {
  return process.platform === 'win32' ? OTA_PUBLIC_KEY_HEX_WIN32 : OTA_PUBLIC_KEY_HEX_DARWIN;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Wrap a raw 32-byte Ed25519 public key in the SPKI DER header `node:crypto` expects. */
function verifyingKey(publicKeyHex) {
  const raw = Buffer.from(publicKeyHex, 'hex');
  if (raw.length !== 32) throw new Error('embedded public key must be 32 bytes');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

/**
 * Throws unless `bytes` match the manifest's digest and carry a valid signature from the
 * embedded key. Both checks run before a single byte is written to disk.
 */
export function verifyBundle(bytes, expectedSha256, signatureHex) {
  const computed = sha256Hex(bytes);
  const expected = String(expectedSha256 ?? '').trim().toLowerCase();
  if (computed !== expected) {
    throw new Error(`SHA-256 mismatch (expected ${expected}, got ${computed})`);
  }

  const key = verifyingKey(otaPublicKeyHex());
  const signature = Buffer.from(String(signatureHex ?? '').trim(), 'hex');
  if (signature.length !== 64) throw new Error('signature must be 64 bytes');
  if (!verify(null, bytes, key, signature)) throw new Error('Ed25519 verification failed');
}
