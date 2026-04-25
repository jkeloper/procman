#!/usr/bin/env bash
# install.sh — build procman and install to /Applications
#
# Usage:
#   ./scripts/install.sh           # release build + install + launch
#   ./scripts/install.sh --no-run  # build + install, don't launch
#   ./scripts/install.sh --debug   # faster debug build (not optimized)
#
# After first install, subsequent runs replace the .app in-place so
# Dock/Spotlight/Launchpad references stay valid.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
INSTALL_DIR="/Applications"
APP_NAME="procman.app"
INSTALLED_PATH="$INSTALL_DIR/$APP_NAME"

MODE="release"
LAUNCH=1
for arg in "$@"; do
  case "$arg" in
    --debug)  MODE="debug" ;;
    --no-run) LAUNCH=0 ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

# Ensure cargo is on PATH
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
fi

echo "▶ Building procman ($MODE)..."
cd "$APP_DIR"

# Tauri 2 with createUpdaterArtifacts=true needs TAURI_SIGNING_PRIVATE_KEY
# to produce the .app.tar.gz.sig sidecar. CI injects it from secrets;
# locally we read the key file the developer generated once via
# `pnpm tauri signer generate -w ~/.tauri/procman.key`.
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$HOME/.tauri/procman.key" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/procman.key")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
fi

if [[ "$MODE" == "debug" ]]; then
  pnpm tauri build --debug --bundles app
  BUILT="$APP_DIR/src-tauri/target/debug/bundle/macos/$APP_NAME"
else
  pnpm tauri build --bundles app
  BUILT="$APP_DIR/src-tauri/target/release/bundle/macos/$APP_NAME"
fi

if [[ ! -d "$BUILT" ]]; then
  echo "✗ build output not found: $BUILT" >&2
  exit 1
fi

echo "▶ Installing to $INSTALLED_PATH..."
# Gracefully quit procman so RunEvent::Exit kills all managed
# process groups. osascript triggers the proper AppKit lifecycle;
# pkill is a fallback if the app doesn't respond to AppleEvents.
osascript -e 'quit app "procman"' 2>/dev/null || true
# Wait up to 3 seconds for procman to exit and clean up children.
for i in 1 2 3 4 5 6; do
  pgrep -x procman >/dev/null 2>&1 || break
  sleep 0.5
done
# Force-kill if it's still hanging.
pkill -9 -x procman 2>/dev/null || true
sleep 0.3

rm -rf "$INSTALLED_PATH"
cp -R "$BUILT" "$INSTALLED_PATH"

# Remove quarantine so macOS lets it run without "unidentified developer" prompt.
xattr -cr "$INSTALLED_PATH" 2>/dev/null || true

echo "✓ Installed $INSTALLED_PATH"

if [[ "$LAUNCH" == "1" ]]; then
  echo "▶ Launching..."
  open "$INSTALLED_PATH"
fi
