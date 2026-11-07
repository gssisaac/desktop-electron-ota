import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { test } from 'node:test';

import {
  DESKTOP_ROOT,
  REQUIRED_ASSETS,
  desktopPath,
} from '../src/main/shell/assets.mjs';
import { DEFAULTS } from '../src/main/shell/options.mjs';

test('DESKTOP_ROOT points at the desktop package', () => {
  assert.equal(basename(DESKTOP_ROOT.replace(/\/$/, '')), 'desktop');
  assert.ok(existsSync(desktopPath('package.json')));
  assert.ok(existsSync(desktopPath('electron-builder.yml')));
});

// A module moved between directories used to break these silently: the window came up blank and
// `window.desktopOta` was undefined on the page.
test('every file the shell loads at runtime exists', () => {
  for (const [name, path] of Object.entries(REQUIRED_ASSETS)) {
    assert.ok(existsSync(path), `${name} is missing: ${path}`);
    assert.ok(statSync(path).isFile(), `${name} is not a file: ${path}`);
  }
});

test('the default tray icon ships with the boilerplate', () => {
  const icon = desktopPath(DEFAULTS.tray.icon);
  assert.ok(existsSync(icon), `tray.icon default is missing: ${icon}`);
  assert.ok(statSync(icon).size > 0);
});

test('the shipped shell.config.json matches the schema', async () => {
  const { mergeShellConfig, validateShellConfig } = await import('../src/main/shell/options.mjs');
  const { readFileSync } = await import('node:fs');
  const file = desktopPath('shell.config.json');
  assert.ok(existsSync(file), 'shell.config.json should be committed');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const { config, unknown, invalid } = mergeShellConfig(parsed);
  assert.deepEqual(unknown, [], 'no stale keys');
  assert.deepEqual(invalid, [], 'no wrong types');
  assert.deepEqual(validateShellConfig(config).errors, []);
});
