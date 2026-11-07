# mac-app-electron — Thin launcher + full-stack OTA

Same pattern as [`desktop-tauri-ota`](../desktop-tauri-ota), on Electron: the **desktop binary is a
launcher** (Electron + a packaged Node.js 22 runtime) that also ships the current app bundle inside
the DMG or NSIS installer. Later versions still arrive as **Ed25519-signed OTA zips** on Cloudflare
R2. The installed copy opens first; a downloaded update waits for Refresh.

## What you get

```
mac-app-electron/       ← copy to productions/{slug}/ (merge with app/)
  app/                  ← placeholder; copy from app-next.js
  desktop/              ← Electron launcher + splash UI + OTA installer
  scripts/              ← OTA build, DMG/NSIS release, R2 upload
  docs/OTA_DEPLOYMENT.md
```

## Why a separate Node.js runtime

Electron embeds its own Node, but its ABI (`process.versions.modules`) changes with every Electron
major. OTA bundles carry compiled native modules (`better-sqlite3`), so pinning them to Electron's
ABI would invalidate every published bundle on an Electron upgrade. The launcher therefore spawns
`server.js` on a **Node 22 binary packaged beside the app** (`resources/node`), exactly as the Tauri
version did with its sidecar. Upgrading Electron never touches the bundle contract.

## Shell behaviour is an option, not a fork

Tray icon, multiple windows (`Cmd/Ctrl+N`), whether the close button quits or hides, whether a
tray app launches with a window at all — all of it is one config file plus one wizard, so you
choose it while scaffolding and change it later without touching launcher code:

```bash
pnpm shell:config                     # wizard: pick a preset, then fine-tune
pnpm shell:config --preset tray-app   # or go straight to a preset
pnpm shell:config --list              # what is set right now
```

| Preset | Behaviour |
|--------|-----------|
| `single-window` | One window; closing it exits. The default. |
| `multi-window` | `Cmd/Ctrl+N` opens another window; closing them all exits. |
| `tray-app` | Tray icon, close hides the window, app stays resident. |
| `menu-bar-only` | Tray only: no window and no macOS dock icon at launch. |

Full reference: [`docs/SHELL_OPTIONS.md`](docs/SHELL_OPTIONS.md). Combinations that would leave the
app with no window and no way to open one are refused rather than written, and the launcher falls
back at runtime if the file says so anyway.

## Placeholders

Replace every `__APP_*__` token before building (see [`AGENT.md`](AGENT.md)).

| Token | Example |
|-------|---------|
| `__APP_NAME__` | Reola |
| `__APP_SLUG__` | reola |
| `__APP_SLUG_UPPER__` | REOLA |
| `__APP_IDENTIFIER__` | com.reola.desktop |
| `__APP_DOMAIN__` | reola.dev |
| `__APP_PORT_PROD__` | 32834 |
| `__APP_PORT_DEV__` | 32835 |

There is no `__APP_SLUG_SNAKE__`: that token existed only for the Rust crate name.

## Quick start (after scaffolding)

```bash
corepack enable
pnpm --dir desktop install
pnpm dev:desktop
```

Release commands run from this folder's root `package.json` once `app/` exists and Cloudflare R2 is
configured.

## Verify the launcher itself

```bash
pnpm test:desktop
```

Covers the zip reader (zip-slip, symlink and CRC rejection), version ordering, the shell option
schema and its validation, and the config wizard — the places where a bug would break every
update, let an unverified file onto disk, or ship an app the user cannot reach.
