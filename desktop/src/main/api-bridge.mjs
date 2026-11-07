/**
 * Runs the active full-stack bundle (`node server.js`) on 127.0.0.1:__APP_PORT_PROD__, which serves
 * both the UI and `/api/*` to the window.
 *
 * The server runs on the Node.js runtime shipped beside the app (`resources/node`), not on
 * Electron's own Node and not on whatever the host has installed, so OTA bundles always run on
 * the ABI their native modules were built for. See `scripts/prepare-node-runtime.mjs`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';

import { log } from './log.mjs';
import { appDataDir, resourcesDir } from './paths.mjs';
import { serverEntry } from './bundle-manager.mjs';

/**
 * The port the bundle's server listens on. Quoted so an unreplaced placeholder fails with a
 * clear message instead of a bare `ReferenceError`; a project-wide replace turns it into the
 * numeric literal.
 */
export const SERVER_PORT = Number('__APP_PORT_PROD__');
if (!Number.isInteger(SERVER_PORT) || SERVER_PORT < 1 || SERVER_PORT > 65535) {
  throw new Error('__APP_PORT_PROD__ was not replaced with a port number (see AGENT.md)');
}
const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 800;
const SHUTDOWN_GRACE_MS = 1500;
/** How long a process holding the port gets after each signal before escalating. */
const PORT_RELEASE_TIMEOUT_MS = 3000;
const PATH_SEPARATOR = process.platform === 'win32' ? ';' : ':';

/**
 * Runs `server.js` (passed as argv[1]) and exits once the launcher's stdin pipe closes, so a
 * crashed or force-quit shell never leaves an orphaned server holding the port.
 */
const PARENT_WATCHDOG =
  "process.stdin.on('end',()=>process.exit(0));" +
  "process.stdin.on('error',()=>process.exit(0));" +
  'process.stdin.resume();' +
  'require(process.argv[1]);';

/** @type {import('node:child_process').ChildProcess | null} */
let server = null;
let serverLogPath = null;

export function origin() {
  return `http://127.0.0.1:${SERVER_PORT}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portInUse() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: SERVER_PORT });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** PIDs listening on the port on any address: a stale server, `pnpm start`, anything. */
function portListeners() {
  const own = process.pid;
  if (process.platform === 'win32') {
    const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !result.stdout) return [];
    const suffix = `:${SERVER_PORT}`;
    // `TCP  127.0.0.1:PORT  0.0.0.0:0  LISTENING  1234`; the state column is localized, but
    // only listening sockets have a `:0` foreign port.
    const pids = result.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (cols) =>
          cols.length === 5 &&
          cols[0].startsWith('TCP') &&
          cols[1].endsWith(suffix) &&
          cols[2].endsWith(':0'),
      )
      .map((cols) => Number.parseInt(cols[4], 10))
      .filter((pid) => Number.isInteger(pid) && pid !== own);
    return [...new Set(pids)].sort((a, b) => a - b);
  }
  const result = spawnSync(
    '/usr/sbin/lsof',
    ['-nP', '-t', '-sTCP:LISTEN', `-iTCP:${SERVER_PORT}`],
    { encoding: 'utf8' },
  );
  if (!result.stdout) return [];
  const pids = result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid !== own);
  return [...new Set(pids)].sort((a, b) => a - b);
}

function stopPid(pid, force) {
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    spawnSync('taskkill', args, { encoding: 'utf8', windowsHide: true });
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // A stale pid is already gone.
  }
}

async function waitPortReleased(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (portListeners().length === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/**
 * The launcher owns the port: stop whatever listens on it (SIGTERM, then SIGKILL; on Windows
 * `taskkill`, then `taskkill /F`) so the bundle's server always starts fresh on the shipped Node.
 */
async function freePort() {
  for (const force of [false, true]) {
    const pids = portListeners();
    if (pids.length === 0) break;
    log.warn(`port ${SERVER_PORT} is held by pid ${pids.join(', ')}; stopping it (force: ${force})`);
    for (const pid of pids) stopPid(pid, force);
    if (await waitPortReleased(PORT_RELEASE_TIMEOUT_MS)) break;
  }
  if (await portInUse()) {
    throw new Error(
      `Port ${SERVER_PORT} is held by another process (pid ${portListeners().join(', ') || '?'}) that __APP_NAME__ couldn't stop.`,
    );
  }
}

