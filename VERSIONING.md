# Versioning policy

procman contains several independently distributed artifacts. Their version numbers intentionally do not all match.

## Desktop product release

`app/package.json` is the canonical desktop product version. A desktop release must keep these public surfaces synchronized:

- `app/package.json`
- `app/src-tauri/tauri.conf.json`
- `app/src-tauri/Cargo.toml`
- procman's package entry in `app/src-tauri/Cargo.lock`
- `web/src/config/site.ts` (`version` and versioned DMG URL)
- the root README release marker, status, and versioned DMG URLs
- the matching release section in `CHANGELOG.md`

The desktop UI reads Tauri's package version, while `/api/health` and the WebSocket hello event read Rust's `CARGO_PKG_VERSION`. Keeping the four desktop manifests synchronized therefore covers the runtime surfaces as well.

Use `scripts/release.sh --version X.Y.Z` to update machine-owned version fields. `scripts/check-release-version.sh` verifies all release surfaces and CI runs it on every change.

## Independent versions

These values have separate release lifecycles and must not be changed by a desktop version bump:

- `mobile/package.json`: private build-package metadata for the embedded companion PWA.
- iOS `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`: App Store marketing/build versions.
- `vscode-extension/package.json`: VS Code Marketplace extension version.
- `web/package.json`: private landing-site build-package version.
- Config `version` in `config.yaml`: persistence schema version, currently v4.

The mobile PWA is embedded into the desktop binary at build time, but its private npm package version is not a user-visible compatibility contract.

## Documentation policy

Living documentation describes the test commands and required gates without hard-coding test counts. Counts naturally change whenever tests are added; historical counts may remain in dated CHANGELOG or roadmap entries as release evidence.

Toolchain versions are owned by `.tool-versions`. Workflows should read that file rather than repeat versions where the runner supports it. GitHub's Node setup reads the file directly; the Rust toolchain action repeats the exact pin, so `scripts/check-docs-current.sh` verifies that `.tool-versions`, Cargo's `rust-version`, and both CI/release workflows agree.
