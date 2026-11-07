import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULTS,
  PRESETS,
  SHELL_OPTIONS,
  applyPreset,
  applySafeFallbacks,
  coerceOptionValue,
  defaultShellConfig,
  getByPath,
  isOptionActive,
  mergeShellConfig,
  setByPath,
  shellOption,
  validateShellConfig,
} from '../src/main/shell/options.mjs';

test('every descriptor is well formed and uniquely named', () => {
  const seen = new Set();
  for (const option of SHELL_OPTIONS) {
    assert.ok(!seen.has(option.path), `duplicate option ${option.path}`);
    seen.add(option.path);
    assert.ok(option.label && option.description, `${option.path} needs a label and description`);
    assert.ok(['boolean', 'number', 'string', 'enum'].includes(option.type), option.path);
    if (option.type === 'enum') {
      assert.ok(Array.isArray(option.choices) && option.choices.length > 1, option.path);
      assert.ok(option.choices.includes(option.default), `${option.path} default not in choices`);
    }
    if (option.dependsOn) {
      assert.ok(shellOption(option.dependsOn), `${option.path} dependsOn unknown ${option.dependsOn}`);
    }
    // The default must survive its own coercion, or the wizard could not re-enter it.
    assert.equal(coerceOptionValue(option, option.default).error, undefined, option.path);
  }
});

