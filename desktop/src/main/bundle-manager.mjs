/**
 * Full-stack OTA bundles: a Next.js standalone server (UI + API) zipped, signed and
 * published to R2 by `pnpm release:ota`. The launcher installs them under
 * `{appData}/__APP_IDENTIFIER__/bundles/v<version>/`.
 *
 * DMG / NSIS builds also embed the latest bundle (`resources/seed-bundle/`). Startup runs the
 * already installed copy (or that seed, on first launch) immediately, then downloads a newer
 * release in the background. The new copy stays pending until the user refreshes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { verifyBundle } from './crypto.mjs';
import { log } from './log.mjs';
import { appDataDir, resourcesDir } from './paths.mjs';
import { isValidVersion, validateVersion, versionLt } from './version.mjs';
import { extractZip } from './zip.mjs';

/** Bundles carry native modules (better-sqlite3), so each platform has its own release feed. */
export const MANIFEST_URL =
  process.platform === 'win32'
    ? 'https://bundles.__APP_DOMAIN__/manifest-windows-x64.json'
    : 'https://bundles.__APP_DOMAIN__/manifest.json';

const MANIFEST_TIMEOUT_MS = 2500;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;
/** Entry point every bundle must contain (Next.js standalone server). */
export const SERVER_ENTRY = 'server.js';

/** @typedef {{ version: string, dir: string }} Bundle */

/**
 * Serializes install, activate and prune. Held across the background download only while the
 * verified bytes are being written, so a slow download never blocks a refresh.
 */
let bundleOp = Promise.resolve();

/** @template T @param {() => T | Promise<T>} fn @returns {Promise<T>} */
export function withBundleLock(fn) {
  const run = bundleOp.then(fn, fn);
  bundleOp = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function bundlesRoot() {
  const root = join(appDataDir(), 'bundles');
  mkdirSync(root, { recursive: true });
  return root;
}

function activePointerPath() {
  return join(appDataDir(), 'active.json');
}

function pendingPointerPath() {
  return join(appDataDir(), 'pending.json');
}

function writePointer(path, version, dir) {
  mkdirSync(appDataDir(), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version, path: dir }, null, 2)}\n`);
}

function clearPending() {
  rmSync(pendingPointerPath(), { force: true });
}

function versionDir(version) {
  validateVersion(version);
  return join(bundlesRoot(), `v${version}`);
}

function stagingDir() {
  return join(bundlesRoot(), 'staging');
}

/** @returns {Bundle | null} */
function pointerBundle(path, label) {
  if (!existsSync(path)) return null;
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (typeof pointer?.path !== 'string' || !isValidVersion(pointer?.version)) return null;
  if (existsSync(join(pointer.path, SERVER_ENTRY))) {
    return { version: pointer.version, dir: pointer.path };
  }
  log.warn(`${label} bundle has no ${SERVER_ENTRY} (${pointer.path}); ignoring pointer`);
  return null;
}

function activeBundle() {
  return pointerBundle(activePointerPath(), 'cached');
}

function pendingBundle() {
  return pointerBundle(pendingPointerPath(), 'pending');
}

function sameDir(a, b) {
  return Boolean(basename(a)) && basename(a) === basename(b);
}

/** The bundle the launcher is running (or would run) right now. */
export function installedBundle() {
  return activeBundle();
}

export function serverEntry(bundle) {
  return join(bundle.dir, SERVER_ENTRY);
}

export function setActive(bundle) {
  return withBundleLock(() => writePointer(activePointerPath(), bundle.version, bundle.dir));
}

export function setPending(bundle) {
  return withBundleLock(() => writePointer(pendingPointerPath(), bundle.version, bundle.dir));
}

function pendingNewerThan(version) {
  const pending = pendingBundle();
  return pending && versionLt(version, pending.version) ? pending.version : null;
}

/** True when `candidate` is newer than both the running bundle and any pending download. */
function shouldInstall(runningVersion, candidate) {
  const floor = pendingNewerThan(runningVersion) ?? runningVersion;
  return versionLt(floor, candidate);
}

function liveVersion(fallback) {
  return activeBundle()?.version ?? fallback;
}

async function fetchManifest() {
  const response = await fetch(MANIFEST_URL, {
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
  const manifest = await response.json();
  if (!isValidVersion(manifest?.version)) throw new Error('manifest has no usable version');
  if (typeof manifest.url !== 'string' || !manifest.url.startsWith('https://')) {
    throw new Error('manifest url must be https');
  }
  return manifest;
}

/** @param {(progress: {phase: string, received?: number, total?: number|null}) => void} onProgress */
async function downloadBundle(url, expectedSize, onProgress) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`bundle HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : (expectedSize ?? null);
  if (total && total > MAX_BUNDLE_BYTES) throw new Error('bundle exceeds maximum size');

  const chunks = [];
  let received = 0;
  let lastReport = 0;
  onProgress({ phase: 'downloading', received: 0, total });
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (received > MAX_BUNDLE_BYTES) throw new Error('bundle exceeds maximum size');
    const now = Date.now();
    if (now - lastReport >= PROGRESS_INTERVAL_MS) {
      lastReport = now;
      onProgress({ phase: 'downloading', received, total });
    }
  }
  onProgress({ phase: 'downloading', received, total });
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Unpack a verified zip into `bundles/v{version}`. `makeActive` switches the running pointer;
 * otherwise the install stays in `pending.json` until the user refreshes.
 *
 * @returns {Bundle}
 */
