/**
 * One place where the shell options turn into behaviour.
 *
 * `index.mjs` loads the config and calls `installShell()`; everything the options imply —
 * single instance, dock visibility, login item, the tray, the menu, what the close button does,
 * what happens when the last window goes away — is wired here. Adding an option means touching
 * `shell/options.mjs` and this file, and nothing else.
 */
import { app } from 'electron';

import { log } from '../log.mjs';
import { installApplicationMenu } from './menu.mjs';
import { destroyTray, initTray, refreshTray } from './tray.mjs';
import {
  focusOrOpenWindow,
  initWindows,
  openInitialWindow,
  openWindow,
  setQuitting,
} from './windows.mjs';

/**
 * Claim the single-instance lock when the config asks for it. Must run before `whenReady`.
 *
 * @returns {boolean} false when another copy already owns it and this process should quit
 */
export function claimSingleInstance(options) {
  if (!options.singleInstance) return true;
  if (app.requestSingleInstanceLock()) return true;
  return false;
}

function applyDock(options) {
  if (process.platform !== 'darwin' || !app.dock) return;
  if (options.dock === 'hidden') {
    void app.dock.hide();
    log.info('macOS dock icon hidden (dock=hidden)');
  }
}

function applyLaunchAtLogin(options) {
  if (!['darwin', 'win32'].includes(process.platform)) return;
  try {
    const current = app.getLoginItemSettings().openAtLogin;
    if (current !== options.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: options.launchAtLogin });
      log.info(`launch at login ${options.launchAtLogin ? 'enabled' : 'disabled'}`);
    }
  } catch (err) {
    log.warn(`launch at login: ${err.message}`);
  }
}

/**
 * Wire every option. Call once, before `app.whenReady()` resolves.
 *
 * @param {object} args
 * @param {object} args.options shell options
 * @param {() => void} args.onApplyUpdate restart onto a downloaded bundle (startup.applyPendingUpdate)
 * @param {() => void} args.onQuitting called before the app exits, to stop the bundle server
 */
export function installShell({ options, onApplyUpdate, onQuitting }) {
  initWindows(options);

  const onNewWindow = () => {
    openWindow({ onNewWindowRequest: onNewWindow });
    refreshTray();
  };

  app.on('second-instance', () => {
    log.info('second __APP_NAME__ instance requested; focusing the existing window');
    focusOrOpenWindow({ onNewWindowRequest: onNewWindow });
    refreshTray();
  });

  app.on('window-all-closed', () => {
    // `closeAction: 'hide'` never destroys a window, so this only fires for real closes.
    if (options.windows.onLastWindowClosed === 'quit') {
      log.info('last window closed; quitting (windows.onLastWindowClosed=quit)');
      app.quit();
      return;
    }
    log.info('last window closed; staying resident (windows.onLastWindowClosed=keepRunning)');
    refreshTray();
  });

  // macOS dock click, or a tray-less relaunch.
  app.on('activate', () => {
    focusOrOpenWindow({ onNewWindowRequest: onNewWindow });
    refreshTray();
  });

  app.on('before-quit', () => {
    setQuitting(true);
    onQuitting();
  });
  app.on('will-quit', () => destroyTray());

  app.whenReady().then(() => {
    applyDock(options);
    applyLaunchAtLogin(options);
    installApplicationMenu(options, { onNewWindow });
    initTray(options, { onNewWindow, onApplyUpdate });
  });

  return {
    /** Open the launch window unless the config says to start in the background. */
    openInitialWindow: () => openInitialWindow({ onNewWindowRequest: onNewWindow }),
    onNewWindow,
  };
}
