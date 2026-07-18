#!/usr/bin/env bash
# Verify that every desktop release manifest and the optional Git tag agree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${PROCMAN_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
EXPECTED=""
TAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expected) EXPECTED="${2:?missing value for --expected}"; shift 2 ;;
    --expected=*) EXPECTED="${1#*=}"; shift ;;
    --tag) TAG="${2:?missing value for --tag}"; shift 2 ;;
    --tag=*) TAG="${1#*=}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$EXPECTED" ]]; then
  EXPECTED="$(node -p "require('$REPO_ROOT/app/package.json').version")"
fi

if [[ ! "$EXPECTED" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid release version: $EXPECTED" >&2
  exit 1
fi

node - "$REPO_ROOT" "$EXPECTED" <<'NODE'
const fs = require('fs');
const path = require('path');
const [root, expected] = process.argv.slice(2);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const jsonVersion = (file) => JSON.parse(read(file)).version;
const toml = read('app/src-tauri/Cargo.toml');
const cargoVersion = toml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const lock = read('app/src-tauri/Cargo.lock');
const lockVersion = lock.match(/\[\[package\]\]\s+name = "procman"\s+version = "([^"]+)"/m)?.[1];
const site = read('web/src/config/site.ts');
const siteVersion = site.match(/^\s*version:\s*'([^']+)'/m)?.[1];
const siteDmgVersion = site.match(/procman_([^/]+)_aarch64\.dmg/)?.[1];
const readme = read('README.md');
const releaseMarkers = [...readme.matchAll(/<!--\s*latest-release:\s*([^\s]+)\s*-->/g)].map((m) => m[1]);
// Only bolded release-status claims ("**vX.Y.Z is the latest stable
// release…**") are product-version surfaces. A whole-file dotted-triple scan
// would turn any future "nodejs 24.14.0" or "since v0.2.0" prose into a
// misleading release failure.
const readmeProductVersions = [...readme.matchAll(/\*\*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[^*]*\*\*/g)].map((m) => m[1]);
const readmeDmgVersions = [...readme.matchAll(/procman_([^/]+)_aarch64\.dmg/g)].map((m) => m[1]);
const versions = {
  'app/package.json': jsonVersion('app/package.json'),
  'app/src-tauri/tauri.conf.json': jsonVersion('app/src-tauri/tauri.conf.json'),
  'app/src-tauri/Cargo.toml': cargoVersion,
  'app/src-tauri/Cargo.lock': lockVersion,
  'web/src/config/site.ts version': siteVersion,
  'web/src/config/site.ts DMG': siteDmgVersion,
};
const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);
if (mismatches.length) {
  for (const [file, version] of mismatches) {
    console.error(`${file}: expected ${expected}, found ${version ?? 'missing'}`);
  }
  process.exit(1);
}
if (releaseMarkers.length !== 1 || releaseMarkers[0] !== expected) {
  console.error(`README.md: expected one latest-release marker for ${expected}, found ${releaseMarkers.join(', ') || 'none'}`);
  process.exit(1);
}
if (readmeProductVersions.length === 0 || readmeProductVersions.some((version) => version !== expected)) {
  console.error(`README.md: bolded release-status versions must all be ${expected}; found ${[...new Set(readmeProductVersions)].join(', ') || 'none'}`);
  process.exit(1);
}
if (readmeDmgVersions.length !== 2 || readmeDmgVersions.some((version) => version !== expected)) {
  console.error(`README.md: expected two ${expected} DMG URLs; found ${readmeDmgVersions.join(', ') || 'none'}`);
  process.exit(1);
}
if (!read('CHANGELOG.md').includes(`## [${expected}]`)) {
  console.error(`CHANGELOG.md: missing release section ## [${expected}]`);
  process.exit(1);
}
console.log(`release manifests and public surfaces agree on ${expected}`);
NODE

if [[ -n "$TAG" ]]; then
  if [[ "$TAG" != "v$EXPECTED" ]]; then
    echo "tag/version mismatch: tag=$TAG expected=v$EXPECTED" >&2
    exit 1
  fi
  git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null || {
    echo "release tag does not exist: $TAG" >&2
    exit 1
  }
  tag_commit="$(git -C "$REPO_ROOT" rev-list -n 1 "$TAG")"
  head_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  if [[ "$tag_commit" != "$head_commit" ]]; then
    echo "release tag $TAG points to $tag_commit, checkout is $head_commit" >&2
    exit 1
  fi
  echo "release tag $TAG points to the checked-out commit"
fi