function installZip(version, zipBytes, makeActive, onProgress) {
  validateVersion(version);
  const target = versionDir(version);
  const active = activeBundle();
  if (active) {
    if (active.version === version && existsSync(join(active.dir, SERVER_ENTRY))) return active;
    if (sameDir(active.dir, target)) throw new Error('refusing to replace the running bundle');
  }

  onProgress({ phase: 'installing' });
  const stage = stagingDir();
  extractZip(zipBytes, stage);
  if (!existsSync(join(stage, SERVER_ENTRY))) {
    rmSync(stage, { recursive: true, force: true });
    throw new Error(`bundle v${version} has no ${SERVER_ENTRY}`);
  }

  rmSync(target, { recursive: true, force: true });
  renameSync(stage, target);

  if (makeActive) {
    writePointer(activePointerPath(), version, target);
    if (pendingBundle()?.version === version) clearPending();
    log.info(`bundle installed and active: v${version}`);
  } else {
    writePointer(pendingPointerPath(), version, target);
    log.info(`bundle downloaded, waiting for refresh: v${version}`);
  }
  return { version, dir: target };
}

function findSeedDir() {
  const resources = resourcesDir();
  const candidates = [join(resources, 'seed-bundle'), join(resources, 'resources', 'seed-bundle')];
  return (
    candidates.find(
      (dir) => existsSync(join(dir, 'version')) && existsSync(join(dir, 'bundle.zip')),
    ) ?? null
  );
}

