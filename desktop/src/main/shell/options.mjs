/**
 * Shell options: the single source of truth for how the desktop shell behaves.
 *
 * Everything the launcher does around the app window — tray icon, multiple windows, what the
 * close button does, whether quitting the last window quits the app — is described by the
 * descriptor table below. That one table drives:
 *
 *   - `DEFAULTS` and the shape of `desktop/shell.config.json`
 *   - validation (including the combinations that would leave the app with no way back)
 *   - the `pnpm shell:config` wizard, its `--set` coercion and its `--list` output
 *   - the options table in `docs/SHELL_OPTIONS.md` (`pnpm shell:config --markdown`)
 *
 * Add an option here and every one of those follows. This module must stay free of Electron
 * imports: the CLI and the unit tests load it in plain Node.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SHELL_CONFIG_FILENAME = 'shell.config.json';

/**
 * @typedef {object} ShellOption
 * @property {string} path dotted path inside the config object
 * @property {'boolean'|'number'|'string'|'enum'} type
 * @property {boolean|number|string} default
 * @property {string[]} [choices] for `enum`
 * @property {number} [min] for `number`
 * @property {number} [max] for `number`
 * @property {string} label short name shown by the wizard
 * @property {string} description one or two sentences; also the docs text
 * @property {string} [dependsOn] option path that must be truthy for this one to have any effect
 * @property {'darwin'|'win32'|'linux'} [platform] only applies on that platform
 */

/** @type {ShellOption[]} */
export const SHELL_OPTIONS = [
  {
    path: 'singleInstance',
    type: 'boolean',
    default: true,
    label: 'Single instance',
    description:
      'A second launch focuses the running app instead of starting a second copy. Keep this on: two launchers would fight over the bundle server port.',
  },

  {
    path: 'tray.enabled',
    type: 'boolean',
    default: false,
    label: 'Tray icon',
    description:
      'Show a tray / menu-bar icon whose menu can open a window, open a new window, apply a downloaded update and quit.',
  },
  {
    path: 'tray.showWindowOnLaunch',
    type: 'boolean',
    default: true,
    dependsOn: 'tray.enabled',
    label: 'Open a window on launch',
    description:
      'With the tray on, `false` starts the app in the background with no window; the user opens one from the tray. The bundle server still starts.',
  },
  {
    path: 'tray.icon',
    type: 'string',
    default: 'launcher/tray-icon.png',
    dependsOn: 'tray.enabled',
    label: 'Tray icon file',
    description:
      'Relative to `desktop/`. A file whose name ends in `Template.png` is treated as a macOS template image, so it follows the menu bar in light and dark mode.',
  },
  {
    path: 'tray.tooltip',
    type: 'string',
    default: '',
    dependsOn: 'tray.enabled',
    label: 'Tray tooltip',
    description: 'Hover text for the tray icon. Empty uses the application name.',
  },
  {
    path: 'tray.leftClickOpensWindow',
    type: 'boolean',
    default: true,
    dependsOn: 'tray.enabled',
    label: 'Left click opens a window',
    description:
      'Windows and Linux: a left click opens or focuses a window instead of only showing the menu. On macOS a click always opens the menu.',
  },

  {
    path: 'windows.multiWindow',
    type: 'boolean',
    default: false,
    label: 'Multiple windows',
    description:
      'Allow more than one window, with a New Window menu item, an accelerator, and `desktopOta.openNewWindow()` for the app UI.',
  },
  {
    path: 'windows.newWindowAccelerator',
    type: 'string',
    default: 'CmdOrCtrl+N',
    dependsOn: 'windows.multiWindow',
    label: 'New window shortcut',
    description:
      'An Electron accelerator. On macOS it is bound to the File menu item; elsewhere the launcher matches the key combination itself, since the shell ships no menu bar.',
  },
  {
    path: 'windows.maxWindows',
    type: 'number',
    default: 8,
    min: 1,
    max: 64,
    dependsOn: 'windows.multiWindow',
    label: 'Maximum windows',
    description: 'Upper bound, so a held-down shortcut cannot open windows without end.',
  },
  {
    path: 'windows.closeAction',
    type: 'enum',
    choices: ['close', 'hide'],
    default: 'close',
    label: 'Close button behaviour',
    description:
      '`close` destroys the window. `hide` keeps it in memory and just hides it, which is what a tray app wants — reopening is then instant and the page keeps its state.',
  },
  {
    path: 'windows.onLastWindowClosed',
    type: 'enum',
    choices: ['quit', 'keepRunning'],
    default: 'quit',
    label: 'When the last window closes',
    description:
      '`quit` exits the app and stops the bundle server. `keepRunning` leaves it alive in the tray or macOS dock, so the next window opens without a boot.',
  },
  {
    path: 'windows.rememberState',
    type: 'boolean',
    default: true,
    label: 'Remember size and position',
    description:
      'Saves window bounds to `window-state.json` in the app data directory and restores them on the next launch, clamped to a display that still exists.',
  },
  {
    path: 'windows.width',
    type: 'number',
    default: 1280,
    min: 480,
    max: 10000,
    label: 'Default width',
    description: 'Width of a window with no remembered bounds.',
  },
  {
    path: 'windows.height',
    type: 'number',
    default: 840,
    min: 360,
    max: 10000,
    label: 'Default height',
    description: 'Height of a window with no remembered bounds.',
  },
  {
    path: 'windows.minWidth',
    type: 'number',
    default: 960,
    min: 320,
    max: 10000,
    label: 'Minimum width',
    description: 'The window cannot be resized narrower than this.',
  },
  {
    path: 'windows.minHeight',
    type: 'number',
    default: 640,
    min: 240,
    max: 10000,
    label: 'Minimum height',
    description: 'The window cannot be resized shorter than this.',
  },

  {
    path: 'dock',
    type: 'enum',
    choices: ['visible', 'hidden'],
    default: 'visible',
    platform: 'darwin',
    label: 'macOS dock icon',
    description:
      '`hidden` calls `app.dock.hide()`, making it a menu-bar-only app. It needs the tray, or there would be nothing left to click.',
  },
  {
    path: 'launchAtLogin',
    type: 'boolean',
    default: false,
    label: 'Launch at login',
    description:
      'Registers the app as a login item on macOS and Windows. Applied on every launch, so turning it off also unregisters it.',
  },
];

