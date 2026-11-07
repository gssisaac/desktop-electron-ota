# OTA + desktop launcher deployment

Neutral guide for **full-stack OTA bundles** and **thin Electron launcher** releases on
Cloudflare R2.

## Architecture

```
┌──────────────────────────────┬──────────────────────────────────────┐
│  Desktop launcher (DMG/EXE)  │  OTA bundle (zip on R2)              │
├──────────────────────────────┼──────────────────────────────────────┤
│ Electron shell + splash UI   │ Next.js standalone (server.js)       │
│ Packaged Node 22 runtime     │ UI + /api/* on 127.0.0.1:{prod port} │
│ Current bundle seeded in      │ Ed25519 + SHA-256 verified on install│
│ the DMG / NSIS installer      │                                      │
└──────────────────────────────┴──────────────────────────────────────┘
```

Base URL: `https://bundles.__APP_DOMAIN__`

The bundle format is identical to the Tauri variant's, so one R2 bucket and one signing key can
serve both shells.

## R2 bucket layout

```
__APP_SLUG__-bundles/
├── manifest.json                    # macOS OTA pointer
├── manifest-windows-x64.json        # Windows OTA pointer
├── bundles/
│   ├── __APP_SLUG__-1.0.0.zip
│   └── __APP_SLUG__-1.0.0-win-x64.zip
└── downloads/
    ├── latest.json                  # macOS DMG pointer
    ├── latest-windows.json          # Windows installer pointer
    ├── __APP_NAME___1.0.0_arm64.dmg
    └── __APP_NAME___1.0.0_x64-setup.exe
```

Cache hints:

- `manifest*.json`, `latest*.json` → `Cache-Control: no-cache`
- `bundles/*.zip`, `downloads/*` → `public, max-age=31536000, immutable` (version in filename)

## Manifest shape

```json
{
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "url": "https://bundles.__APP_DOMAIN__/bundles/__APP_SLUG__-1.0.0.zip",
  "sha256": "…",
  "signature": "…",
  "size": 48123904,
  "releaseDate": "2026-01-01T00:00:00.000Z"
}
```

The manifest is **not** signed; only the bundle is. The launcher therefore treats every field as
untrusted: `version` must match `[0-9A-Za-z.+_-]{1,64}` (so it cannot escape `bundles/`), `url` must
be https, the download is capped at 1 GB, and the zip must pass SHA-256 **and** Ed25519 before a
byte is written.

## Cloudflare setup

1. Create R2 bucket `__APP_SLUG__-bundles`.
2. Attach the custom domain `bundles.__APP_DOMAIN__` to the bucket.
3. Optional: upload `health.json` for connectivity checks.

Wrangler (example — set `CLOUDFLARE_ACCOUNT_ID` in env):

```bash
pnpm dlx wrangler@4 login
pnpm dlx wrangler@4 r2 bucket create __APP_SLUG__-bundles
# Custom domain: R2 dashboard or `wrangler r2 bucket domain add`
```

## Environment variables

Loaded from the repo's `.env`, `.env.local`, and the gitignored `.ota/credentials.env` (macOS) or
`.ota/credentials-windows.env` (Windows).

| Variable | Purpose |
|----------|---------|
| `CLOUDFLARE_API_TOKEN` | R2 write (optional if `wrangler login`) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account |
| `{__APP_SLUG_UPPER___R2_BUCKET}` | Override bucket name |
| `{__APP_SLUG_UPPER___BUNDLE_BASE}` | Override bundle base URL |
| `{__APP_SLUG_UPPER___OTA_PRIVATE_KEY_HEX}` | Ed25519 signing seed (64 hex chars) |
| `{__APP_SLUG_UPPER___MIN_APP_VERSION}` | Oldest launcher allowed to install the bundle |
| `{__APP_SLUG_UPPER___BUNDLE_VERSION}` | Pin the version seeded into the installer |
| `{__APP_SLUG_UPPER___SMOKE_PATHS}` | Extra routes the release smoke test must find healthy |
| `{__APP_SLUG_UPPER___SMOKE_DATA_FILE}` | File the server must create under `{UPPER}_HOME` |

On the first `pnpm release:ota`, a keypair may be generated and `desktop/src/main/crypto.mjs`
updated — **rebuild the launcher** after any key change, or installed copies will reject every new
bundle.

Generate keys manually:

```bash
node -e "const {generateKeyPairSync}=require('crypto');const {privateKey,publicKey}=generateKeyPairSync('ed25519');const sk=privateKey.export({type:'pkcs8',format:'der'}).slice(-32);const pk=publicKey.export({type:'spki',format:'der'}).slice(-32);console.log('PRIVATE='+sk.toString('hex'));console.log('PUBLIC='+pk.toString('hex'));"
```

## Release commands

From the product repo root (with `app/` present):

```bash
pnpm release:ota 1.0.0                # build, smoke-test, sign, upload
pnpm release:ota 1.0.0 --dry-run      # artifacts in .ota-staging/
pnpm release:ota 1.0.0 --seed-only    # installer seed only, no upload
pnpm release:desktop                  # macOS DMG + latest.json
pnpm release:desktop --dry-run
pnpm release:desktop:windows          # Windows x64 NSIS (run on Windows)
```

### macOS signing & notarization

1. Copy `scripts/deploy/apple-signing.env.example` → `scripts/deploy/apple-signing.env`
   (gitignored).
2. Fill in the Developer ID Application identity + an App Store Connect API key (recommended).
3. `release:desktop` runs electron-builder (which signs the app, the Electron frameworks and the
   packaged `Resources/node`, then notarizes and staples the `.app`), and
   `scripts/deploy/notarize-dmg.sh` then notarizes and staples the DMG itself.
4. The script verifies that `Resources/node` is signed and that it still runs under the hardened
   runtime, then blocks the upload unless Gatekeeper reports **Notarized Developer ID**.

## Client behavior (launcher)

1. Launch the installed bundle from the app data directory. On first launch, unpack the bundle
   shipped inside the DMG or NSIS installer (`Resources/seed-bundle/version`).
2. Open that version immediately. A download never blocks startup unless nothing local exists.
3. Once the window is up, fetch `manifest.json` (or the Windows variant). If it is newer and the
   launcher meets `minAppVersion`, download and verify in the background.
4. Leave the new files pending. The running server stays on the current version.
5. The app shows a bottom-left notice with Refresh
   (`desktop/updater/UpdateReadyNotice.tsx`). Refresh restarts onto the pending version, and rolls
   back to the previous one if the new server fails to answer.
6. Offline: keep running the installed or shipped bundle.
7. Old versions are pruned once a new one is serving traffic; the pending copy is kept.

## Checklist

| Step | Command / action |
|------|------------------|
| Replace all `__APP_*__` tokens | project-wide search |
| Wire `app/` standalone + health | AGENT.md |
| Launcher unit tests pass | `pnpm test:desktop` |
| R2 bucket + domain | Cloudflare |
| First OTA | `pnpm release:ota <version>` |
| Launcher build | `pnpm release:desktop` |
| Verify manifest | `curl -sS https://bundles.__APP_DOMAIN__/manifest.json` |