/** Version of the bundle shipped inside the installer, or null when none was packaged. */
export function seedVersion() {
  const dir = findSeedDir();
  if (!dir) return null;
  try {
    const version = readFileSync(join(dir, 'version'), 'utf8').trim();
    return isValidVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/** @returns {Bundle | null} */
function installSeed(makeActive, onProgress) {
  const dir = findSeedDir();
  if (!dir) return null;
  const version = seedVersion();
  if (!version) throw new Error('shipped bundle has an invalid version');
  onProgress({ phase: 'preparing', version });
  const zipBytes = readFileSync(join(dir, 'bundle.zip'));
  return installZip(version, zipBytes, makeActive, onProgress);
}

/**
 * Bundle to launch before any network check: the installed copy, or the one shipped inside the
 * app on first launch.
 *
 * @returns {Promise<Bundle>}
 */
export function startupBundle(onProgress) {
  return withBundleLock(() => {
    const active = activeBundle();
    if (active) {
      log.info(`launching installed bundle v${active.version}`);
      return active;
    }
    const seeded = installSeed(true, onProgress);
    if (seeded) {
      log.info(`launching shipped bundle v${seeded.version}`);
      return seeded;
    }
    throw new Error('no __APP_NAME__ engine installed');
  });
}

/**
 * Download a newer bundle without switching to it. Calls `onReady` when a pending version is
 * waiting, including one downloaded on a previous launch. Never throws for a failed update
 * check: being offline is not an error.
 */
export async function prepareUpdate(appVersion, onReady) {
  const running = activeBundle();
  if (!running) throw new Error('no running bundle');

  let announced = null;
  const announce = (version) => {
    if (!version || announced === version) return;
    announced = version;
    log.info(`update ready: v${version}`);
    onReady(version);
  };

  announce(pendingNewerThan(running.version));

  // A newer installer was run while an older OTA bundle was active: seed it as the pending copy.
  const seeded = seedVersion();
  if (seeded && shouldInstall(running.version, seeded)) {
    await withBundleLock(() => {
      if (shouldInstall(liveVersion(running.version), seeded)) installSeed(false, () => {});
    });
  }
  announce(pendingNewerThan(liveVersion(running.version)));

  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (err) {
    log.warn(`update check failed: ${err.message}`);
    return;
  }
  if (manifest.minAppVersion && versionLt(appVersion, manifest.minAppVersion)) {
    log.warn(
      `bundle v${manifest.version} needs __APP_NAME__ ${manifest.minAppVersion} or newer (this is ${appVersion})`,
    );
    return;
  }

  const runningVersion = liveVersion(running.version);
  if (shouldInstall(runningVersion, manifest.version)) {
    log.info(`downloading __APP_NAME__ ${manifest.version}`);
    const zipBytes = await downloadBundle(manifest.url, manifest.size, () => {});
    verifyBundle(zipBytes, manifest.sha256, manifest.signature);
    await withBundleLock(() => {
      if (shouldInstall(liveVersion(runningVersion), manifest.version)) {
        installZip(manifest.version, zipBytes, false, () => {});
      }
    });
  } else {
    log.info(`no newer bundle than v${runningVersion}`);
  }

  const active = activeBundle();
  if (active) announce(pendingNewerThan(active.version));
}

/** Make the pending download the bundle that runs. The caller restarts the server. */
export function activatePending() {
  return withBundleLock(() => {
    const pending = pendingBundle();
    if (!pending) throw new Error('No update is ready to refresh.');
    const active = activeBundle();
    if (active && !versionLt(active.version, pending.version)) {
      throw new Error('No update is ready to refresh.');
    }
    writePointer(activePointerPath(), pending.version, pending.dir);
    clearPending();
    log.info(`activating downloaded bundle v${pending.version}`);
    return pending;
  });
}

/**
 * Last-resort first launch when nothing is installed and the app shipped no seed.
 * Downloads and activates before returning.
 *
 * @returns {Promise<Bundle>}
 */
export async function ensureBundle(appVersion, onProgress) {
  onProgress({ phase: 'checking' });
  const active = activeBundle();
  try {
    const manifest = await fetchManifest();
    if (active?.version === manifest.version) return active;
    if (manifest.minAppVersion && versionLt(appVersion, manifest.minAppVersion)) {
      throw new Error(
        `engine v${manifest.version} requires __APP_NAME__ ${manifest.minAppVersion} or newer (this is ${appVersion}); download the latest app from __APP_DOMAIN__`,
      );
    }
    const zipBytes = await downloadBundle(manifest.url, manifest.size, onProgress);
    verifyBundle(zipBytes, manifest.sha256, manifest.signature);
    return await withBundleLock(() => installZip(manifest.version, zipBytes, true, onProgress));
  } catch (err) {
    if (active) {
      log.warn(`OTA update skipped, running cached v${active.version}: ${err.message}`);
      return active;
    }
    throw new Error(`Couldn't download the __APP_NAME__ engine: ${err.message}`);
  }
}

/** Remove every installed bundle except `keep` and a pending update. */
export function pruneInactive(keep) {
  return withBundleLock(() => {
    let entries;
    try {
      entries = readdirSync(bundlesRoot(), { withFileTypes: true });
    } catch {
      return;
    }
    const pending = pendingBundle();
    for (const entry of entries) {
      const path = join(bundlesRoot(), entry.name);
      if (sameDir(path, keep.dir)) continue;
      if (pending && sameDir(path, pending.dir)) continue;
      const isBundleDir = entry.name.startsWith('v') || entry.name === 'staging';
      if (!isBundleDir || !entry.isDirectory()) continue;
      try {
        rmSync(path, { recursive: true, force: true });
        log.info(`pruned old bundle ${path}`);
      } catch (err) {
        log.warn(`prune ${path}: ${err.message}`);
      }
    }
  });
}

/** Version waiting behind a refresh, or null. */
export function pendingUpdate() {
  const running = activeBundle();
  return running ? pendingNewerThan(running.version) : null;
}

export function otaStatus() {
  const active = activeBundle();
  const pending = active ? pendingNewerThan(active.version) : null;
  let seedSize = null;
  const seed = findSeedDir();
  if (seed) {
    try {
      seedSize = statSync(join(seed, 'bundle.zip')).size;
    } catch {
      seedSize = null;
    }
  }
  return {
    manifestUrl: MANIFEST_URL,
    activeVersion: active?.version ?? null,
    activePath: active?.dir ?? null,
    pendingVersion: pending,
    seedVersion: seedVersion(),
    seedSize,
  };
}
