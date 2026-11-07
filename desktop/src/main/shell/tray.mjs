/**
 * Tray / menu-bar icon, created only when `tray.enabled` is set.
 *
 * The menu is rebuilt whenever something it shows changes — above all a downloaded OTA update,
 * which it offers to apply. That is the one path a background app (`tray.showWindowOnLaunch:
 * false`) has to update itself without ever opening a window.
 */
import { Menu, Tray, app, nativeImage } from 'electron';

import * as bundles from '../bundle-manager.mjs';
import { log } from '../log.mjs';
import { DEFAULT_APP_ICON, desktopPath } from './assets.mjs';
import { canOpenWindow, focusOrOpenWindow, windowCount } from './windows.mjs';

/** macOS menu-bar icons are 16pt; the file should be 32×32 for retina. */
const TRAY_ICON_SIZE = 16;

/** @type {Tray | null} */
let tray = null;
let options = null;
/** @type {{ onNewWindow: () => void, onApplyUpdate: () => void } | null} */
let actions = null;

function trayImage(iconPath) {
  const file = desktopPath(iconPath);
  let image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    log.warn(`tray icon ${file} could not be read; falling back to the application icon`);
    image = nativeImage.createFromPath(DEFAULT_APP_ICON);
  }
  if (image.isEmpty()) return image;
  const resized = image.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  // A *Template.png name is the macOS convention for an icon that follows the menu bar theme.
  if (process.platform === 'darwin' && /Template\.png$/i.test(iconPath)) {
    resized.setTemplateImage(true);
  }
  return resized;
}

function buildMenu() {
  const pending = bundles.pendingUpdate();
  const items = [
    {
      label: windowCount() > 0 ? 'Show __APP_NAME__' : 'Open __APP_NAME__',
      click: () => focusOrOpenWindow(),
    },
  ];

  if (options.windows.multiWindow) {
    items.push({
      label: 'New Window',
      accelerator: options.windows.newWindowAccelerator,
      enabled: canOpenWindow(),
      click: () => actions?.onNewWindow(),
    });
  }

  if (pending) {
    items.push(
      { type: 'separator' },
      { label: `Update to ${pending} on restart`, enabled: false },
      { label: 'Restart Now', click: () => actions?.onApplyUpdate() },
    );
  }

  items.push({ type: 'separator' }, { label: 'Quit __APP_NAME__', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

/** Rebuild the menu in place. Cheap, and safe to call when there is no tray. */
export function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildMenu());
}

/**
 * @param {object} shellOptions
 * @param {{ onNewWindow: () => void, onApplyUpdate: () => void }} handlers
 */
export function initTray(shellOptions, handlers) {
  options = shellOptions;
  actions = handlers;
  if (!shellOptions.tray.enabled || tray) return null;

  const image = trayImage(shellOptions.tray.icon);
  if (image.isEmpty()) {
    log.error(`tray.enabled is set but no usable icon was found (${shellOptions.tray.icon})`);
    return null;
  }

  tray = new Tray(image);
  tray.setToolTip(shellOptions.tray.tooltip || app.getName());
  refreshTray();

  // macOS always opens the menu on click; elsewhere a left click can open the window instead.
  if (process.platform !== 'darwin' && shellOptions.tray.leftClickOpensWindow) {
    tray.on('click', () => focusOrOpenWindow());
  }
  tray.on('double-click', () => focusOrOpenWindow());

  log.info('tray icon created');
  return tray;
}

export function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

export function hasTray() {
  return Boolean(tray && !tray.isDestroyed());
}
