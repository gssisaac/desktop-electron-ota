#!/usr/bin/env node
/**
 * Read and change the desktop shell options in `desktop/shell.config.json` — tray icon,
 * multiple windows, what the close button does, whether the last window closing quits the app.
 *
 * Both halves of the requirement go through this one command: pick the behaviour while
 * scaffolding, and change it later in a project that already exists.
 *
 *   pnpm shell:config                          interactive wizard (current values as defaults)
 *   pnpm shell:config --list                   show the effective config, with descriptions
 *   pnpm shell:config --preset tray-app        apply a ready-made combination
 *   pnpm shell:config --preset list            list the presets
 *   pnpm shell:config --set tray.enabled=true --set windows.multiWindow=true
 *   pnpm shell:config --reset                  back to the defaults
 *   pnpm shell:config --markdown               the options table for docs/SHELL_OPTIONS.md
 *
 * Nothing here needs a rebuild to take effect in `pnpm dev:desktop`; an already installed app
 * picks the change up on its next `pnpm release:desktop`.
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PRESETS,
  SHELL_CONFIG_FILENAME,
  SHELL_OPTIONS,
  applyPreset,
  coerceOptionValue,
  defaultShellConfig,
  getByPath,
  isOptionActive,
  mergeShellConfig,
  setByPath,
  shellOption,
  validateShellConfig,
} from '../desktop/src/main/shell/options.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = join(root, 'desktop');
const configPath = join(desktopRoot, SHELL_CONFIG_FILENAME);

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
function valuesOf(flag) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]);
    else if (args[i].startsWith(`${flag}=`)) out.push(args[i].slice(flag.length + 1));
  }
  return out;
}

function fail(message) {
  console.error(`[shell-config] ${message}`);
  process.exit(1);
}

function readCurrent() {
  if (!existsSync(configPath)) return defaultShellConfig();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    fail(`${configPath} is not valid JSON (${err.message}). Fix it or run --reset.`);
  }
  const { config, unknown, invalid } = mergeShellConfig(parsed);
  for (const message of invalid) console.warn(`[shell-config] ignoring: ${message}`);
  for (const path of unknown) console.warn(`[shell-config] unknown option in file: ${path}`);
  return config;
}

function describe(option, config) {
  const value = getByPath(config, option.path);
  const inactive = !isOptionActive(option, config);
  const platform = option.platform ? ` (${option.platform} only)` : '';
  const choices =
    option.type === 'enum'
      ? ` [${option.choices.join('|')}]`
      : option.type === 'number' && option.min !== undefined
        ? ` [${option.min}–${option.max}]`
        : '';
  return { value, inactive, platform, choices };
}

function printList(config) {
  const { errors, warnings } = validateShellConfig(config);
  console.log(`\n${existsSync(configPath) ? configPath : `${configPath} (missing — showing defaults)`}\n`);
  for (const option of SHELL_OPTIONS) {
    const { value, inactive, platform, choices } = describe(option, config);
    const flag = inactive ? ' · no effect with the current settings' : '';
    console.log(`  ${option.path}${choices}`);
    console.log(`    = ${JSON.stringify(value)}${platform}${flag}`);
    console.log(`    ${option.description}`);
    console.log();
  }
  for (const message of warnings) console.log(`  warning: ${message}`);
  for (const message of errors) console.log(`  ERROR:   ${message}`);
  if (errors.length === 0 && warnings.length === 0) console.log('  config is valid.\n');
  else console.log();
}

function printPresets() {
  console.log('\nPresets (pnpm shell:config --preset <name>):\n');
  for (const [name, preset] of Object.entries(PRESETS)) {
    console.log(`  ${name.padEnd(16)} ${preset.label}`);
    console.log(`  ${''.padEnd(16)} ${preset.description}\n`);
  }
}

/** The docs table, generated so `docs/SHELL_OPTIONS.md` cannot drift from the schema. */
function printMarkdown() {
  console.log('| Option | Type | Default | What it does |');
  console.log('|--------|------|---------|--------------|');
  for (const option of SHELL_OPTIONS) {
    const type =
      option.type === 'enum'
        ? option.choices.map((choice) => `\`${choice}\``).join(' \\| ')
        : option.type;
    const platform = option.platform ? ` **(${option.platform} only)**` : '';
    const depends = option.dependsOn ? ` Needs \`${option.dependsOn}\`.` : '';
    console.log(
      `| \`${option.path}\` | ${type} | \`${JSON.stringify(option.default)}\` | ${option.description}${depends}${platform} |`,
    );
  }
}

function write(config, { force = false } = {}) {
  const { errors, warnings } = validateShellConfig(config);
  for (const message of warnings) console.warn(`[shell-config] warning: ${message}`);
  if (errors.length > 0) {
    for (const message of errors) console.error(`[shell-config] error: ${message}`);
    if (!force) {
      fail('refusing to write a config that would leave the app unreachable (use --force to override)');
    }
    console.warn('[shell-config] --force: writing anyway; the launcher will fall back at runtime');
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`[shell-config] wrote ${configPath}`);
  const summary = [
    `tray=${config.tray.enabled}`,
    `multiWindow=${config.windows.multiWindow}`,
    `closeAction=${config.windows.closeAction}`,
    `onLastWindowClosed=${config.windows.onLastWindowClosed}`,
    `dock=${config.dock}`,
  ].join('  ');
  console.log(`[shell-config] ${summary}`);
  if (config.tray.enabled) {
    const icon = join(desktopRoot, config.tray.icon);
    if (!existsSync(icon)) {
      console.warn(
        `[shell-config] tray icon ${icon} does not exist — the launcher will fall back to build/icon.png`,
      );
    }
  }
}

