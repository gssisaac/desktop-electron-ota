/**
 * __APP_NAME__ desktop launcher (Electron).
 *
 * The binary is a thin shell: it ships the current app bundle inside the DMG / NSIS installer,
 * runs it on a packaged Node.js runtime at 127.0.0.1:__APP_PORT_PROD__, and installs later versions as
 * Ed25519-signed OTA zips from https://bundles.__APP_DOMAIN__.
 */
import { app } from 'electron';

import * as apiBridge from './api-bridge.mjs';
import { registerIpc } from './ipc.mjs';
import { log } from './log.mjs';
import { appDataDir } from './paths.mjs';
import { spawnBoot } from './startup.mjs';
import { focusMainWindow, loadLauncherPage, navigateMainWindow, openMainWindow } from './window.mjs';

/** Dev server port, used only by `pnpm dev:desktop`. Quoted so a missed replace fails loudly. */
const DEV_PORT = Number('__APP_PORT_DEV__');
/** `1` runs the real launcher boot path (seed install + OTA) under `electron .`. */
const DEV_BOOT = process.env.__APP_SLUG_UPPER___DEV_BOOT === '1';

// Keep Electron's own caches beside the bundles, pointers and logs, under one identifier-named
// directory. This is also where the app's SQLite database lives (`__APP_SLUG_UPPER___HOME`).
app.setPath('userData', appDataDir());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log.info('second __APP_NAME__ instance requested; focusing existing window');
    focusMainWindow();
  });

  app.on('window-all-closed', () => {
    // Same as the Tauri launcher: closing the window quits. Drop this handler to keep the app
    // alive in the macOS dock instead.
    app.quit();
  });

  app.on('before-quit', () => {
    void apiBridge.stop();
  });
  app.on('will-quit', () => {
    apiBridge.stopSync();
  });

  app.whenReady().then(async () => {
    registerIpc();
    openMainWindow();

    const useDevServer = !app.isPackaged && !DEV_BOOT;
    if (useDevServer) {
      if (!Number.isInteger(DEV_PORT)) {
        throw new Error('__APP_PORT_DEV__ was not replaced with a port number (see AGENT.md)');
      }
      log.info(`dev mode: loading http://127.0.0.1:${DEV_PORT}`);
      await navigateMainWindow(`http://127.0.0.1:${DEV_PORT}/`);
      return;
    }

    await loadLauncherPage();
    void spawnBoot();
  });

  // `window-all-closed` quits, so this only ever fires for a dock click on a live window.
  app.on('activate', () => focusMainWindow());
}
