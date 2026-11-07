/**
 * Application menu.
 *
 * macOS has a menu bar whether the app wants one or not, so it gets a real menu with the
 * standard roles (without them, Cmd+C/V and Cmd+Q stop working) plus File ▸ New Window when
 * `windows.multiWindow` is on.
 *
 * Windows and Linux get no menu bar: the app UI is a web page and a native menu would look
 * wrong there. The New Window accelerator is matched per window instead — see
 * `shell/accelerator.mjs`.
 */
import { Menu, app } from 'electron';

/**
 * @param {object} options shell options
 * @param {{ onNewWindow: () => void }} handlers
 */
export function installApplicationMenu(options, handlers) {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const newWindowItem = options.windows.multiWindow
    ? [
        {
          label: 'New Window',
          accelerator: options.windows.newWindowAccelerator,
          click: () => handlers.onNewWindow(),
        },
      ]
    : [];

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'File',
        submenu: [
          ...newWindowItem,
          ...(newWindowItem.length > 0 ? [{ type: 'separator' }] : []),
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [{ label: `${app.getName()} ${app.getVersion()}`, enabled: false }],
      },
    ]),
  );
}