/** Resolves to the health payload only when a __APP_NAME__ server answers on the port. */
async function probe() {
  try {
    const response = await fetch(`${origin()}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = await response.json();
    const health = body?.data;
    return health?.app === '__APP_SLUG__' ? health : null;
  } catch {
    return null;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The Node.js runtime packaged beside the app, or `node` on PATH as a last resort.
 *
 * Both candidates are checked with `isFile`, not a mere existence test: under `electron .` the
 * first path is the staging *directory* `desktop/resources/node`, and spawning a directory fails
 * with a confusing EACCES.
 */
export function findNodeBinary() {
  const name = `node${process.platform === 'win32' ? '.exe' : ''}`;
  // Packaged: electron-builder copies the runtime to `Resources/node` (`node.exe` on Windows).
  const packaged = join(resourcesDir(), name);
  if (isFile(packaged)) return packaged;
  // `electron .`: prepare-node-runtime.mjs stages it as `desktop/resources/node/node`.
  const staged = join(resourcesDir(), 'node', name);
  if (isFile(staged)) return staged;
  log.warn('packaged Node.js runtime not found; falling back to `node` on PATH');
  return 'node';
}

/** Puts the runtime's directory first so anything the server runs as `node` uses it too. */
function serverPath(nodeBinary) {
  const inherited = process.env.PATH ?? '';
  const dir = nodeBinary.includes('/') || nodeBinary.includes('\\') ? dirname(nodeBinary) : '';
  return dir ? `${dir}${PATH_SEPARATOR}${inherited}` : inherited;
}

function serverLogFile() {
  const dir = join(appDataDir(), 'logs');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'server.log');
}

function logTail(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - 12)).join('\n');
  return tail.trim() ? `${tail}\n\n(full log: ${path})` : `(no server output; see ${path})`;
}

/** Start the bundle's server and resolve once `/api/health` answers for this version. */
export async function start(bundle) {
  await stop();
  await freePort();

  const nodeBinary = findNodeBinary();
  const home = appDataDir();
  mkdirSync(home, { recursive: true });
  serverLogPath = serverLogFile();
  const logStream = createWriteStream(serverLogPath, { flags: 'w' });
  await new Promise((resolve, reject) => {
    logStream.once('open', resolve);
    logStream.once('error', reject);
  });

  log.info(
    `starting __APP_NAME__ server v${bundle.version}: ${nodeBinary} ${serverEntry(bundle)} (log ${serverLogPath})`,
  );

  const env = { ...process.env };
  // Inherited bundle env makes Launch Services treat Node as a second GUI app (Dock bounce).
  delete env.__CFBundleIdentifier;
  delete env.XPC_SERVICE_NAME;
  delete env.__CF_USER_TEXT_ENCODING;
  // Electron sets these for its own helpers; a plain Node server must not inherit them.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const child = spawn(nodeBinary, ['--eval', PARENT_WATCHDOG, serverEntry(bundle)], {
    cwd: bundle.dir,
    windowsHide: true,
    env: {
      ...env,
      PATH: serverPath(nodeBinary),
      HOSTNAME: '127.0.0.1',
      PORT: String(SERVER_PORT),
      NODE_ENV: 'production',
      __APP_SLUG_UPPER___HOME: home,
      __APP_SLUG_UPPER___BUNDLE_VERSION: bundle.version,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  let spawnError = null;
  let exitStatus = null;
  child.once('error', (err) => {
    spawnError = err;
  });
  child.once('exit', (code, signal) => {
    exitStatus = signal ? `signal ${signal}` : `code ${code}`;
  });
  server = child;

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (spawnError) {
      await stop();
      throw new Error(
        `Couldn't run the packaged Node.js runtime (${nodeBinary}): ${spawnError.message}. Reinstall __APP_NAME__ from __APP_DOMAIN__.`,
      );
    }
    if (exitStatus !== null) {
      const tail = logTail(serverLogPath);
      await stop();
      throw new Error(`__APP_NAME__ server exited during startup (${exitStatus}).\n\n${tail}`);
    }
    const health = await probe();
    if (health?.bundleVersion === bundle.version) {
      log.info(`__APP_NAME__ server listening on ${origin()}`);
      return;
    }
    if (Date.now() >= deadline) {
      const tail = logTail(serverLogPath);
      await stop();
      throw new Error(
        `__APP_NAME__ server did not respond within ${STARTUP_TIMEOUT_MS / 1000}s.\n\n${tail}`,
      );
    }
    await sleep(150);
  }
}

/** Close the watchdog pipe so the server exits on its own, then kill it if it lingers. */
export async function stop() {
  const child = server;
  if (!child) return;
  server = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin?.end();
  const timer = sleep(SHUTDOWN_GRACE_MS).then(() => 'timeout');
  if ((await Promise.race([exited.then(() => 'exited'), timer])) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}

/** Synchronous best-effort kill for `will-quit`, where promises no longer run. */
export function stopSync() {
  const child = server;
  if (!child) return;
  server = null;
  child.stdin?.end();
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

export function serverLog() {
  return serverLogPath;
}
