# Changelog

Public-facing changelog. Internal incident/audit detail is kept in `docs/private/CHANGELOG.full.md` (gitignored).

## [Unreleased]

### Added
- **iOS App Store prep** — `PrivacyInfo.xcprivacy` privacy manifest, `NSLocalNetworkUsageDescription` + `ITSAppUsesNonExemptEncryption=false` + `UIRequiresFullScreen=false` in Info.plist, "How it works" explainer card on the pair screen so reviewers understand the companion-app model. Submission checklist and review notes in `docs/private/` (gitignored).
- **Auto-updater** — Tauri updater plugin wired to GitHub Releases. Check & install from Settings.
- **Release automation** — `scripts/release.sh` and `.github/workflows/release.yml` build, codesign (Developer ID), and notarize DMGs. Tag push (`v*.*.*`) triggers a draft Release.
- **Docker Compose integration** — register `docker-compose.yml` stacks, one-click up/down/ps from the dashboard.
- **Persistent logs (sqlite FTS5)** — each process line is appended to `logs.db` with full-text index. Log viewer gains a search input that queries history beyond the 5 000-line memory buffer.
- **Onboarding** — first-run 3-step overlay: select folder → scan scripts → start the first one.
- **Settings dialog** — log buffer size slider, launch-at-login toggle, LAN remote opt-in, port alias editor.
- **Auto-restart policy** — per-script structured policy (`enabled / max_retries / backoff_ms / jitter_ms`). Legacy `auto_restart: true` still works.
- **Graceful shutdown order** — stopping a script first stops any scripts that declare it in `depends_on`.
- **Crash log** — panic hook writes to `~/Library/Application Support/procman/crash.log` with stderr mirror, 1 MB rotation.
- **Audit log rotation** — remote API audit log rotates at 5 MB × 3 keep.
- **Start-at-login** — LaunchAgent plist generated on demand.
- **VSCode extension** — sidebar for process control (read-only scan of `launch.json` / `tasks.json`).

### Changed
- **Remote API hardening** — LAN mode is opt-in (off by default) and can be bound to TLS via a self-signed certificate when enabled. Rate-limiting on authenticated routes. CORS tightened. WebSocket bearer token moved from query string to `Sec-WebSocket-Protocol`.
- **Config migration v2 → v3** — schema carries `auto_restart_policy`, `lan_mode_opt_in`, `start_at_login`, `onboarded`. Safe downgrade-compatible via serde defaults.
- **Process status** — backend broadcasts CPU/RSS metrics as a `process://metrics` event, replacing per-client polling.
- **Port scanning** — 500 ms cache on `lsof` listings avoids N× calls per polling interval.
- **Docs** — planning artefacts moved to `docs/archive/`. Active design docs live directly under `docs/`.

### Security
See [SECURITY.md](SECURITY.md) for the current threat model and how to report issues. Detailed incident history is maintained privately; the public changelog summarises fixes at release granularity.

### Testing
Rust: 167 unit tests. TypeScript (vitest): 23 tests across schemas / tauri IPC / components. CI runs `cargo test --lib`, `cargo clippy -- -D warnings`, and `pnpm tsc --noEmit` on `macos-latest` for every push / PR.

---

## Earlier

Pre-Unreleased history (MVP, port management v2, liveness probe, observability, `depends_on`, mobile PWA, iOS Capacitor, remote API, Cloudflare Tunnel integration) is condensed here intentionally; see release tags for the granular rollout once v0.2.0 is cut.
