/**
 * The launcher's only renderer-facing API, exposed as `window.desktopOta` on both the splash
 * page and the app served from 127.0.0.1:__APP_PORT_PROD__.
 *
 * CommonJS on purpose: sandboxed preloads are not ES modules. Nothing here touches `fs`,
 * `child_process` or `ipcRenderer` directly from the page — only the channels listed below.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** Unwrap the `{ ok, value | error }` envelope `src/main/ipc.mjs` returns. */
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result && result.ok) return result.value;
  throw new Error(result?.error || `${channel} failed`);
}

/** @returns {() => void} unsubscribe */
function subscribe(channel, listener) {
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('desktopOta', {
  /** Splash page: current boot phase, message and download progress. */
  launcherStatus: () => call('launcher:status'),
  onLauncherStatus: (listener) => subscribe('launcher:status-changed', listener),
  /** Splash page: start the boot sequence again after an error. */
  launcherRetry: () => call('launcher:retry'),

  /** App: version waiting behind a refresh, or null. */
  pendingUpdate: () => call('ota:pending-update'),
  onUpdateReady: (listener) => subscribe('ota:update-ready', listener),
  /** App: restart onto the downloaded bundle and reload the page. */
  applyPendingUpdate: () => call('ota:apply-pending-update'),
  /** App: manifest URL, active version, pending version, seeded version. */
  otaStatus: () => call('ota:status'),
});
