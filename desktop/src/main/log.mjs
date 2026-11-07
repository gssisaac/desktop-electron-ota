/**
 * Launcher log. Mirrors every line to the console (visible under `pnpm dev:desktop`) and
 * appends it to `{appData}/logs/launcher.log`, next to the `server.log` the bundle writes.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir } from './paths.mjs';

let logPath = null;

function target() {
  if (logPath) return logPath;
  try {
    const dir = join(appDataDir(), 'logs');
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'launcher.log');
  } catch {
    logPath = null;
  }
  return logPath;
}

function write(level, args) {
  const line = `${new Date().toISOString()} ${level} ${args
    .map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg)))
    .join(' ')}`;
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](line);
  const file = target();
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // A full or read-only disk must not take the launcher down.
  }
}

export const log = {
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};

export function launcherLogPath() {
  return target();
}
