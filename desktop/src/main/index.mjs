/**
 * __APP_NAME__ desktop launcher (Electron).
 *
 * The binary is a thin shell: it ships the current app bundle inside the DMG / NSIS installer,
 * runs it on a packaged Node.js runtime at 127.0.0.1:__APP_PORT_PROD__, and installs later versions as
 * Ed25519-signed OTA zips from https://bundles.__APP_DOMAIN__.
 *
 * How the shell behaves around that — tray, multiple windows, what the close button does — comes
 * from `desktop/shell.config.json`. See `shell/options.mjs` and `docs/SHELL_OPTIONS.md`.
 */
import { app } from 'electron';

import * as apiBridge from './api-bridge.mjs';
import { registerIpc } from './ipc.mjs';
import { log } from './log.mjs';
import { appDataDir } from './paths.mjs';
import { claimSingleInstance, installShell } from './shell/lifecycle.mjs';
import { loadShellConfig } from './shell/options.mjs';
import { refreshTray } from './shell/tray.mjs';
import { setTargetUrl } from './shell/windows.mjs';
import { applyPendingUpdate, setShellHooks, spawnBoot } from './startup.mjs';

/** Dev server port, used only by `pnpm dev:desktop`. Quoted so a missed replace fails loudly. */
const DEV_PORT = Number('__APP_PORT_DEV__');
/** `1` runs the real launcher boot path (seed install + OTA) under `electron .`. */
const DEV_BOOT = process.env.__APP_SLUG_UPPER___DEV_BOOT === '1';

// Keep Electron's own caches beside the bundles, pointers and logs, under one identifier-named
// directory. This is also where the app's SQLite database lives (`__APP_SLUG_UPPER___HOME`).
app.setPath('userData', appDataDir());

// Shell options, with every problem reported and nothing able to produce an unreachable app.
// `{UPPER}_SHELL_CONFIG` points at another file, which is how the presets are smoke-tested.
const shell = loadShellConfig(app.getAppPath(), process.env.__APP_SLUG_UPPER___SHELL_CONFIG || null);
if (shell.readError) log.error(`shell config unreadable, using defaults — ${shell.readError}`);
for (const message of shell.invalid) log.error(`shell config: ${message}`);
for (const message of shell.errors) log.error(`shell config: ${message}`);
for (const message of shell.warnings) log.warn(`shell config: ${message}`);
for (const path of shell.unknown) log.warn(`shell config: unknown option ${path} (ignored)`);
for (const fix of shell.fixes) log.warn(`shell config: ${fix}`);
log.info(
  `shell options${shell.found ? ` from ${shell.file}` : ' (defaults; no shell.config.json)'}: ` +
    `tray=${shell.config.tray.enabled} multiWindow=${shell.config.windows.multiWindow} ` +
    `closeAction=${shell.config.windows.closeAction} onLastWindowClosed=${shell.config.windows.onLastWindowClosed}`,
);

if (!claimSingleInstance(shell.config)) {
  app.quit();
} else {
  const shellApi = installShell({
    options: shell.config,
    onApplyUpdate: () => {
      void applyPendingUpdate().catch((err) => log.error(`apply update from tray: ${err.message}`));
    },
    onQuitting: () => {
      void apiBridge.stop();
    },
  });

  // Keep the tray menu's "Restart Now" item in step with the OTA state.
  setShellHooks({ onUpdateReady: refreshTray });

  app.on('will-quit', () => {
    apiBridge.stopSync();
  });

  app.whenReady().then(async () => {
    registerIpc(shell.config, shellApi);
    shellApi.openInitialWindow();

    const useDevServer = !app.isPackaged && !DEV_BOOT;
    if (useDevServer) {
      if (!Number.isInteger(DEV_PORT)) {
        throw new Error('__APP_PORT_DEV__ was not replaced with a port number (see AGENT.md)');
      }
      log.info(`dev mode: loading http://127.0.0.1:${DEV_PORT}`);
      await setTargetUrl(`http://127.0.0.1:${DEV_PORT}/`);
      return;
    }

    void spawnBoot();
  });
}
