#!/usr/bin/env bash
# Prune stale Rust build artifacts before a Tauri build so
# app/src-tauri/target/ doesn't balloon (Tauri debug targets grow into tens
# of GB over time). cargo-sweep understands cargo's fingerprint layout, so it
# removes only artifacts older than $SWEEP_DAYS days (default 7) plus anything
# built by a toolchain rustup no longer has installed — recently-touched code
# stays warm and incremental builds stay fast.
#
# Wired as the `tauri` npm script in app/package.json, so `pnpm tauri dev` /
# `pnpm tauri build` (and scripts/release.sh / install.sh, which call them)
# sweep first. No-op with a one-line hint when cargo-sweep isn't installed, so
# CI and other machines are unaffected. Set SWEEP_DAYS=0 to skip entirely.
set -euo pipefail

DAYS="${SWEEP_DAYS:-7}"
[ "$DAYS" = "0" ] && exit 0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/app/src-tauri"
TARGET="$CRATE/target"
[ -d "$TARGET" ] || exit 0

if ! command -v cargo-sweep >/dev/null 2>&1; then
  echo "sweep: cargo-sweep not installed — skipping stale-cache prune." >&2
  echo "sweep: install once with 'cargo install cargo-sweep' (or SWEEP_DAYS=0 to silence)." >&2
  exit 0
fi

kb() { du -sk "$1" 2>/dev/null | cut -f1 || echo 0; }
before="$(kb "$TARGET")"
# --time prunes by age; --installed drops artifacts from toolchains rustup no
# longer has (e.g. the old 1.85 pin, or a bumped stable). Best-effort.
cargo sweep --time "$DAYS" "$CRATE" >/dev/null 2>&1 || true
cargo sweep --installed "$CRATE" >/dev/null 2>&1 || true
after="$(kb "$TARGET")"

freed_mb=$(( (before - after) / 1024 ))
if [ "$freed_mb" -gt 0 ]; then
  echo "sweep: pruned ${freed_mb} MB of Rust artifacts older than ${DAYS}d (SWEEP_DAYS to tune)." >&2
fi
exit 0