const OPTION_BY_PATH = new Map(SHELL_OPTIONS.map((option) => [option.path, option]));

export function shellOption(path) {
  return OPTION_BY_PATH.get(path) ?? null;
}

export function getByPath(object, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), object);
}

export function setByPath(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = object;
  for (const key of keys) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[last] = value;
  return object;
}

/** The full default config, built from the descriptors so the two can never drift. */
export function defaultShellConfig() {
  const config = {};
  for (const option of SHELL_OPTIONS) setByPath(config, option.path, option.default);
  return config;
}

export const DEFAULTS = Object.freeze(defaultShellConfig());

/** Parse a `--set path=value` string, or a wizard answer, into the option's own type. */
export function coerceOptionValue(option, raw) {
  if (raw === null || raw === undefined) return { error: `${option.path} needs a value` };
  const text = String(raw).trim();
  switch (option.type) {
    case 'boolean': {
      if (['true', 'yes', 'y', '1', 'on'].includes(text.toLowerCase())) return { value: true };
      if (['false', 'no', 'n', '0', 'off'].includes(text.toLowerCase())) return { value: false };
      return { error: `${option.path} must be true or false (got ${JSON.stringify(text)})` };
    }
    case 'number': {
      const value = Number(text);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        return { error: `${option.path} must be a whole number (got ${JSON.stringify(text)})` };
      }
      if (option.min !== undefined && value < option.min) {
        return { error: `${option.path} must be at least ${option.min}` };
      }
      if (option.max !== undefined && value > option.max) {
        return { error: `${option.path} must be at most ${option.max}` };
      }
      return { value };
    }
    case 'enum': {
      if (!option.choices.includes(text)) {
        return { error: `${option.path} must be one of ${option.choices.join(', ')}` };
      }
      return { value: text };
    }
    default:
      return { value: text };
  }
}

/**
 * Overlay a partial config on the defaults, dropping anything that is not a known option or has
 * the wrong type. A hand-edited file never takes the shell down; it is reported instead.
 *
 * @returns {{ config: object, unknown: string[], invalid: string[] }}
 */
export function mergeShellConfig(partial) {
  const config = defaultShellConfig();
  const unknown = [];
  const invalid = [];

  const walk = (node, prefix) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      unknown.push(prefix || '(root)');
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const option = OPTION_BY_PATH.get(path);
      if (!option) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) walk(value, path);
        else unknown.push(path);
        continue;
      }
      const coerced = coerceOptionValue(option, value);
      if (coerced.error) invalid.push(coerced.error);
      else setByPath(config, path, coerced.value);
    }
  };

  if (partial !== null && partial !== undefined) walk(partial, '');
  return { config, unknown, invalid };
}

/**
 * Catch the combinations that matter, above all the ones that leave a user with no window and no
 * way to get one back. Errors are things the CLI refuses to write; warnings are things that are
 * legal but behave differently per platform.
 *
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateShellConfig(config) {
  const errors = [];
  const warnings = [];
  const tray = config.tray ?? {};
  const windows = config.windows ?? {};

  if (!tray.enabled && tray.showWindowOnLaunch === false) {
    errors.push(
      'tray.showWindowOnLaunch=false needs tray.enabled=true — the app would start with no window and no tray icon.',
    );
  }
  if (!tray.enabled && config.dock === 'hidden') {
    errors.push(
      'dock=hidden needs tray.enabled=true — on macOS there would be no dock icon and no tray icon to click.',
    );
  }
  if (!tray.enabled && windows.closeAction === 'hide') {
    warnings.push(
      'windows.closeAction=hide without a tray: on macOS the dock icon still reopens the window, but on Windows and Linux the app becomes unreachable. Turn on tray.enabled for a cross-platform tray app.',
    );
  }
  if (!tray.enabled && windows.onLastWindowClosed === 'keepRunning') {
    warnings.push(
      'windows.onLastWindowClosed=keepRunning without a tray: reachable from the macOS dock, but on Windows and Linux it leaves a process with no window.',
    );
  }
  if (windows.minWidth > windows.width) {
    errors.push(`windows.minWidth (${windows.minWidth}) cannot exceed windows.width (${windows.width}).`);
  }
  if (windows.minHeight > windows.height) {
    errors.push(
      `windows.minHeight (${windows.minHeight}) cannot exceed windows.height (${windows.height}).`,
    );
  }
  if (windows.multiWindow && windows.closeAction === 'hide') {
    warnings.push(
      'windows.closeAction=hide with multiWindow keeps every closed window in memory; they are only reachable again through the tray.',
    );
  }

  return { errors, warnings };
}

/**
 * Make a config safe to run. Applied after validation so a hand-edited or outdated file can never
 * produce an app the user cannot reach; the original problem is still reported by the caller.
 */
