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

Covers the zip reader (including zip-slip, symlink and CRC rejection) and version ordering — the
two places where a bug would either break every update or let an unverified file onto disk.
