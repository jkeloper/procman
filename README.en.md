    # 🐸 procman

**Local dev process manager with a GUI.** Manage all your dev servers, tunnels, and docker processes from one screen.

[한국어](README.md) | English

## Features

- **Script management** — Register, start/stop/restart scripts with one click
- **Real-time log viewer** — 5,000-line ring buffer, ANSI color rendering, search & filter
- **Port dashboard** — See what's listening, one-click kill conflicts
- **Group launch** — "Morning Stack" — start multiple services at once
- **Session restore** — Remembers what was running, offers to restart on next launch
- **Auto-detect** — Scans for `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `docker-compose.yml`, `.vscode/launch.json`
- **Remote control** — REST + WebSocket API, control from your phone
- **Mobile app** — Native iOS app via Capacitor
- **VSCode extension** — Sidebar panel for process control
- **Cloudflare Tunnel** — One-click external access
- **⌘K command palette** — Fuzzy search everything

## Screenshots

*(coming soon)*

## Quick Start

### Prerequisites
- macOS 14+
- Rust 1.85+ (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Node.js 20+ / pnpm 10 (`brew install pnpm`)

### Development
```bash
cd app
pnpm install
source "$HOME/.cargo/env"
pnpm tauri dev
```

### Build & Install
```bash
./scripts/install.sh          # build + install to /Applications
./scripts/install.sh --debug  # faster debug build
```

### Auto-rebuild
```bash
brew install fswatch
./scripts/watch-install.sh    # rebuilds on source changes
```

## Architecture

```
procman/
├── app/                    # Tauri desktop app
│   ├── src/                # React frontend (shadcn/ui + Tailwind)
│   └── src-tauri/          # Rust backend (tokio + axum)
├── mobile/                 # iOS/Android app (Capacitor)
├── vscode-extension/       # VSCode sidebar extension
├── scripts/                # Build automation
└── docs/                   # Planning documents
```

### Tech Stack
- **Desktop**: Tauri v2 (Rust + React/TypeScript)
- **UI**: shadcn/ui + Tailwind CSS v4
- **Backend**: tokio, axum, dashmap, portable-pty
- **Mobile**: Capacitor 8 + React
- **Remote API**: REST + WebSocket, bearer token auth, rate limiting
- **Theme**: Forest green 🌲 with 🐸 frog mascot

## Remote Access

1. Desktop → Dashboard → Network → **Start (LAN)**
2. Copy the URL + token
3. Phone → open URL → paste token → connected

For external access: click **"Expose via Cloudflare"** → get a public HTTPS URL.

## Security

- 256-bit CSPRNG bearer tokens
- Rate limiting (10 req/s per IP)
- CORS restricted to known origins
- CSP enforced
- File permissions 0600 on sensitive files
- Process group kill (no zombies)
- See [SECURITY.md](SECURITY.md) for full details

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
