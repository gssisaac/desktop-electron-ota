/**
 * The only surface the renderer gets. Each handler returns `{ ok, value }` or `{ ok: false,
 * error }` so the page sees the launcher's own message instead of Electron's
 * "Error invoking remote method …" wrapper.
 */
import { ipcMain } from 'electron';

import * as bundles from './bundle-manager.mjs';
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

export function registerIpc() {
  handle('launcher:status', () => launcherStatus());
  handle('launcher:retry', () => {
    void spawnBoot();
  });
  handle('ota:status', () => bundles.otaStatus());
  handle('ota:pending-update', () => bundles.pendingUpdate());
  handle('ota:apply-pending-update', () => applyPendingUpdate());
}
