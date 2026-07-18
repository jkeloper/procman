#!/usr/bin/env bash
# Reject volatile test counts in living docs and keep package/toolchain pins
# aligned. Historical release records in CHANGELOG/TODO are intentionally
# excluded.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${PROCMAN_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

node - "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const files = ['README.md', 'app/README.md', 'CLAUDE.md'];
const patterns = [
  /\b\d+\s+(?:unit\s+)?tests?\b/i,
  /\d+\s*개\s*(?:unit\s*)?테스트/,
  /\b(?:cargo|vitest)\s+\d+\b/i,
];
let failed = false;
for (const file of files) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (patterns.some((pattern) => pattern.test(line))) {
      console.error(`${file}:${index + 1}: volatile test count: ${line.trim()}`);
      failed = true;
    }
  });
}
if (failed) process.exit(1);
const toolVersions = fs.readFileSync(path.join(root, '.tool-versions'), 'utf8');
const pnpmVersion = toolVersions.match(/^pnpm\s+(\S+)/m)?.[1];
const rustVersion = toolVersions.match(/^rust\s+(\S+)/m)?.[1];
const webPackageManager = JSON.parse(
  fs.readFileSync(path.join(root, 'web/package.json'), 'utf8'),
).packageManager;
if (!pnpmVersion || webPackageManager !== `pnpm@${pnpmVersion}`) {
  console.error(`web/package.json: expected packageManager pnpm@${pnpmVersion ?? 'missing'}, found ${webPackageManager ?? 'missing'}`);
  process.exit(1);
}
const cargoManifest = fs.readFileSync(
  path.join(root, 'app/src-tauri/Cargo.toml'),
  'utf8',
);
const cargoRustVersion = cargoManifest.match(/^rust-version\s*=\s*"([^"]+)"/m)?.[1];
// Cargo's rust-version is a major.minor MSRV; .tool-versions pins the exact
// toolchain. Prefix-match so a future patch pin (e.g. 1.88.1) still agrees.
const toolchainMatchesCargo =
  rustVersion && cargoRustVersion &&
  (rustVersion === cargoRustVersion || rustVersion.startsWith(`${cargoRustVersion}.`));
if (!toolchainMatchesCargo) {
  console.error(`app/src-tauri/Cargo.toml: rust-version ${cargoRustVersion ?? 'missing'} does not match .tool-versions rust ${rustVersion ?? 'missing'}`);
  process.exit(1);
}
for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  const source = fs.readFileSync(path.join(root, workflow), 'utf8');
  if (!source.includes(`dtolnay/rust-toolchain@${rustVersion}`)) {
    console.error(`${workflow}: expected dtolnay/rust-toolchain@${rustVersion}`);
    process.exit(1);
  }
  if (!source.includes('swift test --package-path mobile/ios/PinnedTransportCore')) {
    console.error(`${workflow}: missing iOS pinning-core test gate`);
    process.exit(1);
  }
  const capacitorSync = source.indexOf('pnpm exec cap sync ios');
  const iosBuild = source.indexOf('xcodebuild');
  if (capacitorSync < 0 || iosBuild < 0 || capacitorSync > iosBuild) {
    console.error(`${workflow}: iOS resources must be generated with cap sync before xcodebuild`);
    process.exit(1);
  }
  if (!source.includes('mobile/ios/App/App.xcodeproj')) {
    console.error(`${workflow}: missing unsigned iOS application build gate`);
    process.exit(1);
  }
}
console.log('living documentation contains no volatile test counts');
console.log(`web package manager matches .tool-versions (${pnpmVersion})`);
console.log(`Cargo and workflows match the Rust toolchain (${rustVersion})`);
console.log('CI and release both verify the native iOS pinning boundary');
NODE