/** Thrown when the user ends the wizard with Ctrl-D or Ctrl-C; nothing is written. */
export class Cancelled extends Error {}

async function ask(io, prompt) {
  try {
    return (await io.question(prompt)).trim();
  } catch {
    // readline rejects when stdin closes.
    throw new Cancelled();
  }
}

/**
 * Walk the options, starting from a preset. `io` is anything with `question(prompt)`, `close()`
 * and `log(line)` — readline in the CLI, a scripted stub in the unit tests.
 *
 * @param {object} config current values, used as the defaults
 * @param {{ question: (prompt: string) => Promise<string>, close?: () => void, log?: (line: string) => void }} io
 */
export async function runWizard(config, io) {
  const console_ = { log: io.log ?? ((line) => console_.log(line)) };
  let next = structuredClone(config);
  try {
    // Start from a preset so scaffolding is two keystrokes, then fine-tune from there.
    const names = Object.keys(PRESETS);
    console_.log('\nStart from a preset, or press Enter to keep the current settings:\n');
    names.forEach((name, index) => console_.log(`  ${index + 1}. ${name} — ${PRESETS[name].label}`));
    console_.log();
    for (;;) {
      const answer = await ask(io, '  preset [keep current]: ');
      if (!answer) break;
      const byIndex = names[Number(answer) - 1];
      const name = PRESETS[answer] ? answer : byIndex;
      if (!name) {
        console_.log(`  pick 1–${names.length} or a preset name`);
        continue;
      }
      next = applyPreset(name, next);
      console_.log(`  → ${name}`);
      break;
    }

    console_.log('\nOptions. Enter keeps the value shown in [brackets].\n');
    for (const option of SHELL_OPTIONS) {
      // Skip questions the answers so far make irrelevant (e.g. tray.* with no tray).
      if (!isOptionActive(option, next)) continue;
      const current = getByPath(next, option.path);
      const hint =
        option.type === 'enum'
          ? ` (${option.choices.join(' / ')})`
          : option.type === 'boolean'
            ? ' (y/n)'
            : '';
      const platform = option.platform ? ` [${option.platform} only]` : '';
      console_.log(`${option.label}${platform}${hint}`);
      console_.log(`  ${option.description}`);
      for (;;) {
        const answer = await ask(io, `  ${option.path} [${JSON.stringify(current)}]: `);
        if (!answer) break;
        const coerced = coerceOptionValue(option, answer);
        if (coerced.error) {
          console_.log(`  ${coerced.error}`);
          continue;
        }
        setByPath(next, option.path, coerced.value);
        break;
      }
      console_.log();
    }
  } finally {
    io.close?.();
  }
  return next;
}

async function main() {
  if (has('--markdown')) {
    printMarkdown();
    return;
  }

  const presetArgs = valuesOf('--preset');
  if (presetArgs.includes('list') || has('--presets')) {
    printPresets();
    return;
  }

  if (has('--list')) {
    printList(readCurrent());
    return;
  }

  if (has('--reset')) {
    write(defaultShellConfig(), { force: has('--force') });
    return;
  }

  let config = readCurrent();
  let changed = false;

  if (presetArgs.length > 0) {
    const name = presetArgs[presetArgs.length - 1];
    if (!PRESETS[name]) {
      printPresets();
      fail(`unknown preset ${JSON.stringify(name)}`);
    }
    config = applyPreset(name, config);
    changed = true;
    console.log(`[shell-config] preset ${name}: ${PRESETS[name].label}`);
  }

  for (const assignment of valuesOf('--set')) {
    const eq = assignment.indexOf('=');
    if (eq === -1) fail(`--set needs path=value (got ${JSON.stringify(assignment)})`);
    const path = assignment.slice(0, eq).trim();
    const raw = assignment.slice(eq + 1);
    const option = shellOption(path);
    if (!option) {
      fail(`unknown option ${JSON.stringify(path)}. Run --list to see them all.`);
    }
    const coerced = coerceOptionValue(option, raw);
    if (coerced.error) fail(coerced.error);
    setByPath(config, path, coerced.value);
    changed = true;
  }

  if (changed) {
    write(config, { force: has('--force') });
    return;
  }

  if (!process.stdin.isTTY) {
    printList(config);
    console.log('[shell-config] not a terminal: use --set, --preset or --list');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => rl.close());
  try {
    write(await runWizard(config, rl), { force: has('--force') });
  } catch (err) {
    if (err instanceof Cancelled) {
      console.log('\n[shell-config] cancelled; nothing written');
      process.exit(1);
    }
    throw err;
  }
}

const isDirectRun =
  process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) await main();