test('defaults are built from the descriptors and validate clean', () => {
  assert.deepEqual(defaultShellConfig(), DEFAULTS);
  for (const option of SHELL_OPTIONS) {
    assert.deepEqual(getByPath(DEFAULTS, option.path), option.default, option.path);
  }
  const { errors, warnings } = validateShellConfig(DEFAULTS);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('every preset validates clean', () => {
  for (const name of Object.keys(PRESETS)) {
    const { errors, warnings } = validateShellConfig(applyPreset(name));
    assert.deepEqual(errors, [], `${name} errors`);
    assert.deepEqual(warnings, [], `${name} warnings`);
  }
});

test('presets set the behaviour they advertise', () => {
  const tray = applyPreset('tray-app');
  assert.equal(tray.tray.enabled, true);
  assert.equal(tray.windows.closeAction, 'hide');
  assert.equal(tray.windows.onLastWindowClosed, 'keepRunning');

  const menuBar = applyPreset('menu-bar-only');
  assert.equal(menuBar.tray.showWindowOnLaunch, false);
  assert.equal(menuBar.dock, 'hidden');

  const multi = applyPreset('multi-window');
  assert.equal(multi.windows.multiWindow, true);
  assert.equal(multi.windows.onLastWindowClosed, 'quit');

  // A preset only moves the keys it names; the rest keeps the caller's values.
  const kept = applyPreset('tray-app', { ...structuredClone(DEFAULTS), launchAtLogin: true });
  assert.equal(kept.launchAtLogin, true);
});

test('merge fills defaults, keeps known values and reports the rest', () => {
  const { config, unknown, invalid } = mergeShellConfig({
    tray: { enabled: true },
    windows: { multiWindow: true, nope: 1 },
    alsoNope: 'x',
  });
  assert.equal(config.tray.enabled, true);
  assert.equal(config.windows.multiWindow, true);
  // Untouched keys fall back to their defaults rather than going undefined.
  assert.equal(config.windows.closeAction, 'close');
  assert.equal(config.tray.icon, DEFAULTS.tray.icon);
  assert.deepEqual(unknown.sort(), ['alsoNope', 'windows.nope']);
  assert.deepEqual(invalid, []);
});

test('merge rejects wrong types instead of letting them reach the shell', () => {
  const { config, invalid } = mergeShellConfig({
    tray: { enabled: 'perhaps' },
    windows: { maxWindows: 'lots', width: 99999 },
  });
  assert.equal(config.tray.enabled, false, 'falls back to the default');
  assert.equal(config.windows.maxWindows, DEFAULTS.windows.maxWindows);
  assert.equal(config.windows.width, DEFAULTS.windows.width);
  assert.equal(invalid.length, 3, invalid.join(' | '));
});

test('merge accepts a missing or empty config', () => {
  for (const input of [undefined, null, {}]) {
    assert.deepEqual(mergeShellConfig(input).config, DEFAULTS);
  }
});

test('validation catches configs with no way back to a window', () => {
  const unreachable = [
    { tray: { enabled: false, showWindowOnLaunch: false } },
    { tray: { enabled: false }, dock: 'hidden' },
  ];
  for (const input of unreachable) {
    const { config } = mergeShellConfig(input);
    assert.ok(validateShellConfig(config).errors.length > 0, JSON.stringify(input));
  }
});

test('validation warns about platform-specific traps without blocking them', () => {
  const { config } = mergeShellConfig({ windows: { closeAction: 'hide' } });
  const { errors, warnings } = validateShellConfig(config);
  assert.deepEqual(errors, [], 'legal on macOS, so not an error');
  assert.match(warnings.join(' '), /Windows and Linux/);
});

test('validation rejects a minimum larger than the default size', () => {
  const { config } = mergeShellConfig({ windows: { minWidth: 2000, minHeight: 1800 } });
  const { errors } = validateShellConfig(config);
  assert.equal(errors.length, 2, errors.join(' | '));
});

test('safe fallbacks make an unreachable config runnable', () => {
  const { config: merged } = mergeShellConfig({
    tray: { enabled: false, showWindowOnLaunch: false },
    dock: 'hidden',
    windows: { minWidth: 2000, minHeight: 1800 },
  });
  const { config, fixes } = applySafeFallbacks(merged);
  assert.equal(config.tray.showWindowOnLaunch, true);
  assert.equal(config.dock, 'visible');
  assert.equal(config.windows.width, 2000);
  assert.equal(config.windows.height, 1800);
  assert.ok(fixes.length >= 4, fixes.join(' | '));
  assert.deepEqual(validateShellConfig(config).errors, [], 'the result must be valid');
});

test('safe fallbacks pin maxWindows to 1 unless multiWindow is on', () => {
  assert.equal(applySafeFallbacks(DEFAULTS).config.windows.maxWindows, 1);
  const { config } = mergeShellConfig({ windows: { multiWindow: true, maxWindows: 4 } });
  assert.equal(applySafeFallbacks(config).config.windows.maxWindows, 4);
});

test('coercion accepts the spellings a person would type', () => {
  const bool = shellOption('tray.enabled');
  for (const yes of ['true', 'TRUE', 'y', 'yes', '1', 'on']) {
    assert.equal(coerceOptionValue(bool, yes).value, true, yes);
  }
  for (const no of ['false', 'n', 'no', '0', 'off']) {
    assert.equal(coerceOptionValue(bool, no).value, false, no);
  }
  assert.match(coerceOptionValue(bool, 'maybe').error, /true or false/);

  const num = shellOption('windows.maxWindows');
  assert.equal(coerceOptionValue(num, ' 4 ').value, 4);
  assert.match(coerceOptionValue(num, '0').error, /at least 1/);
  assert.match(coerceOptionValue(num, '999').error, /at most 64/);
  assert.match(coerceOptionValue(num, '2.5').error, /whole number/);

  const choice = shellOption('windows.closeAction');
  assert.equal(coerceOptionValue(choice, 'hide').value, 'hide');
  assert.match(coerceOptionValue(choice, 'minimise').error, /close, hide/);
});

test('dependent options are reported inactive so the wizard can skip them', () => {
  const trayIcon = shellOption('tray.icon');
  assert.equal(isOptionActive(trayIcon, DEFAULTS), false);
  assert.equal(isOptionActive(trayIcon, applyPreset('tray-app')), true);
  assert.equal(isOptionActive(shellOption('singleInstance'), DEFAULTS), true);
});

test('path helpers round trip nested values', () => {
  const object = {};
  setByPath(object, 'a.b.c', 7);
  assert.equal(getByPath(object, 'a.b.c'), 7);
  assert.equal(getByPath(object, 'a.b.missing'), undefined);
  assert.equal(getByPath(object, 'nope.deep.path'), undefined);
});
