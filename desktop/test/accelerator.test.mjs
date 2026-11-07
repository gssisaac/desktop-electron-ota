import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchesChord, parseAccelerator } from '../src/main/shell/accelerator.mjs';

const keyDown = (key, mods = {}) => ({
  type: 'keyDown',
  key,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods,
});

test('CmdOrCtrl resolves per platform', () => {
  assert.deepEqual(parseAccelerator('CmdOrCtrl+N', 'darwin'), {
    ctrl: false,
    meta: true,
    shift: false,
    alt: false,
    key: 'n',
  });
  assert.deepEqual(parseAccelerator('CmdOrCtrl+N', 'win32'), {
    ctrl: true,
    meta: false,
    shift: false,
    alt: false,
    key: 'n',
  });
});

test('accepts the modifier spellings Electron accepts', () => {
  for (const accelerator of ['Ctrl+Shift+T', 'Control+Shift+T']) {
    assert.deepEqual(parseAccelerator(accelerator, 'win32'), {
      ctrl: true,
      meta: false,
      shift: true,
      alt: false,
      key: 't',
    });
  }
  assert.equal(parseAccelerator('Alt+N', 'win32').alt, true);
  assert.equal(parseAccelerator('Option+N', 'darwin').alt, true);
  assert.equal(parseAccelerator('Cmd+N', 'darwin').meta, true);
});

test('rejects nonsense rather than binding something surprising', () => {
  const nonsense = ['', '   ', 'Hyper+N', 'CmdOrCtrl+', '+N', 'CmdOrCtrl++N', 'CmdOrCtrl+Shift', 'N', null, undefined, 42];
  for (const bad of nonsense) {
    assert.equal(parseAccelerator(bad, 'win32'), null, String(bad));
  }
});

test('matches only the exact chord', () => {
  const chord = parseAccelerator('CmdOrCtrl+N', 'win32');
  assert.equal(matchesChord(chord, keyDown('n', { control: true })), true);
  assert.equal(matchesChord(chord, keyDown('N', { control: true })), true, 'case-insensitive');
  // Extra modifiers must not trigger it, or Ctrl+Shift+N would open a window too.
  assert.equal(matchesChord(chord, keyDown('n', { control: true, shift: true })), false);
  assert.equal(matchesChord(chord, keyDown('n', { control: true, alt: true })), false);
  assert.equal(matchesChord(chord, keyDown('n')), false, 'no modifier');
  assert.equal(matchesChord(chord, keyDown('m', { control: true })), false, 'wrong key');
});

test('ignores key-up and missing input', () => {
  const chord = parseAccelerator('CmdOrCtrl+N', 'win32');
  assert.equal(matchesChord(chord, { ...keyDown('n', { control: true }), type: 'keyUp' }), false);
  assert.equal(matchesChord(chord, null), false);
  assert.equal(matchesChord(null, keyDown('n', { control: true })), false);
});
