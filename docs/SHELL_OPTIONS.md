# Shell options

How the desktop shell behaves around the app — tray icon, multiple windows, what the close button
does, whether closing the last window quits — lives in one file, `desktop/shell.config.json`, and
is applied in one place, `desktop/src/main/shell/`.

Pick the behaviour while scaffolding, change it later in a project that already exists; both go
through the same command.

## Setting it

```bash
pnpm shell:config                       # wizard: start from a preset, then fine-tune
pnpm shell:config --list                # the effective config, with descriptions and warnings
pnpm shell:config --preset list         # the presets below
pnpm shell:config --preset tray-app     # apply one
pnpm shell:config --set tray.enabled=true --set windows.multiWindow=true
pnpm shell:config --reset               # back to the defaults
```

The file is plain JSON and safe to hand-edit; the launcher reports anything it does not recognise
and keeps the default for it. `pnpm dev:desktop` picks a change up on the next launch. An already
installed app needs a new `pnpm release:desktop`, since `shell.config.json` is packaged inside the
app — it is a product decision, not a user preference.

## Presets

| Preset | Behaviour |
|--------|-----------|
| `single-window` | One window; closing it exits the app. The default, and what the Tauri variant does. |
| `multi-window` | `Cmd/Ctrl+N` opens another window; closing them all exits. |
| `tray-app` | Tray icon, close hides the window, the app stays resident. |
| `menu-bar-only` | Tray only: launches with no window and no macOS dock icon. |

A preset only sets the keys it names, so anything you changed by hand survives it.

## Options

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `singleInstance` | boolean | `true` | A second launch focuses the running app instead of starting a second copy. Keep this on: two launchers would fight over the bundle server port. |
| `tray.enabled` | boolean | `false` | Show a tray / menu-bar icon whose menu can open a window, open a new window, apply a downloaded update and quit. |
| `tray.showWindowOnLaunch` | boolean | `true` | With the tray on, `false` starts the app in the background with no window; the user opens one from the tray. The bundle server still starts. Needs `tray.enabled`. |
| `tray.icon` | string | `"launcher/tray-icon.png"` | Relative to `desktop/`. A file whose name ends in `Template.png` is treated as a macOS template image, so it follows the menu bar in light and dark mode. Needs `tray.enabled`. |
| `tray.tooltip` | string | `""` | Hover text for the tray icon. Empty uses the application name. Needs `tray.enabled`. |
| `tray.leftClickOpensWindow` | boolean | `true` | Windows and Linux: a left click opens or focuses a window instead of only showing the menu. On macOS a click always opens the menu. Needs `tray.enabled`. |
| `windows.multiWindow` | boolean | `false` | Allow more than one window, with a New Window menu item, an accelerator, and `desktopOta.openNewWindow()` for the app UI. |
| `windows.newWindowAccelerator` | string | `"CmdOrCtrl+N"` | An Electron accelerator. On macOS it is bound to the File menu item; elsewhere the launcher matches the key combination itself, since the shell ships no menu bar. Needs `windows.multiWindow`. |
| `windows.maxWindows` | number | `8` | Upper bound, so a held-down shortcut cannot open windows without end. Needs `windows.multiWindow`. |
| `windows.closeAction` | `close` \| `hide` | `"close"` | `close` destroys the window. `hide` keeps it in memory and just hides it, which is what a tray app wants — reopening is then instant and the page keeps its state. |
| `windows.onLastWindowClosed` | `quit` \| `keepRunning` | `"quit"` | `quit` exits the app and stops the bundle server. `keepRunning` leaves it alive in the tray or macOS dock, so the next window opens without a boot. |
| `windows.rememberState` | boolean | `true` | Saves window bounds to `window-state.json` in the app data directory and restores them on the next launch, clamped to a display that still exists. |
| `windows.width` | number | `1280` | Width of a window with no remembered bounds. |
| `windows.height` | number | `840` | Height of a window with no remembered bounds. |
| `windows.minWidth` | number | `960` | The window cannot be resized narrower than this. |
| `windows.minHeight` | number | `640` | The window cannot be resized shorter than this. |
| `dock` | `visible` \| `hidden` | `"visible"` | `hidden` calls `app.dock.hide()`, making it a menu-bar-only app. It needs the tray, or there would be nothing left to click. **(darwin only)** |
| `launchAtLogin` | boolean | `false` | Registers the app as a login item on macOS and Windows. Applied on every launch, so turning it off also unregisters it. |

