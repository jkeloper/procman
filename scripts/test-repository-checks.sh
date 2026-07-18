#!/usr/bin/env bash
# Exercise repository policy checks against an isolated fixture, including
# failure cases. This keeps an accidentally weakened checker from passing CI
# merely because the current checkout happens to be internally consistent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/procman-repo-checks.XXXXXX")"
OUTPUT="$FIXTURE/check-output.log"
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p \
  "$FIXTURE/.github/workflows" \
  "$FIXTURE/app/src-tauri" \
  "$FIXTURE/web/src/config"

copy_fixture() {
  cp "$REPO_ROOT/.tool-versions" "$FIXTURE/.tool-versions"
  cp "$REPO_ROOT/README.md" "$FIXTURE/README.md"
  cp "$REPO_ROOT/CHANGELOG.md" "$FIXTURE/CHANGELOG.md"
  cp "$REPO_ROOT/CLAUDE.md" "$FIXTURE/CLAUDE.md"
  cp "$REPO_ROOT/app/README.md" "$FIXTURE/app/README.md"
  cp "$REPO_ROOT/app/package.json" "$FIXTURE/app/package.json"
  cp "$REPO_ROOT/app/src-tauri/tauri.conf.json" "$FIXTURE/app/src-tauri/tauri.conf.json"
  cp "$REPO_ROOT/app/src-tauri/Cargo.toml" "$FIXTURE/app/src-tauri/Cargo.toml"
  cp "$REPO_ROOT/app/src-tauri/Cargo.lock" "$FIXTURE/app/src-tauri/Cargo.lock"
  cp "$REPO_ROOT/.github/workflows/ci.yml" "$FIXTURE/.github/workflows/ci.yml"
  cp "$REPO_ROOT/.github/workflows/release.yml" "$FIXTURE/.github/workflows/release.yml"
  cp "$REPO_ROOT/web/package.json" "$FIXTURE/web/package.json"
  cp "$REPO_ROOT/web/src/config/site.ts" "$FIXTURE/web/src/config/site.ts"
}

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$OUTPUT" 2>&1; then
    echo "expected failure was accepted: $label" >&2
    return 1
  fi
}

copy_fixture
VERSION="$(node -p "require('$FIXTURE/app/package.json').version")"

PROCMAN_REPO_ROOT="$FIXTURE" "$SCRIPT_DIR/check-release-version.sh" --expected "$VERSION"
PROCMAN_REPO_ROOT="$FIXTURE" "$SCRIPT_DIR/check-docs-current.sh"

node - "$FIXTURE/web/src/config/site.ts" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, source.replace(/(version:\s*')[^']+(')/, '$19.9.9$2'));
NODE
expect_failure "landing-site version mismatch" \
  env PROCMAN_REPO_ROOT="$FIXTURE" \
  "$SCRIPT_DIR/check-release-version.sh" --expected "$VERSION"

copy_fixture
printf '\nRepository currently has 999 tests.\n' >> "$FIXTURE/README.md"
expect_failure "volatile test count in living documentation" \
  env PROCMAN_REPO_ROOT="$FIXTURE" \
  "$SCRIPT_DIR/check-docs-current.sh"

copy_fixture
node - "$FIXTURE/web/package.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
json.packageManager = 'pnpm@0.0.0';
fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
NODE
expect_failure "package-manager pin mismatch" \
  env PROCMAN_REPO_ROOT="$FIXTURE" \
  "$SCRIPT_DIR/check-docs-current.sh"

copy_fixture
node - "$FIXTURE/app/src-tauri/Cargo.toml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, source.replace(/^rust-version\s*=\s*"[^"]+"/m, 'rust-version = "1.85"'));
NODE
expect_failure "Cargo minimum Rust mismatch" \
  env PROCMAN_REPO_ROOT="$FIXTURE" \
  "$SCRIPT_DIR/check-docs-current.sh"

copy_fixture
node - "$FIXTURE/.github/workflows/ci.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, source.replace(/dtolnay\/rust-toolchain@[^\s]+/, 'dtolnay/rust-toolchain@1.85.0'));
NODE
expect_failure "CI Rust toolchain mismatch" \
  env PROCMAN_REPO_ROOT="$FIXTURE" \
  "$SCRIPT_DIR/check-docs-current.sh"

copy_fixture
node - "$FIXTURE/.github/workflows/ci.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, source.replace('swift test --package-path mobile/ios/PinnedTransportCore', 'echo native-test-removed'));
NODE
expect_failure "missing iOS pinning-core CI gate" \
  env PROCMAN_REPO_ROOT="$FIXTURE" \
  "$SCRIPT_DIR/check-docs-current.sh"

copy_fixture
node - "$FIXTURE/.github/workflows/ci.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, source.replace('pnpm exec cap sync ios', 'echo ios-sync-removed'));
NODE
expect_failure "missing Capacitor sync before iOS CI build" \
  env PROCMAN_REPO_ROOT="$FIXTURE" \
  "$SCRIPT_DIR/check-docs-current.sh"

copy_fixture
node - "$FIXTURE/.github/workflows/release.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, source.replace(/xcodebuild[^\n]+mobile\/ios\/App\/App\.xcodeproj[^\n]*/, 'echo ios-build-removed'));
NODE
expect_failure "missing iOS application release build gate" \
  env PROCMAN_REPO_ROOT="$FIXTURE" \
  "$SCRIPT_DIR/check-docs-current.sh"

echo "repository policy check tests passed"
