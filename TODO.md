# Roadmap

Public roadmap. Internal planning, decision logs, and completed-issue detail are kept in `docs/private/TODO.full.md` (gitignored).

## Shipped (pre-v0.2.0)
- Project / script CRUD with filesystem scanning
- Process lifecycle: login-shell wrap, pgid-based kill, zombie-free
- Ring-buffered log viewer (react-window + ansi-to-html)
- Port dashboard with liveness probe
- `depends_on` wait gate (30 s TCP probe)
- CPU/RSS observability
- Group execution ("Morning Stack")
- ⌘K command palette
- Session restore
- VSCode `launch.json` / `tasks.json` import
- Cloudflare Tunnel recovery
- Mobile PWA + iOS Capacitor shell
- Remote API (REST + WebSocket) with pairing + token rotation
- Auto-updater via GitHub Releases
- Docker Compose integration
- sqlite FTS5 log persistence + search
- Auto-restart policy UI
- Onboarding overlay
- Start-at-login (LaunchAgent)

## Planned (next)
- **Multi-window / tear-off log panel** — pop individual process log streams into their own windows.
- **Scheduled / cron execution** — repeat a script on a cron expression.
- **xterm.js PTY shell** — interactive terminal tab for processes that need stdin (REPL, `docker exec`).
- **Mobile push notifications** — crash / port-conflict notifications when procman is unreachable.
- **Graceful shutdown UX** — progress indicator + configurable timeout when stopping groups.

## Not planned
- Team sharing / multi-user sync. procman stays a single-user tool.
- Windows / Linux port. macOS only.
- Cloud-hosted log aggregation. Local sqlite is the ceiling.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports via GitHub Issues (templates in `.github/`). Security disclosure per [SECURITY.md](SECURITY.md).
