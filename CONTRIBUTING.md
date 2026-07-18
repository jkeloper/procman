# Contributing to procman

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

### Prerequisites
- macOS 14+
- Rust 1.88+ (`rustup`)
- Node.js and pnpm versions pinned in `.tool-versions`
- Xcode (for iOS builds)

### Getting Started
```bash
git clone https://github.com/jkeloper/procman.git
cd procman
(cd app && pnpm install)
source "$HOME/.cargo/env"
(cd app && pnpm tauri dev)    # starts dev server on :1420
```

### Running Tests
```bash
(cd app/src-tauri && cargo test --lib)
(cd app && pnpm test && pnpm lint && pnpm build)
(cd mobile && pnpm test && pnpm lint && pnpm build)
swift test --package-path mobile/ios/PinnedTransportCore
(cd mobile && pnpm exec cap sync ios)
xcodebuild -project mobile/ios/App/App.xcodeproj -scheme App -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
(cd vscode-extension && pnpm typecheck && pnpm test && pnpm build)
scripts/test-repository-checks.sh
```

## Project Structure
- `app/` — Tauri desktop app (Rust backend + React frontend)
- `mobile/` — iOS/Android client (Capacitor + React)
- `vscode-extension/` — VSCode sidebar extension
- `scripts/` — build/install automation
- `spikes/` — archived Week 0 spike results

## Pull Requests
1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run the repository-root test commands above
5. Commit with a descriptive message
6. Push and open a PR

## Code Style
- Rust: `cargo fmt` + `cargo clippy`
- TypeScript: `pnpm lint`
- Commits: conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`)

## Reporting Issues
Please use GitHub Issues with the provided templates. Include:
- OS version
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if UI-related

## Security
See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
