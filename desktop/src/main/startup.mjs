/**
 * Release boot sequence. The main window first shows the bundled launcher page
 * (`desktop/launcher`), which renders the status published here, then navigates to the
 * full-stack server once the already installed bundle is healthy. A newer bundle downloads in
 * the background and stays pending until the user refreshes.
 */
import { app } from 'electron';

import * as apiBridge from './api-bridge.mjs';
import * as bundles from './bundle-manager.mjs';
import { log } from './log.mjs';
import { navigateMainWindow, reloadMainWindow, send } from './window.mjs';

export const STATUS_CHANNEL = 'launcher:status-changed';
export const UPDATE_READY_CHANNEL = 'ota:update-ready';

/** @typedef {{ seq: number, phase: string, message: string, progress: number|null, detail: string|null }} LauncherStatus */

/** Monotonic `seq`, so the page can drop stale snapshots that race with events. */
let status = { seq: 0, phase: 'checking', message: '', progress: null, detail: null };
let booting = false;

export function launcherStatus() {
  return status;
}

function publish(phase, message, progress = null, detail = null) {
  status = { seq: status.seq + 1, phase, message, progress, detail };
  send(STATUS_CHANNEL, status);
}

const megabytes = (bytes) => bytes / 1_048_576;

function publishProgress(progress) {
  switch (progress.phase) {
    case 'checking':
      publish('checking', 'Checking for updates…');
      break;
    case 'downloading': {
      const { received = 0, total } = progress;
      const message = total
        ? `Downloading __APP_NAME__ engine… ${megabytes(received).toFixed(0)} / ${megabytes(total).toFixed(0)} MB`
        : `Downloading __APP_NAME__ engine… ${megabytes(received).toFixed(0)} MB`;
      const fraction = total > 0 ? Math.min(received / total, 1) : null;
      publish('downloading', message, fraction);
      break;
    }
    case 'preparing':
      publish('installing', `Preparing __APP_NAME__ ${progress.version}…`);
      break;
    case 'installing':
      publish('installing', 'Verifying and installing…');
      break;
    default:
      break;
  }
}

async function boot() {
  const appVersion = app.getVersion();
  const onProgress = publishProgress;

  publish('starting', 'Starting __APP_NAME__…');
  let bundle;
  try {
    bundle = await bundles.startupBundle(onProgress);
  } catch (err) {
    log.warn(`no local bundle (${err.message}); downloading before launch`);
    bundle = await bundles.ensureBundle(appVersion, onProgress);
  }

  publish('starting', `Starting __APP_NAME__ ${bundle.version}…`);
  await apiBridge.start(bundle);
  await bundles.pruneInactive(bundle);

  publish('ready', 'Opening __APP_NAME__…');
  await navigateMainWindow(`${apiBridge.origin()}/`);
  return bundle;
}

/** Install/start the engine, then look for a newer bundle. No-op while a boot runs. */
export async function spawnBoot() {
  if (booting) return;
  booting = true;
  let started = true;
  try {
    await boot();
  } catch (err) {
    started = false;
    log.error(`startup failed: ${err.message}`);
    publish('error', "__APP_NAME__ couldn't start", null, err.message);
  } finally {
    booting = false;
  }
  if (!started) return;

  try {
    await bundles.prepareUpdate(app.getVersion(), (version) => {
      send(UPDATE_READY_CHANNEL, { version });
    });
  } catch (err) {
    log.warn(`background update failed: ${err.message}`);
  }
}

/** Restart onto the bundle downloaded in the background, then reload the window. */
export async function applyPendingUpdate() {
  if (booting) throw new Error('__APP_NAME__ is busy. Try again in a moment.');
  booting = true;
  try {
    const previous = bundles.installedBundle();
    const bundle = await bundles.activatePending();
    try {
      await apiBridge.start(bundle);
    } catch (err) {
      // Roll back to the version that was running, and keep the download for the next try.
      if (!previous) throw err;
      await bundles.setPending(bundle).catch(() => {});
      try {
        await bundles.setActive(previous);
        await apiBridge.start(previous);
      } catch {
        throw err;
      }
      throw new Error(`${err.message}\n\n__APP_NAME__ ${previous.version} is still running.`);
    }
    await bundles.pruneInactive(bundle);
    reloadMainWindow();
  } finally {
    booting = false;
  }
}
