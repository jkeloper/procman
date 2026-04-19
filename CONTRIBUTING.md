# Contributing to procman

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

### Prerequisites
- macOS 14+
- Rust 1.85+ (`rustup`)
- Node.js 20+ / pnpm 10+
- Xcode (for iOS builds)

### Getting Started
```bash
git clone https://github.com/jkeloper/procman.git
cd procman/app
pnpm install
source "$HOME/.cargo/env"
pnpm tauri dev    # starts dev server on :1420
```

### Running Tests
```bash
cd app/src-tauri
cargo test --lib
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
4. Run `cargo test --lib` and `pnpm tsc -b --noEmit`
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
