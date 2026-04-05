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
# Kill running instance so we can replace the .app bundle.
pkill -x procman 2>/dev/null || true

rm -rf "$INSTALLED_PATH"
cp -R "$BUILT" "$INSTALLED_PATH"

# Remove quarantine so macOS lets it run without "unidentified developer" prompt.
xattr -cr "$INSTALLED_PATH" 2>/dev/null || true

echo "✓ Installed $INSTALLED_PATH"

if [[ "$LAUNCH" == "1" ]]; then
  echo "▶ Launching..."
  open "$INSTALLED_PATH"
fi
