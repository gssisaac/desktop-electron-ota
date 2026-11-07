import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isValidVersion, validateVersion, versionLt } from '../src/main/version.mjs';

test('orders dotted versions', () => {
  assert.equal(versionLt('1.0.0', '1.0.1'), true);
  assert.equal(versionLt('1.2', '1.10'), true);
  assert.equal(versionLt('1.0.0', '1.0.0'), false);
  assert.equal(versionLt('2.0.0', '1.9.9'), false);
  assert.equal(versionLt('1.0.0-beta', '1.0.1'), true);
  assert.equal(versionLt('1.0.0', '1.0.0+build7'), false);
  assert.equal(versionLt('1.0', '1.0.1'), true);
});

test('accepts the versions release:ota allows', () => {
  for (const version of ['1.0.0', '2026.11.7', '1.0.0-rc.1', '1.0.0+build_7']) {
    assert.equal(isValidVersion(version), true, version);
  }
});

test('rejects versions that could escape the bundles directory', () => {
  for (const version of ['', '../evil', 'a/b', 'v1 2', 'x'.repeat(65), null, undefined, 1]) {
    assert.equal(isValidVersion(version), false, String(version));
    assert.throws(() => validateVersion(version), /invalid bundle version/);
  }
});
