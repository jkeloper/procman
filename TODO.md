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
- Runtime snapshot IPC + frontend `RuntimeProvider`
- Backend `runtime://delta` metrics + ports events for lightweight runtime updates
- Batched runtime port ownership cache for process-tree / cwd matching
- Port ownership v3: backend-owned conflict checks across start / restart / start-all / group / remote paths
- Frontend visibility-aware polling for dashboard / remote / declared-port hooks
- LAN remote URL/TLS status display + backend LAN opt-in gate
- Remote pairing TLS hardening: certificate fingerprint in status/QR/mobile pairing + WebSocket query-token fallback removed
- Graceful shutdown UX: `process://shutdown` progress events, group Stop button, and configurable SIGTERM timeout
- Multi-window / tear-off log panel: individual process logs can open in dedicated Tauri windows
- Scheduled / cron execution: repeat a script on a five-field local-time cron expression
- xterm.js PTY shell: run a script in an interactive pseudo-terminal with stdin/resize support
- Mobile push notifications: mobile alerts for script crashes, port conflicts, and unreachable procman

## Planned (next)
- v0.2.0 release hardening: restore local/CI Developer ID private-key access; local `codesign` currently times out in the preflight probe.
- v0.2.0 release hardening: verify a signed release build with Apple notarization credentials and `TAURI_SIGNING_PRIVATE_KEY` in CI.
- v0.2.0 release hardening: manual QA for desktop lifecycle/logs/terminal/ports/remote pairing/mobile notifications.
- v0.2.0 release hardening: publish a draft GitHub Release and verify the generated updater `latest.json`.

## Not planned
- Team sharing / multi-user sync. procman stays a single-user tool.
- Windows / Linux port. macOS only.
- Cloud-hosted log aggregation. Local sqlite is the ceiling.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports via GitHub Issues (templates in `.github/`). Security disclosure per [SECURITY.md](SECURITY.md).
