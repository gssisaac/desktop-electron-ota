/**
 * Files the shell loads from disk, resolved in one place.
 *
 * These are plain paths relative to this file, so moving a module between directories silently
 * breaks them — which is exactly what happened once. `test/shell-assets.test.mjs` asserts every
 * one of them exists, so a move fails the test run instead of producing a blank window.
 *
 * Electron-free on purpose, so that test can load it in plain Node.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `desktop/` — this file sits at `desktop/src/main/shell/assets.mjs`. */
export const DESKTOP_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The one preload every window gets; defines `window.desktopOta`. */
export const PRELOAD_SCRIPT = join(DESKTOP_ROOT, 'src', 'preload', 'bridge.js');

/** Splash page, shown until the bundle server answers. */
export const LAUNCHER_PAGE = join(DESKTOP_ROOT, 'launcher', 'index.html');

/** Fallback when `tray.icon` names a file that is not there. */
export const DEFAULT_APP_ICON = join(DESKTOP_ROOT, 'build', 'icon.png');

/** Resolve a user-supplied, `desktop/`-relative path such as `tray.icon`. */
export function desktopPath(relative) {
  return join(DESKTOP_ROOT, relative);
}

/** Everything that must exist in a working checkout. Used by the test. */
export const REQUIRED_ASSETS = { PRELOAD_SCRIPT, LAUNCHER_PAGE, DEFAULT_APP_ICON };
