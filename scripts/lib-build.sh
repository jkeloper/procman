#!/usr/bin/env bash
# lib-build.sh — shared build steps for procman packaging scripts.
#
# Sourced by install.sh and release.sh so the mobile-PWA build step never
# diverges between code paths. The mobile dist/ is embedded into the Rust
# binary at compile time via rust-embed (see app/src-tauri/src/server/spa.rs).
# If it is missing or stale, a "successful" tauri build silently ships an
# empty SPA and LAN / mobile / QR pairing 404s — so this build MUST run
# before `pnpm tauri build`.
#
# Expects callers to define REPO_ROOT. Provides:
#   build_mobile_pwa            — install deps + build mobile/dist (always)
#   build_mobile_pwa_if_missing — same, but skips if mobile/dist looks built

# Resolve REPO_ROOT if a caller sourced us without setting it.
if [[ -z "${REPO_ROOT:-}" ]]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

MOBILE_DIR="$REPO_ROOT/mobile"
MOBILE_DIST="$MOBILE_DIR/dist"

# True when mobile/dist exists and contains the SPA entrypoint rust-embed
# needs. We key off index.html because an empty dir or a half-deleted build
# would otherwise pass a bare `-d` check and embed nothing useful.
mobile_dist_is_built() {
  [[ -f "$MOBILE_DIST/index.html" ]]
}

# Build the mobile PWA into mobile/dist. Uses --frozen-lockfile for
# reproducible installs (mobile/pnpm-lock.yaml is committed). `pnpm build`
# runs `tsc -b && vite build`, emitting to mobile/dist (vite default outDir).
build_mobile_pwa() {
  printf "\033[1;34m▶ Building mobile PWA (embedded via rust-embed)\033[0m\n"
  (cd "$MOBILE_DIR" && pnpm install --frozen-lockfile && pnpm build)
}

# Like build_mobile_pwa but skips the rebuild when mobile/dist is already
# present. Used by fast iteration paths (install.sh --debug) where the
# mobile bundle rarely changes and the rebuild dominates wall time.
build_mobile_pwa_if_missing() {
  if mobile_dist_is_built; then
    printf "\033[1;34m▶ mobile/dist present — skipping mobile build\033[0m\n"
    return 0
  fi
  build_mobile_pwa
}
