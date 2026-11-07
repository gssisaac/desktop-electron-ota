import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cancelled, runWizard } from '../../scripts/shell-config.mjs';
import { DEFAULTS, applyPreset } from '../src/main/shell/options.mjs';

/**
 * Stand-in for readline. Answers are keyed by what the wizard is asking about ('preset', or an
 * option path), so a test only scripts the answers it cares about; everything else gets an empty
 * line, which means "keep the current value".
 *
 * @param {Record<string, string | string[]>} answers
 */
function scriptedIo(answers = {}, { throwWhenExhausted = false } = {}) {
  const asked = [];
  const logged = [];
  const queues = new Map(
    Object.entries(answers).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  );
  return {
    asked,
    logged,
    closed: false,
    log: (line) => logged.push(String(line)),
    close() {
      this.closed = true;
    },
    async question(prompt) {
      // Prompts look like "  tray.enabled [false]: " or "  preset [keep current]: ".
      const key = prompt.trim().replace(/\s*\[.*$/, '');
      asked.push(key);
      const queue = queues.get(key);
      if (queue && queue.length > 0) return queue.shift();
      if (throwWhenExhausted) throw new Error('readline closed');
      return '';
    },
  };
}

const optionsAsked = (io) => io.asked.filter((key) => key !== 'preset');

test('picking a preset by number applies it', async () => {
  const io = scriptedIo({ preset: '3' });
  const config = await runWizard(DEFAULTS, io);
  assert.deepEqual(config, applyPreset('tray-app', DEFAULTS));
  assert.equal(io.closed, true, 'the wizard must close its input');
});

test('picking a preset by name applies it', async () => {
  const config = await runWizard(DEFAULTS, scriptedIo({ preset: 'menu-bar-only' }));
  assert.equal(config.dock, 'hidden');
  assert.equal(config.tray.showWindowOnLaunch, false);
  assert.equal(config.windows.closeAction, 'hide');
});

test('an unknown preset re-prompts', async () => {
  const io = scriptedIo({ preset: ['nope', '99', 'multi-window'] });
  const config = await runWizard(DEFAULTS, io);
  assert.equal(config.windows.multiWindow, true);
  assert.equal(io.asked.filter((key) => key === 'preset').length, 3);
  assert.match(io.logged.join('\n'), /pick 1–4 or a preset name/);
});

test('an empty preset answer keeps the current settings', async () => {
  const start = applyPreset('multi-window', DEFAULTS);
  const config = await runWizard(start, scriptedIo());
  assert.deepEqual(config, start, 'pressing Enter through the whole wizard changes nothing');
});

test('tray questions are skipped with no tray and asked with one', async () => {
  const withoutTray = scriptedIo();
  await runWizard(DEFAULTS, withoutTray);
  assert.ok(optionsAsked(withoutTray).includes('tray.enabled'));
  assert.ok(!optionsAsked(withoutTray).includes('tray.icon'), 'no tray, no icon question');
  assert.ok(!optionsAsked(withoutTray).includes('windows.maxWindows'), 'single window');

  const withTray = scriptedIo({ preset: 'tray-app' });
  await runWizard(DEFAULTS, withTray);
  assert.ok(optionsAsked(withTray).includes('tray.icon'));
  assert.ok(optionsAsked(withTray).includes('tray.leftClickOpensWindow'));
});

test('answering tray.enabled unlocks the tray questions in the same run', async () => {
  const io = scriptedIo({ 'tray.enabled': 'y' });
  const config = await runWizard(DEFAULTS, io);
  assert.equal(config.tray.enabled, true);
  assert.ok(optionsAsked(io).includes('tray.icon'), optionsAsked(io).join(' '));
});

test('answering multiWindow unlocks the window questions in the same run', async () => {
  const io = scriptedIo({ 'windows.multiWindow': 'yes', 'windows.maxWindows': '3' });
  const config = await runWizard(DEFAULTS, io);
  assert.equal(config.windows.multiWindow, true);
  assert.equal(config.windows.maxWindows, 3);
});

test('a bad answer re-prompts instead of being written', async () => {
  const io = scriptedIo({ 'windows.closeAction': ['minimise', 'hide'] });
  const config = await runWizard(DEFAULTS, io);
  assert.equal(config.windows.closeAction, 'hide');
  assert.match(io.logged.join('\n'), /must be one of close, hide/);
});

test('closed input cancels without a config', async () => {
  await assert.rejects(
    () => runWizard(DEFAULTS, scriptedIo({}, { throwWhenExhausted: true })),
    Cancelled,
  );
});
