#!/usr/bin/env bash
# watch-install.sh — rebuild & reinstall procman on source changes.
#
# Usage:
#   ./scripts/watch-install.sh            # debug build (fast) on change
#   ./scripts/watch-install.sh --release  # full release build (slow)
#
# NOTE: For day-to-day development use `pnpm tauri dev` (HMR, <1s reload).
# This script is for "I want the installed /Applications/procman.app to
# stay in sync with my source" — rebuilds take 30-120s even in debug mode.
#
# Requires: fswatch (brew install fswatch)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/app"

MODE_FLAG="--debug"
for arg in "$@"; do
  case "$arg" in
    --release) MODE_FLAG="" ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

if ! command -v fswatch >/dev/null 2>&1; then
  echo "fswatch not installed. Run: brew install fswatch" >&2
  exit 1
fi

echo "▶ Watching $APP_DIR/src and $APP_DIR/src-tauri/src for changes..."
echo "  (Ctrl+C to stop. First build runs now.)"

# Run once immediately.
"$SCRIPT_DIR/install.sh" $MODE_FLAG --no-run

# Debounce: fswatch -l 2 emits batched events every 2s.
fswatch -o -l 2 \
  "$APP_DIR/src" \
  "$APP_DIR/src-tauri/src" \
  "$APP_DIR/src-tauri/Cargo.toml" \
  "$APP_DIR/src-tauri/tauri.conf.json" \
  | while read -r _; do
  echo ""
  echo "▶ Change detected, rebuilding..."
  if "$SCRIPT_DIR/install.sh" $MODE_FLAG --no-run; then
    echo "✓ $(date +%H:%M:%S) procman updated"
  else
    echo "✗ build failed — keeping previous install"
  fi
done
