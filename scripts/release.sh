#!/usr/bin/env bash
# release.sh — one-shot procman release: version bump + build + sign + notarize.
#
# Usage:
#   ./scripts/release.sh                        # use current version in package.json
#   ./scripts/release.sh --version 0.2.0        # bump to 0.2.0 (package.json/tauri.conf.json/Cargo.toml)
#   ./scripts/release.sh --version 0.2.0-rc.1   # pre-release tag
#   ./scripts/release.sh --skip-notarize        # sign only
#   ./scripts/release.sh --dry-run              # print actions without executing build
#
# Environment variables (optional):
#   DEVELOPER_ID_APPLICATION  # "Developer ID Application: Name (TEAMID)" — autodetected if unset
#   APPLE_ID                  # Apple ID for notarization (e.g. you@example.com)
#   APPLE_TEAM_ID             # 10-char team id (e.g. ABCDE12345)
#   APPLE_NOTARIZE_PASSWORD   # App-specific password (notarytool --password)
#   APPLE_KEYCHAIN_PROFILE    # notarytool stored profile (alternative to the 3 above)
#
# Exit codes:
#   0 = OK, 1 = setup error, 2 = build failure, 3 = sign failure, 4 = notarize failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
TAURI_DIR="$APP_DIR/src-tauri"

VERSION=""
SKIP_NOTARIZE=0
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --skip-notarize) SKIP_NOTARIZE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { printf "\033[1;34m▶ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m⚠ %s\033[0m\n" "$*" >&2; }
err() { printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; }

# ───────── 1. Version sync ─────────
sync_version() {
  local v="$1"
  log "Syncing version → $v (package.json / tauri.conf.json / Cargo.toml)"

  # package.json
  node -e "const fs=require('fs');const p='$APP_DIR/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='$v';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"

  # tauri.conf.json — in-place regex replace on the top-level "version" field
  node -e "const fs=require('fs');const p='$TAURI_DIR/tauri.conf.json';let s=fs.readFileSync(p,'utf8');s=s.replace(/(\"version\"\s*:\s*\")[^\"]+(\")/,'\$1$v\$2');fs.writeFileSync(p,s);"

  # Cargo.toml — only the [package] version line (first match)
  node -e "const fs=require('fs');const p='$TAURI_DIR/Cargo.toml';let s=fs.readFileSync(p,'utf8');s=s.replace(/^version\s*=\s*\"[^\"]+\"/m,'version = \"$v\"');fs.writeFileSync(p,s);"
}

current_version() {
  node -p "require('$APP_DIR/package.json').version"
}

if [[ -n "$VERSION" ]]; then
  sync_version "$VERSION"
fi
EFFECTIVE_VERSION="$(current_version)"
log "Release version: $EFFECTIVE_VERSION"

# ───────── 2. Codesign identity ─────────
detect_identity() {
  if [[ -n "${DEVELOPER_ID_APPLICATION:-}" ]]; then
    echo "$DEVELOPER_ID_APPLICATION"
    return 0
  fi
  # Pick the first "Developer ID Application: …" from the keychain
  local line
  line="$(security find-identity -v -p codesigning 2>/dev/null | grep -E '"Developer ID Application:' | head -1 || true)"
  if [[ -n "$line" ]]; then
    # line format: "  1) HASH "Developer ID Application: Name (TEAMID)""
    echo "$line" | sed -E 's/.*"(Developer ID Application:[^"]+)".*/\1/'
    return 0
  fi
  echo ""
}

IDENTITY="$(detect_identity)"
if [[ -z "$IDENTITY" ]]; then
  warn "No 'Developer ID Application' certificate found — will ad-hoc sign (distribution unsupported)."
  IDENTITY="-"
else
  log "Using signing identity: $IDENTITY"
fi

# ───────── 3. Ensure toolchain ─────────
if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
command -v pnpm >/dev/null 2>&1 || { err "pnpm not found"; exit 1; }
command -v cargo >/dev/null 2>&1 || { err "cargo not found"; exit 1; }

# ───────── 4. Build ─────────
if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY-RUN: skipping build"
else
  log "Building mobile PWA (embedded via rust-embed)"
  (cd "$REPO_ROOT/mobile" && pnpm install --frozen-lockfile && pnpm build)

  log "Building Tauri release (pnpm tauri build)"
  cd "$APP_DIR"
  pnpm install --frozen-lockfile
  # Let Tauri sign all nested binaries inside-out. `--deep` post-sign is
  # deprecated by Apple and misses entitlements on nested Mach-Os, which
  # surfaces as notarytool status:Invalid.
  if [[ "$IDENTITY" != "-" ]]; then
    export APPLE_SIGNING_IDENTITY="$IDENTITY"
  fi
  if ! pnpm tauri build --bundles dmg app updater; then
    err "Tauri build failed"; exit 2
  fi
