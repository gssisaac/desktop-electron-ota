/**
 * The single main window. It first shows the bundled launcher page (`desktop/launcher`), then
 * navigates to the full-stack server once the installed bundle is healthy. Both pages share one
 * preload, so the app served from 127.0.0.1 can read OTA state and trigger a refresh.
 */
import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from './log.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const PRELOAD = join(here, '..', 'preload', 'bridge.js');
const LAUNCHER_PAGE = join(here, '..', '..', 'launcher', 'index.html');

/** @type {BrowserWindow | null} */
let mainWindow = null;

export function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function focusMainWindow() {
  const window = getMainWindow();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Create the window and show the launcher page. Idempotent. */
export function openMainWindow() {
  const existing = getMainWindow();
  if (existing) return existing;

  mainWindow = new BrowserWindow({
    title: '__APP_NAME__',
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    resizable: true,
    show: true,
    backgroundColor: '#fafafa',
    acceptFirstMouse: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 21 } }
      : {}),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // The app is a local server; anything else belongs in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function loadLauncherPage() {
  const window = openMainWindow();
  return window.loadFile(LAUNCHER_PAGE);
}

export async function navigateMainWindow(url) {
  const window = getMainWindow();
  if (!window) throw new Error('main window is not open');
  await window.loadURL(url);
}

/** Reload the page that is already open so a freshly started bundle replaces it. */
export function reloadMainWindow() {
  const window = getMainWindow();
  if (!window) throw new Error('main window is not open');
  window.webContents.reload();
}

/** Push a message to the page, whichever page is loaded. */
export function send(channel, payload) {
  const window = getMainWindow();
  if (!window) return;
  try {
    window.webContents.send(channel, payload);
  } catch (err) {
    log.warn(`send ${channel}: ${err.message}`);
  }
}

export { LAUNCHER_PAGE };
