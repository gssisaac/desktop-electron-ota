#!/usr/bin/env node
/**
 * `pnpm dev:desktop`: start the Next.js dev server on __APP_PORT_DEV__, wait for it, then open the
 * Electron shell pointed at it. Replaces Tauri's `beforeDevCommand` + `devUrl`.
 *
 * The launcher boot path (seed install, OTA check, packaged Node runtime) is skipped in this mode
 * so the dev server owns the page. To exercise the real boot path instead, build a bundle and run:
 *
 *   __APP_SLUG_UPPER___DEV_BOOT=1 pnpm --dir desktop dev
 *
 * Usage: node scripts/dev-desktop.mjs
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_PORT_DEV } from './app-config.mjs';
import { pnpmSpawn } from './pnpm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(APP_PORT_DEV);
if (!Number.isInteger(port)) {
  console.error('[dev] __APP_PORT_DEV__ was not replaced with a port number (see AGENT.md)');
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));

function spawnChild(label, command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.push(child);
  child.on('exit', (exitCode, signal) => {
    if (shuttingDown) return;
    console.log(`[dev] ${label} exited (${signal ?? exitCode})`);
    shutdown(exitCode ?? 0);
  });
  return child;
}

function portOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

console.log(`[dev] starting the app dev server on 127.0.0.1:${port}…`);
const [appCmd, appArgs] = pnpmSpawn(['--dir', join(root, 'app'), 'dev', '--port', String(port)]);
spawnChild('app dev server', appCmd, appArgs, { cwd: root });

const deadline = Date.now() + 120_000;
for (;;) {
  if (await portOpen()) break;
  if (Date.now() > deadline) {
    console.error(`[dev] the app dev server never answered on 127.0.0.1:${port}`);
    shutdown(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

console.log('[dev] dev server is up; launching the Electron shell');
const [electronCmd, electronArgs] = pnpmSpawn(['--dir', join(root, 'desktop'), 'run', 'dev']);
spawnChild('electron', electronCmd, electronArgs, { cwd: root });