fi

DMG_PATH="$(ls -t "$TAURI_DIR"/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"
APP_PATH="$(ls -dt "$TAURI_DIR"/target/release/bundle/macos/*.app 2>/dev/null | head -1 || true)"

if [[ -z "$DMG_PATH" || -z "$APP_PATH" ]]; then
  err "Build artifacts not found (dmg=$DMG_PATH app=$APP_PATH)"
  exit 2
fi

# ───────── 5. Codesign verification ─────────
# Signing happens inside `tauri build` via APPLE_SIGNING_IDENTITY env.
# Here we only verify + optionally re-sign the DMG container.
log "Verifying .app signature"
if ! codesign -dv --verbose=2 "$APP_PATH" 2>&1 | tee /tmp/codesign-verify.log | head -10; then
  warn "codesign verify returned non-zero"
fi
if ! grep -q 'Developer ID Application' /tmp/codesign-verify.log; then
  if [[ "$IDENTITY" == "-" ]]; then
    warn "App is ad-hoc signed (expected in local dev)"
  else
    err "App was not signed with Developer ID (got: $(grep -i 'Authority=' /tmp/codesign-verify.log | head -1))"
    exit 3
  fi
fi

# DMG container itself needs a thin signature for notarytool (Tauri
# does this when APPLE_SIGNING_IDENTITY is set, but double-check).
if [[ "$IDENTITY" != "-" ]] && ! codesign -dv "$DMG_PATH" 2>/dev/null; then
  log "Signing DMG container (tauri did not)"
  codesign --force --sign "$IDENTITY" "$DMG_PATH" || warn "DMG codesign returned non-zero"
fi

# ───────── 6. Notarize ─────────
notarize() {
  local dmg="$1"
  if [[ "$SKIP_NOTARIZE" == "1" ]]; then
    warn "--skip-notarize set, skipping notarization"
    return 0
  fi
  if [[ "$IDENTITY" == "-" ]]; then
    warn "Ad-hoc signed; notarization not possible. Skipping."
    return 0
  fi

  local args=()
  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    args=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_NOTARIZE_PASSWORD:-}" ]]; then
    args=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_NOTARIZE_PASSWORD")
  else
    warn "Notarization credentials missing (set APPLE_KEYCHAIN_PROFILE or APPLE_ID+APPLE_TEAM_ID+APPLE_NOTARIZE_PASSWORD). Skipping."
    return 0
  fi

  log "Submitting DMG to Apple notary service (this takes 1-10 minutes)"
  local submit_log
  submit_log="$(xcrun notarytool submit "$dmg" "${args[@]}" --wait --timeout 20m 2>&1)"
  local submit_exit=$?
  echo "$submit_log"
  local sub_id
  sub_id="$(printf '%s\n' "$submit_log" | awk '/^  id: / { print $2; exit }')"
  if (( submit_exit != 0 )) || printf '%s\n' "$submit_log" | grep -q 'status: Invalid'; then
    err "Notarization was rejected (status: Invalid)."
    if [[ -n "$sub_id" ]]; then
      err "Fetching Apple notarization log for submission $sub_id:"
      xcrun notarytool log "$sub_id" "${args[@]}" || warn "notarytool log fetch failed"
    else
      warn "No submission id captured — cannot fetch detailed Apple log"
    fi
    return 4
  fi

  log "Stapling notarization ticket (Apple CloudKit may lag; will retry)"
  local attempt=1
  local max_attempts=6
  while (( attempt <= max_attempts )); do
    if xcrun stapler staple "$dmg"; then
      break
    fi
    if (( attempt == max_attempts )); then
      err "stapler failed after $max_attempts attempts"; return 4
    fi
    warn "stapler attempt $attempt/$max_attempts failed, retrying in 30s (ticket may not have propagated yet)"
    sleep 30
    (( attempt++ ))
  done

  log "Staple validation"
  xcrun stapler validate "$dmg" || warn "staple validate non-zero"
}

if ! notarize "$DMG_PATH"; then
  err "notarize step failed"; exit 4
fi

# ───────── 7. Gatekeeper check ─────────
if [[ "$IDENTITY" != "-" && "$SKIP_NOTARIZE" != "1" ]]; then
  if spctl --assess --type execute --verbose=2 "$APP_PATH" 2>&1; then
    log "Gatekeeper: PASS"
  else
    warn "Gatekeeper assessment failed (may need stapling on the .app too)"
  fi
fi

# ───────── 8. Done ─────────
printf "\n"
log "Release artifacts:"
printf "  DMG : %s (%s)\n" "$DMG_PATH" "$(du -h "$DMG_PATH" | cut -f1)"
printf "  APP : %s\n" "$APP_PATH"
printf "  VER : %s\n" "$EFFECTIVE_VERSION"
printf "\n"
echo "$DMG_PATH"
