/**
 * Where the launcher keeps state. `{appData}/__APP_IDENTIFIER__` holds installed bundles,
 * the active/pending pointers, logs and the app's own user data — never anything inside the
 * installed app, which is read-only and replaced on every update.
 */
import { app } from 'electron';
import { join } from 'node:path';

export const APP_IDENTIFIER = '__APP_IDENTIFIER__';

/** macOS: `~/Library/Application Support/__APP_IDENTIFIER__`. Windows: `%APPDATA%\__APP_IDENTIFIER__`. */
export function appDataDir() {
  return join(app.getPath('appData'), APP_IDENTIFIER);
}

/** `resources/` inside the installed app, or `desktop/resources/` under `electron .`. */
export function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
}
