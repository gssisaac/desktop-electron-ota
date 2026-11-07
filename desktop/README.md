# __APP_NAME__ Desktop (Electron launcher)

Electron shell. Release builds embed the current full-stack bundle (`resources/seed-bundle/`,
version file plus zip) so the app opens offline. After the window is up, the shell checks for a
newer signed bundle from `https://bundles.__APP_DOMAIN__` and downloads it in the background. The
running copy stays on `127.0.0.1:__APP_PORT_PROD__` until the user refreshes.

## Layout

| Path | Role |
|------|------|
| `launcher/` | Splash UI while the shipped or installed bundle starts |
| `updater/UpdateReadyNotice.tsx` | Bottom-left notice to copy into the Next.js app |
| `resources/node/` | Node 22 runtime OTA bundles run on (generated, not committed) |
| `resources/seed-bundle/` | App bundle copied into the DMG / NSIS installer (`version` + `bundle.zip`, generated, not committed) |
| `src/main/index.mjs` | App lifecycle, single instance, dev vs. launcher mode |
| `src/main/startup.mjs` | Boot sequence, status publishing, refresh + rollback |
| `src/main/bundle-manager.mjs` | Seed install, background OTA, verify, extract, prune |
| `src/main/api-bridge.mjs` | Spawns the bundle's server, owns the port, waits for health |
| `src/main/crypto.mjs` | Ed25519 public keys (must match the release signing keys) |
| `src/main/zip.mjs` | Dependency-free zip reader (zip-slip, symlink and CRC checks) |
| `src/main/window.mjs` | The single window, launcher page → server navigation |
| `src/preload/bridge.js` | The only renderer-facing API (`window.desktopOta`) |
| `electron-builder.yml` | DMG / NSIS packaging, extraResources, signing, notarization |
| `test/` | Unit tests for the zip reader and version ordering |

## Dev

From the repo root (with `app/` populated):

```bash
corepack enable
pnpm --dir desktop install
pnpm dev:desktop
```

`pnpm dev:desktop` starts the Next dev server on `__APP_PORT_DEV__` and opens the shell against it,
so an installed release app can keep `__APP_PORT_PROD__`. To exercise the real boot path instead:

```bash
__APP_SLUG_UPPER___DEV_BOOT=1 pnpm --dir desktop dev
```

## Test

```bash
pnpm --dir desktop test
```

## Release

Run from the repo root — see [`docs/OTA_DEPLOYMENT.md`](../docs/OTA_DEPLOYMENT.md).

```bash
pnpm release:ota 1.0.0        # full-stack zip + manifest → R2
pnpm release:desktop          # signed DMG, with that bundle inside → R2 (macOS)
pnpm release:desktop:windows  # NSIS installer, with that bundle inside → R2 (Windows x64)
```

`pnpm build:desktop` / `pnpm release:desktop` run `scripts/prepare-node-runtime.mjs` and
`scripts/stage-seed-bundle.mjs` first. Staging reuses `.ota-staging` when that zip is still newer
than `app/`; otherwise it builds with `pnpm release:ota <version> --seed-only`. Set
`__APP_SLUG_UPPER___BUNDLE_VERSION` to pin the version stamped inside the installer. The default is
the staged OTA version, or `app/package.json` when nothing is staged.

Mount `updater/UpdateReadyNotice.tsx` in the app so a downloaded update can be refreshed from the
bottom-left.
