#!/usr/bin/env bash
# Notarize and staple the DMG. electron-builder notarizes and staples the .app inside; the .dmg
# needs its own pass so Gatekeeper accepts it offline, straight from the download.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DMG_DIR="$ROOT/desktop/release"

if [[ ! -d "$DMG_DIR" ]]; then
  echo "✗ release directory not found: $DMG_DIR" >&2
  exit 1
fi

shopt -s nullglob
DMGS=("$DMG_DIR"/*.dmg)
if [[ ${#DMGS[@]} -eq 0 ]]; then
  echo "✗ No .dmg files in $DMG_DIR" >&2
  exit 1
fi

for dmg in "${DMGS[@]}"; do
  if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
    echo "→ $(basename "$dmg") is already stapled"
    continue
  fi
  echo "→ Notarizing $(basename "$dmg")"
  if [[ -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_KEY:-}" ]]; then
    xcrun notarytool submit "$dmg" \
      --issuer "$APPLE_API_ISSUER" \
      --key-id "$APPLE_API_KEY_ID" \
      --key "$APPLE_API_KEY" \
      --wait
  elif [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
    xcrun notarytool submit "$dmg" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
    xcrun notarytool submit "$dmg" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
  else
    echo "✗ Notarization credentials missing" >&2
    exit 1
  fi
  echo "→ Stapling $(basename "$dmg")"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
done

echo "✓ DMG notarization complete"