export function applySafeFallbacks(config) {
  const fixes = [];
  const next = structuredClone(config);

  if (!next.tray.enabled && next.tray.showWindowOnLaunch === false) {
    next.tray.showWindowOnLaunch = true;
    fixes.push('forcing tray.showWindowOnLaunch=true (no tray to open a window from)');
  }
  if (!next.tray.enabled && next.dock === 'hidden') {
    next.dock = 'visible';
    fixes.push('forcing dock=visible (no tray to reach the app from)');
  }
  if (next.windows.minWidth > next.windows.width) {
    next.windows.width = next.windows.minWidth;
    fixes.push(`raising windows.width to ${next.windows.width}`);
  }
  if (next.windows.minHeight > next.windows.height) {
    next.windows.height = next.windows.minHeight;
    fixes.push(`raising windows.height to ${next.windows.height}`);
  }
  if (!next.windows.multiWindow) next.windows.maxWindows = 1;

  return { config: next, fixes };
}

/**
 * Read `desktop/shell.config.json` (or the file named by an env override) and return a config
 * that is always safe to run, plus everything worth logging about it.
 */
export function loadShellConfig(baseDir, overridePath = null) {
  const file = overridePath || join(baseDir, SHELL_CONFIG_FILENAME);
  let partial = null;
  let readError = null;
  let found = false;
  if (existsSync(file)) {
    found = true;
    try {
      partial = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      readError = `${file}: ${err.message}`;
    }
  }

  const { config: merged, unknown, invalid } = mergeShellConfig(partial ?? {});
  const { errors, warnings } = validateShellConfig(merged);
  const { config, fixes } = applySafeFallbacks(merged);

  return { config, file, found, readError, unknown, invalid, errors, warnings, fixes };
}

/**
 * Ready-made combinations. `pnpm shell:config --preset <name>` writes one; they are the fastest
 * way to set the shell up when scaffolding, and each one validates clean.
 */
export const PRESETS = {
  'single-window': {
    label: 'One window, quit on close (default)',
    description: 'Tauri-parity behaviour: a single window, and closing it exits the app.',
    values: {
      'tray.enabled': false,
      'windows.multiWindow': false,
      'windows.closeAction': 'close',
      'windows.onLastWindowClosed': 'quit',
      dock: 'visible',
    },
  },
  'multi-window': {
    label: 'Multiple windows, quit when the last one closes',
    description: 'A document-style app: Cmd/Ctrl+N opens another window; closing them all exits.',
    values: {
      'tray.enabled': false,
      'windows.multiWindow': true,
      'windows.closeAction': 'close',
      'windows.onLastWindowClosed': 'quit',
      dock: 'visible',
    },
  },
  'tray-app': {
    label: 'Tray icon, close hides the window',
    description:
      'Stays resident in the tray. The close button hides the window instead of destroying it, so reopening is instant.',
    values: {
      'tray.enabled': true,
      'tray.showWindowOnLaunch': true,
      'windows.multiWindow': false,
      'windows.closeAction': 'hide',
      'windows.onLastWindowClosed': 'keepRunning',
      dock: 'visible',
    },
  },
  'menu-bar-only': {
    label: 'Background app: tray only, no dock icon, starts hidden',
    description:
      'Launches with no window and no macOS dock icon. Everything happens through the tray menu.',
    values: {
      'tray.enabled': true,
      'tray.showWindowOnLaunch': false,
      'windows.multiWindow': false,
      'windows.closeAction': 'hide',
      'windows.onLastWindowClosed': 'keepRunning',
      dock: 'hidden',
    },
  },
};

/** Apply a preset's values on top of `base` (defaults when omitted). */
export function applyPreset(name, base = defaultShellConfig()) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown preset ${JSON.stringify(name)}`);
  const config = structuredClone(base);
  for (const [path, value] of Object.entries(preset.values)) setByPath(config, path, value);
  return config;
}

/** True when the option has no effect given the rest of the config. */
export function isOptionActive(option, config) {
  if (!option.dependsOn) return true;
  return Boolean(getByPath(config, option.dependsOn));
}