This table is generated — `pnpm shell:config --markdown` prints it from
`desktop/src/main/shell/options.mjs`, which is also what produces the defaults, the wizard
questions and the validation. Add an option there and everything else follows.

## Combinations that would leave the app unreachable

The easiest way to ship a broken desktop app is a shell with no window and no way to open one.
Those combinations are rejected rather than written:

| Config | Why it is refused |
|--------|-------------------|
| `tray.showWindowOnLaunch: false` without `tray.enabled` | Launches with no window and no tray icon. |
| `dock: "hidden"` without `tray.enabled` | On macOS there is no dock icon and no tray icon left to click. |
| `windows.minWidth` above `windows.width` (same for height) | The window cannot honour both. |

`--force` writes anyway, and the launcher still refuses to be unreachable: at startup it logs the
problem and falls back (`showWindowOnLaunch` back to `true`, `dock` back to `visible`). A
hand-edited or outdated file therefore cannot produce an app the user cannot reach.

Two more are legal but behave differently per platform, so they are warnings:

- `windows.closeAction: "hide"` without a tray — reachable from the macOS dock, unreachable on
  Windows and Linux.
- `windows.onLastWindowClosed: "keepRunning"` without a tray — same reasoning.

## What the app UI can see

The preload exposes the shell's own configuration, so the web app can adapt instead of hard-coding
it a second time:

```ts
const shell = await window.desktopOta.shellOptions();
// { tray, multiWindow, maxWindows, closeAction, onLastWindowClosed, windowCount, canOpenWindow, platform }

if (shell.canOpenWindow) {
  await window.desktopOta.openNewWindow();   // rejects when multiWindow is off or the cap is hit
}
```

## Where each option is applied

| Module | Responsibility |
|--------|----------------|
| `shell/options.mjs` | The descriptor table: defaults, coercion, validation, safe fallbacks, presets. No Electron import, so the CLI and the tests use it directly. |
| `shell/lifecycle.mjs` | Turns options into behaviour: single instance, dock, login item, menu, tray, `window-all-closed`, `activate`. |
| `shell/windows.mjs` | One window or many: geometry, remembered bounds, cascade, close-vs-hide, broadcast, navigation. |
| `shell/tray.mjs` | The tray icon and its menu, rebuilt when a downloaded update appears. |
| `shell/menu.mjs` | macOS menu bar with New Window; no menu bar elsewhere. |
| `shell/accelerator.mjs` | Matches the New Window chord on platforms with no menu bar. |

## Notes

- **Tray icon.** `desktop/launcher/tray-icon.png` is a 32×32 placeholder. For a macOS menu bar,
  supply a monochrome image named `…Template.png` and point `tray.icon` at it; the launcher then
  marks it as a template image so it follows light and dark mode. A missing file is not fatal —
  the launcher warns and falls back to `build/icon.png`.
- **Background launch and OTA.** With `tray.showWindowOnLaunch: false` the bundle server still
  starts and updates still download. The tray menu is how the user applies one, so it carries a
  "Restart Now" item while an update is pending.
- **`closeAction: "hide"` covers the close button, not `window.close()`.** Clicking the window's
  close button goes through Electron's cancelable window `close` event, which is what hides the
  window. A page calling `window.close()` itself is routed through `webContents.close()` and
  destroys the window without that event, so it closes rather than hides — verified on Electron
  38. With a tray and `onLastWindowClosed: "keepRunning"` the app stays resident either way, and
  the tray reopens it. If a page must hide rather than close, have it call a shell action instead
  of `window.close()`.
- **`keepRunning` and the bundle server.** `quit` stops the server with the app. `keepRunning`
  leaves it listening on `__APP_PORT_PROD__`, which is the point: the next window opens instantly,
  with no boot sequence.
- **No menu bar off macOS.** The app UI is a web page, so a native menu would look out of place.
  The New Window accelerator is matched per window instead. Set
  `windows.newWindowAccelerator` to any Electron accelerator; a value the launcher cannot parse is
  logged and the shortcut is simply absent.
- **macOS `LSUIElement`.** `dock: "hidden"` uses `app.dock.hide()` at runtime, so the setting
  stays changeable without a rebuild. The dock icon may flash briefly at launch. To avoid that,
  add `mac.extendInfo.LSUIElement: true` to `desktop/electron-builder.yml` — at the cost of making
  the choice build-time.
