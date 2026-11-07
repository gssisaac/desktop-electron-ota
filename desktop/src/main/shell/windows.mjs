/**
 * Window manager. Replaces the old single-window module: one window or many, driven entirely by
 * the shell options, so `startup.mjs` never has to know which mode it is in.
 *
 * Every window shows the bundled launcher page (`desktop/launcher`) until the bundle server is
 * healthy; from then on `setTargetUrl()` holds the server origin and new windows open straight
 * there. All windows share one preload, so the app served from 127.0.0.1 can read OTA state and
 * trigger a refresh.
 */
import { BrowserWindow, screen, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '../log.mjs';
import { appDataDir } from '../paths.mjs';
import { matchesChord, parseAccelerator } from './accelerator.mjs';
import { LAUNCHER_PAGE, PRELOAD_SCRIPT } from './assets.mjs';
import { DEFAULTS } from './options.mjs';

const STATE_FILE = 'window-state.json';
/** Each extra window steps down and right so a new one is never hidden behind the last. */
const CASCADE_STEP = 24;

/** Insertion-ordered, so the last entry is the most recently created window. */
const windows = new Set();
let options = DEFAULTS;
let newWindowChord = null;
/** `null` while the launcher page is showing; the server origin once the bundle is healthy. */
let targetUrl = null;
/** Set on `before-quit` so a `closeAction: 'hide'` window does not block the quit. */
let quitting = false;

export function initWindows(shellOptions) {
  options = shellOptions;
  newWindowChord =
    process.platform === 'darwin' || !shellOptions.windows.multiWindow
      ? null
      : parseAccelerator(shellOptions.windows.newWindowAccelerator);
  if (shellOptions.windows.multiWindow && process.platform !== 'darwin' && !newWindowChord) {
    log.warn(
      `windows.newWindowAccelerator ${JSON.stringify(shellOptions.windows.newWindowAccelerator)} could not be parsed; New Window has no shortcut`,
    );
  }
}

export function setQuitting(value) {
  quitting = value;
}

export function isQuitting() {
  return quitting;
}

/** Live windows, oldest first. */
export function allWindows() {
  return [...windows].filter((window) => !window.isDestroyed());
}

export function windowCount() {
  return allWindows().length;
}

export function canOpenWindow() {
  if (windowCount() === 0) return true;
  if (!options.windows.multiWindow) return false;
  return windowCount() < options.windows.maxWindows;
}

function statePath() {
  return join(appDataDir(), STATE_FILE);
}

function readSavedBounds() {
  if (!options.windows.rememberState) return null;
  try {
    const file = statePath();
    if (!existsSync(file)) return null;
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const ok = ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(saved?.[key]));
    return ok ? saved : null;
  } catch {
    return null;
  }
}

function saveBounds(window) {
  if (!options.windows.rememberState || quitting) return;
  if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
  try {
    mkdirSync(appDataDir(), { recursive: true });
    writeFileSync(statePath(), `${JSON.stringify(window.getBounds(), null, 2)}\n`);
  } catch (err) {
    log.warn(`save window state: ${err.message}`);
  }
}

/** Keep a remembered rectangle on a display that still exists, and cascade extra windows. */
function nextBounds() {
  const { width, height } = options.windows;
  const saved = readSavedBounds();
  let bounds = saved
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : { x: undefined, y: undefined, width, height };

  if (bounds.x !== undefined) {
    const step = CASCADE_STEP * windowCount();
    bounds = { ...bounds, x: bounds.x + step, y: bounds.y + step };
    const area = screen.getDisplayMatching(bounds).workArea;
    bounds.width = Math.min(bounds.width, area.width);
    bounds.height = Math.min(bounds.height, area.height);
    bounds.x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width);
    bounds.y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height);
  }
  return bounds;
}

function loadInto(window) {
  const load = targetUrl ? window.loadURL(targetUrl) : window.loadFile(LAUNCHER_PAGE);
  return load.catch((err) => {
    log.error(`failed to load ${targetUrl ?? LAUNCHER_PAGE}: ${err.message}`);
  });
}

/**
 * Create a window. Returns the existing one instead when the config allows only a single window.
 *
 * @param {{ show?: boolean, onNewWindowRequest?: () => void }} [opts]
 * @returns {BrowserWindow | null} null when `maxWindows` is reached
 */
export function openWindow({ show = true, onNewWindowRequest } = {}) {
  const existing = allWindows();
  if (existing.length > 0 && !options.windows.multiWindow) {
    const window = existing[existing.length - 1];
    if (show) revealWindow(window);
    return window;
  }
  if (!canOpenWindow()) {
    log.warn(`not opening another window: windows.maxWindows is ${options.windows.maxWindows}`);
    return null;
  }

  const bounds = nextBounds();
  const window = new BrowserWindow({
    title: '__APP_NAME__',
    ...bounds,
    minWidth: options.windows.minWidth,
    minHeight: options.windows.minHeight,
    resizable: true,
    show,
    backgroundColor: '#fafafa',
    acceptFirstMouse: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 21 } }
      : {}),
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  windows.add(window);

  // The app is a local server; anything else belongs in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // No menu bar off macOS, so the New Window accelerator is matched here.
  if (newWindowChord && onNewWindowRequest) {
    window.webContents.on('before-input-event', (event, input) => {
      if (!matchesChord(newWindowChord, input)) return;
      event.preventDefault();
      onNewWindowRequest();
    });
  }

  const persist = () => saveBounds(window);
  window.on('resized', persist);
  window.on('moved', persist);

  window.on('close', (event) => {
    if (quitting || options.windows.closeAction !== 'hide') {
      saveBounds(window);
      return;
    }
    // Tray apps keep the window alive so reopening is instant and the page keeps its state.
    event.preventDefault();
    saveBounds(window);
    window.hide();
  });

  window.on('closed', () => {
    windows.delete(window);
  });

  void loadInto(window);
  log.info(`window opened (${windowCount()} open)`);
  return window;
}

function revealWindow(window) {
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

/** Show and focus a window, creating one if none exists. Used by tray, dock and second-instance. */
export function focusOrOpenWindow(opts = {}) {
  const existing = allWindows();
  if (existing.length === 0) return openWindow(opts);
  const hidden = existing.find((window) => !window.isVisible());
  revealWindow(hidden ?? existing[existing.length - 1]);
  return hidden ?? existing[existing.length - 1];
}

/** First window of a launch. Honours `tray.showWindowOnLaunch`. */
export function openInitialWindow(opts = {}) {
  if (options.tray.enabled && options.tray.showWindowOnLaunch === false) {
    log.info('starting in the background (tray.showWindowOnLaunch=false)');
    return null;
  }
  return openWindow(opts);
}

/**
 * Point every window at `url` and open new ones there. Called once the bundle server answers.
 */
export async function setTargetUrl(url) {
  targetUrl = url;
  await Promise.all(
    allWindows().map((window) =>
      window.loadURL(url).catch((err) => log.warn(`navigate window: ${err.message}`)),
    ),
  );
}

export function targetUrlOrNull() {
  return targetUrl;
}

/** Reload every window so a freshly started bundle replaces the page. */
export function reloadAllWindows() {
  const open = allWindows();
  if (open.length === 0) return;
  for (const window of open) window.webContents.reload();
}

/** Push a message to every window, whichever page each one has loaded. */
export function broadcast(channel, payload) {
  for (const window of allWindows()) {
    try {
      window.webContents.send(channel, payload);
    } catch (err) {
      log.warn(`send ${channel}: ${err.message}`);
    }
  }
}

export { LAUNCHER_PAGE };
