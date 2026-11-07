/**
 * Bundle version rules, shared by the OTA installer and the release scripts.
 * `validateVersion` mirrors the check in `scripts/release-ota-bundle.mjs`: the manifest is
 * unsigned, so a version must never be able to escape the `bundles/` directory.
 */

/** @param {string} version */
export function isValidVersion(version) {
  return typeof version === 'string' && /^[0-9A-Za-z.+_-]{1,64}$/.test(version);
}

/** @param {string} version @returns {string} the version, for chaining */
export function validateVersion(version) {
  if (!isValidVersion(version)) throw new Error(`invalid bundle version ${JSON.stringify(version)}`);
  return version;
}

/** Dotted numeric comparison; pre-release and build suffixes are ignored. */
export function versionLt(a, b) {
  const parts = (value) =>
    String(value ?? '')
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => {
        const parsed = Number.parseInt(part, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
      });
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
