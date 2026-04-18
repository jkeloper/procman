#!/bin/bash
set -euo pipefail

# procman Mac DMG release build script.
# Prerequisites:
#   1. "Developer ID Application" certificate in Keychain
#   2. Notarization credentials stored:
#      xcrun notarytool store-credentials "procman-notarize" \
#        --apple-id "you@example.com" \
#        --team-id "<TEAM_ID>" \
#        --password "<APP_SPECIFIC_PASSWORD>"

cd "$(dirname "$0")/../app"

# Build mobile PWA first (embedded in Rust binary via rust-embed)
echo "=== Building mobile PWA ==="
(cd ../mobile && pnpm build)

# Release build with code signing + notarization
echo "=== Building Tauri release ==="
source ~/.cargo/env
pnpm tauri build

DMG_PATH=$(ls src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1)
APP_PATH=$(ls -d src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1)

if [ -z "$DMG_PATH" ]; then
  echo "ERROR: DMG not found"
  exit 1
fi

echo ""
echo "=== Verifying ==="
codesign -dv "$APP_PATH" 2>&1 | head -5
echo ""

if spctl --assess --type execute "$APP_PATH" 2>&1; then
  echo "Gatekeeper: PASS"
else
  echo "Gatekeeper: FAIL (may need notarization credentials)"
fi

echo ""
echo "DMG: $DMG_PATH"
echo "Size: $(du -h "$DMG_PATH" | cut -f1)"
echo ""
echo "Done. Distribute this DMG file."
