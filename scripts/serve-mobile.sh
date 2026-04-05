#!/usr/bin/env bash
# serve-mobile.sh — host the procman PWA over LAN so your phone can install it.
#
# Usage:
#   ./scripts/serve-mobile.sh
#
# This runs Vite's dev server on 0.0.0.0:5174. On your phone:
#   1. Connect to same Wi-Fi as this Mac
#   2. Open Safari/Chrome → http://<mac-ip>:5174
#   3. Share → Add to Home Screen
#   4. Tap the procman icon → scan the QR from the desktop app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT/mobile"

if [[ ! -d node_modules ]]; then
  echo "▶ Installing PWA dependencies..."
  pnpm install
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")
echo ""
echo "▶ Serving procman PWA..."
echo "  On your phone, open: http://${LAN_IP}:5174"
echo ""

exec pnpm dev
