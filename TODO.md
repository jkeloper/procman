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

## v0.3 — targeted refactor (complete — committed on `redesign/v0.3-targeted-refactor`, review-hardened)
Outcome of a full-codebase assessment: keep the verified core (race-safe kill, config/runtime persistence, pure helpers) verbatim and surgically close the gaps that block the "one screen to govern everything" goal. No new scope beyond the existing goal.
- [x] WS1 — pipeline trust: clean-install mobile embed (`lib-build.sh`), CI vitest/eslint gates + mobile build before Rust job, audit disk persistence + token-rotation WS cutoff, vscode-extension WS subprotocol auth
- [x] WS2 — preserve crash logs (retain a `Crashed` state instead of dropping the in-memory buffer) + `dismiss_process` command; live-only filtering of deps/metrics/ownership
- [x] WS3 — remove port-status fan-out (cached ownership snapshot + batch `port_status_all` across desktop/mobile/REST; conflict checks stay fresh)
- [x] WS4 — gate kill()'s pre-SIGTERM `lsof` descendant sweep on liveness (`!exited_flag`) for every live script (post-review correction: the interim "port-declaring only" gate leaked detached daemons spawned by port-free scripts)
- [x] WS5 — backend-owned running state (spawn marks; stop/dismiss/delete/clean-exit clear; restart/shutdown preserve) + single `depends_on` ordering engine (`resolve_dep_order`) behind group launches with readiness gating. (Restore-prompt still consumes push order; backend ordered-start lands in WS6.)
- [x] WS6 — global "all running" view (dashboard first tab, crashed-first, CPU/RSS summary, inline controls) + `ProcessGrid` decomposition (`ScriptRow`/`useScriptActions`/`useTunnelLauncher`) + multi-project log pool + crash dismiss + dependency-ordered session restore (`last_running_ordered`). (Gate nits — global Start conflict dialog, ✕ semantics, log-tab UX — fold into WS7.)
- [x] WS7 — unified toast/confirm feedback (Retry actions) + global Start conflict pre-flight + `✕`=crashed-dismiss + lazy/announced log tabs + global crashed mini-badge + `ScriptEditor` progressive disclosure + dropped `expected_port`/`PortSpec.proto` dead model (config **v4** migration promotes legacy `expected_port` → `ports[0]`)
- [x] WS8 — mobile group run (`POST /api/groups/:id/run`) + port Stop (owning script, audited) + ANSI-colour logs + `latest.json` Intel false-entry removed
- [x] WS9 — single process runtime: `ProcessManager` owns the lifecycle of both piped and PTY runs (`register_pty`/`notify_pty_exit`), so PTY-backed scripts get the same `killpg` race-safe kill + orphan sweep, crash retention, CPU/RSS metrics, and session marking; `PtyManager` demoted to a PTY-I/O front-end; double-run (piped+pty on one script) prevented via the `is_live` guard (→ uniform kill+restart); `ProcessSnapshot.kind` badges interactive runs. Verified piped race-safety core unchanged (additive only); evaluator gate `pass_with_nits` (all 5 invariants TRUE), zero-orphan leak on PTY start error paths fixed.
- [x] Review hardening — adversarial review of the v0.3 diff resolved & re-verified **2 HIGH** (quit-time `Running` filter on `pm.list()` so a retained-crash dead/reused PID isn't SIGKILL'd on quit; token rotation force-closes open WebSockets), **3 MED** (liveness-gated kill sweep; crashed-dependency fast-fail in group launch; rate-limit double-count), and **9 LOW**. Gates green: cargo 214 / clippy --all-targets / fmt / app·mobile tsc·eslint / vitest 52.
- [x] Stabilization + memory pass (branch `stabilize/runtime-restore-memory`) — investigated 3 areas, adversarially vetted, applied 13 surgical/additive changes, re-verified 12/12 fully with no regressions. **Execution:** auto-restart flapping-window retry-budget reset + backoff floor; per-id concurrent-start in-flight guard (orphan prevention); scheduler per-candidate task so a 30 s dep wait can't stall siblings. **Restore:** synchronous runtime flush on quit; parent-dir fsync; corrupt `config.yaml`/`runtime.json` quarantine-and-recover (no startup brick); `stop_tunnel` SEC-12 reused-pid guard. **Memory:** LogBuffer lazy allocation + crash-retain `shrink_to_fit`; `logs.db` amortized WAL-truncate + bounded FTS merge; mobile QR lazy-load (690→319 KB). Gates: cargo 219 / clippy / fmt / app·mobile tsc·eslint / vitest 52.

### Follow-ups (non-blocking)
- [x] Mobile feedback unification — the companion's native `window.confirm`/`alert` are replaced by a glass toast + confirm sheet (`mobile/src/feedback.tsx`) mirroring the desktop `useToast`/`useConfirm`.
- [x] Design-system export — 12 shadcn/ui primitives synced to claude.ai/design ("procman Design System") via `/design-sync`; durable inputs committed in `.design-sync/` (config + authored previews + conventions + `rebuild-css.sh`), re-sync is one driver command. All 12 previews visually verified (render check clean; Dialog `RENDER_THIN` warn known-benign per `.design-sync/NOTES.md`).
- Session-restore clear lost-update: a clean self-exit racing a same-id respawn is now guarded by a late `is_live` recheck, but full closure needs a generation-aware `mark_running` (LOW; silent, recoverable — one script missing from the next restore prompt).
- Auto-restart readiness parity: an auto-restart re-enters `spawn_inner` directly, skipping the port-conflict + `depends_on` readiness gate the manual/group/scheduler starts enforce (`ProcessManager` has no `AppState` handle). Restoring it cleanly is a design change — route auto-restart through a config-aware callback rather than the in-`process.rs` path. Deferred (verified-core-adjacent; the existing exponential backoff already self-corrects a bind failure).
- Optional: persistent global crashed indicator on the dashboard tabs (currently project top bar only); `pid_index` ownership-guarded removal on the retained-crash path (pre-existing, theoretical pid-reuse edge).

## Not planned
- Team sharing / multi-user sync. procman stays a single-user tool.
- Windows / Linux port. macOS only.
- Cloud-hosted log aggregation. Local sqlite is the ceiling.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports via GitHub Issues (templates in `.github/`). Security disclosure per [SECURITY.md](SECURITY.md).
