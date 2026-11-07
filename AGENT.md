# AGENT.md — mac-app-electron (launcher + OTA)

Instructions for scaffolding a **macOS/Windows desktop app** where Electron is a thin launcher and
the product ships as signed **full-stack OTA bundles** (Next.js standalone).

## When to use

- Native desktop shell with **frequent app updates without reinstalling** the DMG/installer
- Next.js app with API routes and optional native modules (e.g. `better-sqlite3`)
- Distribution via **Cloudflare R2** (`bundles.__APP_DOMAIN__`)

The installer ships the current bundle as a resource so the first launch works offline. Later
versions still arrive as signed OTA zips; the running copy stays up until the user refreshes.

Pick the Tauri variant instead when installer size is the priority (a Tauri DMG is tens of MB
against Electron's ~120 MB) and no Chromium-specific behaviour is needed. Everything else — the
bundle format, manifest, signing keys and R2 layout — is identical between the two.

## Target repo layout

Copy this folder into the product repo so `app/`, `desktop/`, and `scripts/` are siblings:

```
productions/{slug}/
  app/           ← from app-next.js (or existing app)
  desktop/       ← from mac-app-electron/desktop
  scripts/       ← from mac-app-electron/scripts (or merge with root scripts/)
  package.json   ← merge release scripts from mac-app-electron/package.json
  docs/          ← optional: copy docs/OTA_DEPLOYMENT.md
```

## Required inputs

| Input | Token | Notes |
|-------|--------|--------|
| Display name | `__APP_NAME__` | Window title, DMG name, `productName` |
| Kebab slug | `__APP_SLUG__` | Zip names, health `app` field |
| Upper slug | `__APP_SLUG_UPPER__` | Env vars: `{UPPER}_HOME`, `{UPPER}_R2_BUCKET`, … |
| Bundle ID | `__APP_IDENTIFIER__` | electron-builder `appId`, app data subfolder |
| Apex domain | `__APP_DOMAIN__` | R2 custom domain `bundles.{domain}` |
| Prod port | `__APP_PORT_PROD__` | **Numeric** — launcher server port |
| Dev port | `__APP_PORT_DEV__` | **Numeric** — `pnpm dev:desktop` only |

Pick ports that do not collide with other local apps.

## Copy procedure

1. Copy `mac-app-electron/desktop`, `mac-app-electron/scripts`, and the root `package.json` scripts
   into the product repo.
2. Copy `app-next.js` into `app/` (or use the existing `app/`).
3. **Do not copy** `node_modules`, `release`, `.node-cache`, `.ota`, staging dirs, or secrets.
4. Search-replace **project-wide** all `__APP_*__` tokens (including `scripts/app-config.mjs`).
5. Replace both ports with **numeric literals**. They appear as `Number('__APP_PORT_PROD__')` in
   `desktop/src/main/api-bridge.mjs` and `Number('__APP_PORT_DEV__')` in
   `desktop/src/main/index.mjs`; both throw a named error if left unreplaced.
6. Replace icons: `desktop/build/icon.icns`, `icon.ico`, `icon.png`, and
   `desktop/launcher/icon.png`.
7. Run `corepack enable && pnpm --dir desktop install`.
8. Run `pnpm test:desktop` — the zip reader and version ordering must pass before any release.

## Wire the Next.js `app/` package

### Standalone / OTA build

In `app/next.config.ts`, when `process.env.{__APP_SLUG_UPPER___API_STANDALONE}` is set:

- `output: 'standalone'`
- `distDir: '.next-standalone'` (or match `scripts/release-ota-bundle.mjs`)

### Runtime env (launcher sets these)

| Env | Purpose |
|-----|---------|
| `{__APP_SLUG_UPPER___HOME}` | SQLite/user data (never inside the OTA zip) |
| `{__APP_SLUG_UPPER___BUNDLE_VERSION}` | Health check version match |

### Health endpoint

`GET /api/health` must return JSON like:

```json
{ "data": { "app": "__APP_SLUG__", "bundleVersion": "1.0.0" } }
```

The launcher filters on `app === "__APP_SLUG__"` and waits for a matching `bundleVersion`.

## Release workflow

1. **First time:** provision R2 + signing — [`docs/OTA_DEPLOYMENT.md`](docs/OTA_DEPLOYMENT.md).
2. `pnpm release:ota 1.0.0` — builds `app/`, smoke-tests it on the packaged Node 22, signs, uploads
   `bundles/{slug}-{version}.zip` + `manifest.json`.
3. `pnpm release:desktop` — signed, notarized DMG. The `desktop` prebuild seeds that bundle into the
   installer (`desktop/resources/seed-bundle/`, version file + zip). Sanity cap is 500 MB.
4. `pnpm release:desktop:windows` — NSIS on Windows x64, same seed (Authenticode signing not wired
   up yet).

`pnpm release:ota <version> --seed-only` writes the installer seed without uploading. Set
`{__APP_SLUG_UPPER___BUNDLE_VERSION}` to pin the seeded version; otherwise the staged OTA manifest
or `app/package.json` version is used.

Publish an OTA when installed apps should pick up a newer bundle without a new installer. A DMG or
NSIS build already contains the current bundle.

### Smoke test hooks

`release:ota` boots the bundle on the packaged Node and requires `GET /` plus `/api/health` to
answer. Two optional env vars tighten it per product:

| Env | Purpose |
|-----|---------|
| `{__APP_SLUG_UPPER___SMOKE_PATHS}` | Comma-separated extra routes that must return 2xx |
| `{__APP_SLUG_UPPER___SMOKE_DATA_FILE}` | File the server must create under `{UPPER}_HOME`, e.g. `data/app.db` |

## In-app update notice

After the window is open the launcher downloads a newer bundle in the background and sends
`ota:update-ready` to the page. It does not switch until the user refreshes.

Copy [`desktop/updater/UpdateReadyNotice.tsx`](desktop/updater/UpdateReadyNotice.tsx) into the
Next.js app shell and mount it once. It reads `window.desktopOta`, which the launcher's preload
defines, so it is a no-op on the web and needs **no extra dependency** (unlike the Tauri variant,
which required `@tauri-apps/api`).

The preload API, defined in `desktop/src/preload/bridge.js`:

| Call | Purpose |
|------|---------|
| `desktopOta.pendingUpdate()` | Version waiting behind a refresh, or `null` |
| `desktopOta.onUpdateReady(fn)` | Subscribe; returns an unsubscribe function |
| `desktopOta.applyPendingUpdate()` | Restart onto the pending bundle and reload |
| `desktopOta.otaStatus()` | Manifest URL, active/pending/seeded versions |
| `desktopOta.launcherStatus()` / `onLauncherStatus(fn)` / `launcherRetry()` | Splash page only |

## Customization order

1. `scripts/app-config.mjs` — central tokens (or rely on a global replace)
2. `desktop/package.json` — launcher `version` (what `latest.json` reports)
3. `desktop/electron-builder.yml` — `appId`, `productName`, targets, minimum OS
4. `desktop/src/main/crypto.mjs` — `OTA_PUBLIC_KEY_HEX_*` (auto-synced on first `release:ota`)
5. `desktop/launcher/index.html` — splash branding
6. `app/src/lib/theme/brand.ts` — in-app brand

## Pitfalls

- **Node ABI:** the OTA release must run on Node 22 (see `scripts/prepare-node-runtime.mjs`
  `NODE_VERSION`). Electron's own Node is never used to run a bundle.
- **Secrets in zip:** `release:ota` aborts if `.env*` or DB files remain in the bundle.
- **Port collision:** the launcher frees `__APP_PORT_PROD__` on startup (kills the prior listener).
- **Unreplaced ports:** both port constants throw a named error rather than failing obscurely.
- **asar:** `resources/node` and `resources/seed-bundle` must stay **outside** the asar. They are
  `extraResources` in `electron-builder.yml`; do not move them into `files`.
- **Preload is CommonJS:** sandboxed preloads cannot be ES modules. `src/preload/bridge.js` stays
  `.js`/CJS while `src/main/*.mjs` is ESM.
- **Windows vs macOS OTA:** separate manifests (`manifest.json` vs `manifest-windows-x64.json`) and
  separate signing keys.
- **Nested seed zip:** notarization unpacks `Resources/seed-bundle/bundle.zip`. `release:ota`
  Developer ID-signs `.node`, `.dylib` and `spawn-helper` before zipping when an identity is
  available.
- **Symlinks in bundles:** the extractor rejects them. `release:ota` copies with `dereference: true`,
  so a symlink means something upstream changed.

## Verify

```bash
# After placeholder replacement
pnpm test:desktop                  # zip reader + version ordering
pnpm dev:desktop                   # Next dev server + Electron shell
pnpm release:ota 0.0.1 --dry-run   # needs app/ built for standalone
pnpm build:desktop                 # local DMG, unsigned
```

To exercise the real boot path (seed install, OTA check, packaged Node) instead of the dev server:

```bash
__APP_SLUG_UPPER___DEV_BOOT=1 pnpm --dir desktop dev
```
