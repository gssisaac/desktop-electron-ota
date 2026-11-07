/**
 * The only surface the renderer gets. Each handler returns `{ ok, value }` or `{ ok: false,
 * error }` so the page sees the launcher's own message instead of Electron's
 * "Error invoking remote method …" wrapper.
 */
import { ipcMain } from 'electron';

import * as bundles from './bundle-manager.mjs';
import { canOpenWindow, windowCount } from './shell/windows.mjs';
import { applyPendingUpdate, launcherStatus, spawnBoot } from './startup.mjs';

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: (await fn(...args)) ?? null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * @param {object} shellOptions the effective shell config
 * @param {{ onNewWindow: () => void }} shellApi
 */
export function registerIpc(shellOptions, shellApi) {
  handle('launcher:status', () => launcherStatus());
  handle('launcher:retry', () => {
    void spawnBoot();
  });
  handle('ota:status', () => bundles.otaStatus());
  handle('ota:pending-update', () => bundles.pendingUpdate());
  handle('ota:apply-pending-update', () => applyPendingUpdate());

  // Lets the app UI adapt to the shell it is running in — show a New Window button only when
  // the shell allows one, say — without hard-coding the launcher's configuration twice.
  handle('shell:options', () => ({
    tray: shellOptions.tray.enabled,
    multiWindow: shellOptions.windows.multiWindow,
    maxWindows: shellOptions.windows.maxWindows,
    closeAction: shellOptions.windows.closeAction,
    onLastWindowClosed: shellOptions.windows.onLastWindowClosed,
    windowCount: windowCount(),
    canOpenWindow: canOpenWindow(),
    platform: process.platform,
  }));
  handle('shell:new-window', () => {
    if (!shellOptions.windows.multiWindow) {
      throw new Error('This build runs a single window (windows.multiWindow is off).');
    }
    if (!canOpenWindow()) {
      throw new Error(`At most ${shellOptions.windows.maxWindows} windows can be open.`);
    }
    shellApi.onNewWindow();
    return windowCount();
  });
}
