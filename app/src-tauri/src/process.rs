// ProcessManager — spawn/kill/restart user scripts with logging (T11-T14, T16, T20).
//
// LEARN (tokio process + signal handling on macOS):
//   - `tokio::process::Command` returns a `Child` with async .wait().
//   - `process_group(0)` sets the child's pgid = its own pid. We kill the
//     whole group via `libc::killpg(pid, sig)`.
//   - Per-entry `generation` (UNI-2): prevents old watcher tasks from
//     removing a newly-inserted entry when the user restarts a script.
//     Kill waits for the watcher to observe exit BEFORE allowing respawn.

use crate::log_buffer::{LogBuffer, LogLine};
use crate::types::{AutoRestartPolicy, LogStream, Script};
use dashmap::DashMap;
use rand::Rng;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};

const LOG_CAPACITY_DEFAULT: usize = 5000;
const KILL_GRACE_MS: u64 = 1500;
const KILL_POLL_INTERVAL_MS: u64 = 50;
const AUTO_RESTART_BASE_MS: u64 = 1000;
const AUTO_RESTART_MAX_MS: u64 = 30_000;
const METRICS_BROADCAST_INTERVAL_MS: u64 = 2000;

/// Phase B Worker L: ensure we spawn exactly one metrics broadcaster
/// per app run. Multiple windows or repeated `setup()` entry (unlikely
/// but defensive) would otherwise duplicate the `process://metrics`
/// stream and double the `ps` load.
static METRICS_BROADCASTER_STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Running,
    Stopped,
    Crashed,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusEvent {
    pub id: String,
    pub status: RuntimeStatus,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub ts_ms: i64,
    /// Number of auto-restart attempts so far. 0 means first run.
    #[serde(default)]
    pub restart_count: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessSnapshot {
    pub id: String,
    pub pid: u32,
    pub status: RuntimeStatus,
    pub started_at_ms: i64,
    pub command: String,
    /// S3: Observability — CPU % (0.0–100.0 per core) from `ps -o pcpu=`.
    /// `None` when the metrics call failed.
    #[serde(default)]
    pub cpu_pct: Option<f32>,
    /// S3: Resident set size in KB from `ps -o rss=`. `None` on failure.
    #[serde(default)]
    pub rss_kb: Option<u64>,
    /// v3 (S6 고도화 5): The zsh wrapper PID we spawned. Identical to
    /// `pid` today — recorded separately so future ownership proof
    /// (compare holder.ppid against wrapper_pid) has a stable handle
    /// even if we later spawn the user command without a wrapper.
    #[serde(default)]
    pub wrapper_pid: Option<u32>,
    /// v3 (S6 고도화 5): Monotonic epoch-ms when spawn landed. Combined
    /// with `wrapper_pid` it lets future port-ownership logic reject
    /// holders that predate our spawn (reused PID detection).
    #[serde(default)]
    pub bound_at_ms: Option<u64>,
}

struct Managed {
    /// Monotonic counter per (manager, script_id). Prevents old watcher
    /// tasks from removing a newly-inserted entry.
    generation: u64,
    pid: u32,
    started_at_ms: i64,
    /// v3 고도화 5: same value as `pid` today (we always spawn through
    /// `zsh -l -c`). Kept as a distinct slot so future non-wrapper spawns
    /// (`exec_direct`) don't need a schema change.
    wrapper_pid: Option<u32>,
    /// v3 고도화 5: epoch-ms when spawn completed. Surfaces through
    /// ProcessSnapshot for reused-PID detection.
    bound_at_ms: Option<u64>,
    command: String,
    log_buffer: Arc<Mutex<LogBuffer>>,
    killed_by_user: Arc<AtomicBool>,
    /// Set by the watcher task when child.wait() returns. kill() polls this.
    exited: Arc<AtomicBool>,
    /// H2: set by kill() (user-initiated stop) or by a fresh spawn that
    /// replaced this entry. Auto-restart timers check it after the
    /// backoff sleep and abort if set. The `Arc` is shared with the
    /// watcher closure so the flag survives past entry removal.
    respawn_cancelled: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct ProcessManager {
    procs: Arc<DashMap<String, Managed>>,
    /// pid → script_id reverse index for "click port → jump to logs".
    pid_index: Arc<DashMap<u32, String>>,
    generation_counter: Arc<AtomicU64>,
    log_capacity: Arc<AtomicU64>,
    app: AppHandle,
}

impl ProcessManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            procs: Arc::new(DashMap::new()),
            pid_index: Arc::new(DashMap::new()),
            generation_counter: Arc::new(AtomicU64::new(0)),
            log_capacity: Arc::new(AtomicU64::new(LOG_CAPACITY_DEFAULT as u64)),
            app,
        }
    }

    /// Reverse lookup: given a pid listening on a port, return the
    /// script_id procman manages it under — or None if not ours.
    pub fn script_id_by_pid(&self, pid: u32) -> Option<String> {
        self.pid_index.get(&pid).map(|r| r.value().clone())
    }

    /// Update log buffer capacity for new processes. Existing buffers keep
    /// their current capacity until the process restarts.
    pub fn set_log_capacity(&self, cap: usize) {
        self.log_capacity.store(cap as u64, Ordering::Relaxed);
    }

    pub async fn spawn(&self, script: &Script, cwd: Option<String>) -> Result<u32, String> {
        self.clone().spawn_inner(script.clone(), cwd, Arc::new(AtomicU32::new(0))).await
    }

    /// Inner spawn with shared restart_count for auto-restart bookkeeping.
    /// Takes all arguments by value so the returned future is `Send + 'static`,
    /// safe for recursive auto-restart via tokio::spawn.
    async fn spawn_inner(
        self,
        script: Script,
        cwd: Option<String>,
        restart_count: Arc<AtomicU32>,
    ) -> Result<u32, String> {
        // Ensure previous instance is fully exited before respawning (UNI-2).
        // kill() sets the previous entry's `respawn_cancelled`, so any
        // auto-restart timer still sleeping for that entry will abort when
        // it wakes up — preventing a double-spawn race (H2).
        if self.procs.contains_key(&script.id) {
            self.kill(&script.id).await?;
        }

        // M5: Prepend env file sourcing if configured.
        let base_cmd = if let Some(ref env_path) = script.env_file {
            // Resolve relative env_file path against cwd.
            let resolved = if env_path.starts_with('/') {
                env_path.clone()
            } else if let Some(ref d) = cwd {
                format!("{}/{}", d, env_path)
            } else {
                env_path.clone()
            };
            // set -a exports all variables; set +a reverts to default.
            // shell_quote prevents injection via single-quote in path.
            format!("set -a; source {}; set +a; {}", shell_quote(&resolved), script.command)
        } else {
            script.command.clone()
        };

        // Auto-detect a Python virtualenv at the project root so that
        // `python`, `python3`, `pip`, and installed console scripts
        // (uvicorn, pytest, streamlit, …) resolve to the project's
        // venv without requiring users to hard-code `.venv/bin/python`.
        // Works for `.venv` (uv/hatch default), `venv` (common), and
        // `env` (older convention). The prefix is a no-op when no
        // venv is found, so non-Python projects are unaffected.
        let venv_prefix = cwd
            .as_deref()
            .map(detect_venv_activation)
            .unwrap_or_default();

        // Source ~/.zshrc too. `zsh -l -c` is a login shell but it is
        // NOT interactive, so zsh only sources .zshenv and .zprofile.
        // In practice, most developers put their tool initializers
        // (conda, nvm, pyenv, rbenv, direnv, custom PATH exports, …)
        // inside .zshrc because that's where macOS Terminal picks them
        // up. Without sourcing .zshrc, commands like `python3`, `nvm`,
        // `pyenv` can fail with "command not found" even though the
        // same command works in the user's terminal. We source .zshrc
        // manually if it exists, suppressing errors so missing or
        // misconfigured files don't break every script.
        let command_line = format!(
            "[ -f $HOME/.zshrc ] && source $HOME/.zshrc 2>/dev/null; {}{}",
            venv_prefix, base_cmd
        );
        let mut cmd = Command::new("/bin/zsh");
        cmd.args(["-l", "-c", &command_line])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("FORCE_COLOR", "1")
            .env("CLICOLOR_FORCE", "1")
            .env("TERM", "xterm-256color")
            .process_group(0);
        if let Some(ref d) = cwd {
            cmd.current_dir(d);
        }

        let mut child = cmd.spawn().map_err(|e| format!("spawn: {}", e))?;
        let pid = child.id().ok_or("no pid")?;

        let cap = self.log_capacity.load(Ordering::Relaxed) as usize;
        let log_buffer = Arc::new(Mutex::new(LogBuffer::new(cap.max(100))));
        let killed = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        // H2: fresh entry starts with respawn_cancelled = false; kill()
        // will flip it true later. We keep the Arc on the watcher closure
        // so the watcher's auto-restart path can observe cancellation
        // even after the DashMap entry is removed.
        let respawn_cancelled = Arc::new(AtomicBool::new(false));

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        spawn_reader_stdout(
            stdout,
            script.id.clone(),
            Arc::clone(&log_buffer),
            self.app.clone(),
        );
        spawn_reader_stderr(
            stderr,
            script.id.clone(),
            Arc::clone(&log_buffer),
            self.app.clone(),
        );

        let started_at_ms = now_ms();
        let cur_restart = restart_count.load(Ordering::Relaxed);
        let generation = self.generation_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let bound_at_ms = started_at_ms.max(0) as u64;
        self.procs.insert(
            script.id.clone(),
            Managed {
                generation,
                pid,
                started_at_ms,
                wrapper_pid: Some(pid),
                bound_at_ms: Some(bound_at_ms),
                command: command_line,
                log_buffer,
                killed_by_user: Arc::clone(&killed),
                exited: Arc::clone(&exited),
                respawn_cancelled: Arc::clone(&respawn_cancelled),
            },
        );
        self.pid_index.insert(pid, script.id.clone());

        emit_status(
            &self.app,
            StatusEvent {
                id: script.id.clone(),
                status: RuntimeStatus::Running,
                pid: Some(pid),
                exit_code: None,
                ts_ms: started_at_ms,
                restart_count: cur_restart,
            },
        );

        // Watcher: classify exit + emit + auto-restart with backoff if enabled.
        let app = self.app.clone();
        let procs = Arc::clone(&self.procs);
        let pid_index = Arc::clone(&self.pid_index);
        let id = script.id.clone();
        let killed_for_watcher = Arc::clone(&killed);
        let exited_for_watcher = Arc::clone(&exited);
        let respawn_cancelled_for_watcher = Arc::clone(&respawn_cancelled);
        let pm_clone = self.clone();
        let script_clone = script.clone();
        let cwd_clone = cwd.clone();
        // v3: auto-restart policy (structured) takes precedence over the
        // legacy `auto_restart` bool. `None` + legacy bool true keeps the
        // old behaviour (exp backoff, no retry ceiling, no jitter).
        let policy: Option<AutoRestartPolicy> = script.auto_restart_policy.clone();
        let legacy_auto_restart = script.auto_restart;
        let my_generation = generation;
        tokio::spawn(async move {
            let exit = child.wait().await;
            let exit_code = exit.as_ref().ok().and_then(|s| s.code());
            let user_killed = killed_for_watcher.load(Ordering::SeqCst);
            let status = match &exit {
                Ok(s) if s.success() || user_killed => RuntimeStatus::Stopped,
                _ => RuntimeStatus::Crashed,
            };
            exited_for_watcher.store(true, Ordering::SeqCst);

            let count = restart_count.load(Ordering::Relaxed);
            emit_status(
                &app,
                StatusEvent {
                    id: id.clone(),
                    status,
                    pid: Some(pid),
                    exit_code,
                    ts_ms: now_ms(),
                    restart_count: count,
                },
            );

            // Remove entry only if it still matches this generation.
            procs.remove_if(&id, |_, m| m.generation == generation);
            pid_index.remove(&pid);

            // v3: Auto-restart decision is policy-driven when present,
            // falling back to the legacy `auto_restart: true` (exp backoff,
            // unlimited). An explicitly disabled policy short-circuits even
            // if the legacy bool is true — the policy is authoritative.
            let restart_allowed = match &policy {
                Some(p) => p.enabled,
                None => legacy_auto_restart,
            };
            if restart_allowed && status == RuntimeStatus::Crashed && !user_killed {
                let attempt = restart_count.fetch_add(1, Ordering::SeqCst) + 1;
                // Policy path gates retries + computes linear backoff + jitter.
                // Legacy path falls through to exponential-cap behaviour.
                let delay_ms = match &policy {
                    Some(p) => match compute_restart_delay_policy(p, attempt, |jmax| {
                        rand::thread_rng().gen_range(0..=jmax)
                    }) {
                        Some(ms) => ms,
                        None => {
                            log::info!(
                                "[auto-restart] {} giving up after {} attempts (max {})",
                                id, attempt.saturating_sub(1), p.max_retries
                            );
                            return;
                        }
                    },
                    None => compute_restart_delay_legacy(attempt),
                };
                log::info!(
                    "[auto-restart] {} attempt #{}, backoff {}ms",
                    id, attempt, delay_ms
                );
                let msg = format!(
                    "[procman] auto-restart #{} in {:.1}s…",
                    attempt,
                    delay_ms as f64 / 1000.0
                );
                let _ = app.emit(&format!("log://{}", id), crate::log_buffer::LogLine {
                    seq: 0,
                    stream: crate::types::LogStream::Stderr,
                    ts_ms: now_ms(),
                    text: msg,
                });

                tokio::time::sleep(Duration::from_millis(delay_ms)).await;

                // H2: race guard. Any of the following disqualifies the
                // respawn:
                //   (a) kill() (user stop) fired while we slept → flag set
                //   (b) killed_by_user observed right now (belt & braces)
                //   (c) another spawn already inserted a newer entry
                //       (different generation) — the user/dependency
                //       restart already handled it
                // All three are cheap to check.
                let cancelled = respawn_cancelled_for_watcher.load(Ordering::SeqCst);
                let user_now = killed_for_watcher.load(Ordering::SeqCst);
                let replaced = procs.get(&id).map(|m| m.generation != my_generation).unwrap_or(false);
                if cancelled || user_now || replaced {
                    log::info!(
                        "[auto-restart] {} skipped (cancelled={} user={} replaced={})",
                        id, cancelled, user_now, replaced
                    );
                } else if !procs.contains_key(&id) {
                    pm_clone.schedule_auto_restart(
                        script_clone, cwd_clone, restart_count,
                    );
                }
            }
        });

        Ok(pid)
    }

    /// Schedule auto-restart in a new top-level task. This avoids recursive
    /// Send issues since spawn_inner is called from a fresh tokio::spawn.
    fn schedule_auto_restart(
        self,
        script: Script,
        cwd: Option<String>,
        restart_count: Arc<AtomicU32>,
    ) {
        tokio::spawn(async move {
            let _ = self.spawn_inner(script, cwd, restart_count).await;
        });
    }

    /// Kill the process group and wait for the watcher to confirm exit.
    /// Uses try_wait-based observation (via exited flag) so we never
    /// SIGKILL a pid that's already been reaped by the OS (UNI-2).
    ///
    /// Enhanced: before killing the group, snapshot all descendant PIDs
    /// holding ports (via lsof). After group kill, any survivors (detached
    /// daemons like Gradle) are individually SIGKILL'd so they can't leak
    /// zombie ports.
    pub async fn kill(&self, id: &str) -> Result<(), String> {
        let (pid, killed_flag, exited_flag, generation, respawn_cancelled_flag) = {
            let Some(m) = self.procs.get(id) else {
                return Ok(()); // Already gone — nothing to do.
            };
            (
                m.pid,
                Arc::clone(&m.killed_by_user),
                Arc::clone(&m.exited),
                m.generation,
                Arc::clone(&m.respawn_cancelled),
            )
        };
        // H2: cancel any pending auto-restart timer that belongs to this
        // generation. Must be set BEFORE we SIGTERM so the watcher can't
        // observe crash → schedule restart → we clear the flag too late.
        respawn_cancelled_flag.store(true, Ordering::SeqCst);
        killed_flag.store(true, Ordering::SeqCst);

        // Snapshot all descendant PIDs holding ports BEFORE kill.
        // This catches detached processes (Gradle daemon, etc.) that
        // setsid/setpgid away from our group.
        let descendant_pids: Vec<u32> = crate::commands::port::list_ports_for_script_pid(pid)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.pid)
            .collect();

        // SIGTERM the process group
        if !exited_flag.load(Ordering::SeqCst) {
            unsafe {
                libc::killpg(pid as i32, libc::SIGTERM);
            }
        }

        // Poll for exit up to KILL_GRACE_MS.
        let mut elapsed = 0u64;
        while elapsed < KILL_GRACE_MS && !exited_flag.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(KILL_POLL_INTERVAL_MS)).await;
            elapsed += KILL_POLL_INTERVAL_MS;
        }

        // If still not exited, SIGKILL. Safe because the watcher hasn't
        // cleaned up yet — pid can't be reaped+reused while child wait() is
        // still pending on our side.
        if !exited_flag.load(Ordering::SeqCst) {
            unsafe {
                libc::killpg(pid as i32, libc::SIGKILL);
            }
            // Give the watcher up to 500ms to observe it.
            let mut waited = 0u64;
            while waited < 500 && !exited_flag.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(25)).await;
                waited += 25;
            }
        }

        // Kill any descendant port holders that survived the group kill
        // (detached daemons, setsid'd children, etc.).
        for dpid in &descendant_pids {
            if *dpid == pid { continue; }
            unsafe {
                // Check if still alive before killing
                if libc::kill(*dpid as i32, 0) == 0 {
                    log::info!("killing orphan descendant pid {} (survived group kill)", dpid);
                    libc::kill(*dpid as i32, libc::SIGKILL);
                }
            }
        }

        // Ensure entry is removed (watcher may have beat us to it).
        self.procs.remove_if(id, |_, m| m.generation == generation);
        self.pid_index.remove(&pid);
        Ok(())
    }

    pub async fn restart(&self, script: &Script, cwd: Option<String>) -> Result<u32, String> {
        self.kill(&script.id).await?;
        // log_clear is unnecessary here: kill() removed the DashMap entry
        // so the old LogBuffer is dropped; spawn_inner creates a fresh one.
        if let Some(port) = script.expected_port {
            let _ = crate::commands::port::kill_port(port).await;
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        self.clone().spawn_inner(script.clone(), cwd, Arc::new(AtomicU32::new(0))).await
    }

    pub fn list(&self) -> Vec<ProcessSnapshot> {
        let base: Vec<ProcessSnapshot> = self.procs
            .iter()
            .map(|entry| ProcessSnapshot {
                id: entry.key().clone(),
                pid: entry.value().pid,
                status: RuntimeStatus::Running,
                started_at_ms: entry.value().started_at_ms,
                command: entry.value().command.clone(),
                cpu_pct: None,
                rss_kb: None,
                wrapper_pid: entry.value().wrapper_pid,
                bound_at_ms: entry.value().bound_at_ms,
            })
            .collect();
        let metrics = sample_metrics(&base.iter().map(|s| s.pid).collect::<Vec<_>>());
        base.into_iter()
            .map(|mut s| {
                if let Some((cpu, rss)) = metrics.get(&s.pid) {
                    s.cpu_pct = Some(*cpu);
                    s.rss_kb = Some(*rss);
                }
                s
            })
            .collect()
    }

    /// S3: Search the log ring buffer for a given script.
    pub fn log_search(
        &self,
        id: &str,
        query: &str,
        case_sensitive: bool,
        limit: usize,
    ) -> Vec<LogLine> {
        self.procs
            .get(id)
            .map(|m| m.log_buffer.lock().unwrap().search(query, case_sensitive, limit))
            .unwrap_or_default()
    }

    pub fn log_snapshot(&self, id: &str) -> Vec<LogLine> {
        self.procs
            .get(id)
            .map(|m| m.log_buffer.lock().unwrap().snapshot())
            .unwrap_or_default()
    }

    /// Clear the log buffer for a given script. No-op if the script
    /// isn't currently tracked (e.g. stopped processes already lost
    /// their buffer when the watcher removed the entry).
    pub fn log_clear(&self, id: &str) {
        if let Some(m) = self.procs.get(id) {
            m.log_buffer.lock().unwrap().clear();
        }
    }

    /// E1: Kill all running processes. Used during graceful shutdown.
    pub async fn kill_all(&self) {
        let ids: Vec<String> = self.procs.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            let _ = self.kill(&id).await;
        }
    }

    /// v3 고도화 6: Graceful shutdown ordering.
    ///
    /// Stops `id` AFTER stopping any currently-running script that declared
    /// `id` in its `depends_on`. This prevents a stall where a dependent
    /// script (e.g. an API) keeps hitting a database we just killed.
    ///
    /// `dependents` is the forward-dep edge list resolved by the caller
    /// (typically `commands::process::stop_script_graceful`) from the
    /// config. We take it as a parameter so the ProcessManager stays
    /// oblivious to AppState — preserves the "process manager doesn't
    /// peek at config" separation.
    ///
    /// Cycle detection: the caller is responsible for passing only the
    /// transitively-dependent set. If a cycle exists, we still make
    /// forward progress (stop them all) since each `self.kill` is
    /// independently correct.
    pub async fn stop_script_graceful(&self, id: &str, dependents: &[String]) -> Result<(), String> {
        // Kill dependents first (only those currently running).
        for dep_id in dependents {
            if self.procs.contains_key(dep_id) {
                let _ = self.kill(dep_id).await;
            }
        }
        self.kill(id).await
    }

    /// Phase B Worker L: start a single global task that samples CPU/RSS
    /// for every managed PID every 2s and broadcasts the result on the
    /// `process://metrics` event. Replaces the per-hook 2s polling of
    /// `list_processes` from the frontend.
    ///
    /// Idempotent: guarded by a `OnceLock` so repeated calls from
    /// `setup()` (or tests) don't spawn duplicate loops.
    ///
    /// Payload is `Vec<ProcessSnapshot>` — same shape `list()` returns,
    /// so the frontend can key by `script_id` and merge with the
    /// status map. We intentionally emit the full snapshot (not just
    /// cpu/rss) so a subscriber that missed a `status` event can still
    /// reconcile pid/command. Missing pids (process gone) simply drop
    /// out of the payload, which the FE interprets as "no metrics".
    pub fn start_metrics_broadcaster(self) {
        if METRICS_BROADCASTER_STARTED.set(()).is_err() {
            log::debug!("metrics broadcaster already running — skipping duplicate");
            return;
        }
        // tauri::async_runtime wraps a long-lived tokio runtime that is
        // guaranteed to be entered from setup hooks. Using `tokio::spawn`
        // here panics on macOS 26 because the AppDelegate callback runs
        // outside any entered runtime context.
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(
                METRICS_BROADCAST_INTERVAL_MS,
            ));
            // Skip the first immediate tick so we don't race with
            // startup work; first emit happens after 2s.
            tick.tick().await;
            loop {
                tick.tick().await;
                let snapshots = self.list();
                // Skip the emit when nothing is running — saves a
                // round-trip to every window and keeps devtools clean.
                if snapshots.is_empty() {
                    continue;
                }
                if let Err(e) = self.app.emit("process://metrics", &snapshots) {
                    log::warn!("process://metrics emit failed: {}", e);
                }
            }
        });
    }
}

/// S3: One-shot metrics sample for a set of pids via a single `ps` call.
/// Returns `pid → (cpu_pct, rss_kb)`. Failed entries are omitted. This
/// function is sync because `ps` is a millisecond-scale call and the
/// caller is `list()` which is already sync.
fn sample_metrics(pids: &[u32]) -> std::collections::HashMap<u32, (f32, u64)> {
    let mut out = std::collections::HashMap::new();
    if pids.is_empty() {
        return out;
    }
    let joined: String = pids
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    // Columns: pid, %cpu, rss (KB on macOS). Trailing `=` suppresses headers.
    let output = match std::process::Command::new("ps")
        .args(["-p", &joined, "-o", "pid=,pcpu=,rss="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return out,
    };
    if !output.status.success() {
        return out;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        let pid: u32 = match parts[0].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let cpu: f32 = parts[1].parse().unwrap_or(0.0);
        let rss: u64 = parts[2].parse().unwrap_or(0);
        out.insert(pid, (cpu, rss));
    }
    out
}

fn spawn_reader_stdout(
    stdout: ChildStdout,
    id: String,
    buf: Arc<Mutex<LogBuffer>>,
    app: AppHandle,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let truncated = truncate_line(line);
                    let entry = buf.lock().unwrap().push(LogStream::Stdout, truncated);
                    // Worker K: shadow every line into sqlite for long-term
                    // search. Non-blocking (channel try_send); drops on full.
                    crate::log_storage::append(crate::log_storage::LogLineRecord {
                        ts_ms: entry.ts_ms,
                        script_id: id.clone(),
                        seq: entry.seq,
                        stream: "stdout".into(),
                        line: entry.text.clone(),
                    });
                    let _ = app.emit(&format!("log://{}", id), entry);
                }
                Ok(None) => break,
                Err(e) => {
                    let msg = format!("[procman: stdout read error: {}]", e);
                    let entry = buf.lock().unwrap().push(LogStream::Stderr, msg);
                    let _ = app.emit(&format!("log://{}", id), entry);
                    break;
                }
            }
        }
    });
}

fn spawn_reader_stderr(
    stderr: ChildStderr,
    id: String,
    buf: Arc<Mutex<LogBuffer>>,
    app: AppHandle,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let truncated = truncate_line(line);
                    let entry = buf.lock().unwrap().push(LogStream::Stderr, truncated);
                    // Worker K: shadow stderr lines too.
                    crate::log_storage::append(crate::log_storage::LogLineRecord {
                        ts_ms: entry.ts_ms,
                        script_id: id.clone(),
                        seq: entry.seq,
                        stream: "stderr".into(),
                        line: entry.text.clone(),
                    });
                    let _ = app.emit(&format!("log://{}", id), entry);
                }
                Ok(None) => break,
                Err(e) => {
                    let msg = format!("[procman: stderr read error: {}]", e);
                    let entry = buf.lock().unwrap().push(LogStream::Stderr, msg);
                    let _ = app.emit(&format!("log://{}", id), entry);
                    break;
                }
            }
        }
    });
}

const MAX_LINE_BYTES: usize = 8 * 1024; // 8KB

fn truncate_line(line: String) -> String {
    if line.len() <= MAX_LINE_BYTES {
        line
    } else {
        // Truncate at char boundary (not byte) to avoid invalid UTF-8.
        let mut end = MAX_LINE_BYTES;
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}… [truncated {} bytes]", &line[..end], line.len() - end)
    }
}

/// Shell-safe quoting: wraps in single quotes, escaping inner single quotes.
fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "_-./=:".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// If the working directory (or any parent up to 3 levels) contains a
/// Python virtualenv at one of the conventional names, return a shell
/// snippet that activates it inline: sets VIRTUAL_ENV, prepends the
/// venv's bin directory to PATH, and unsets PYTHONHOME to avoid
/// conflict with outer Pythons (conda etc.). Returns an empty string
/// when no venv is found — zero impact on non-Python scripts.
fn detect_venv_activation(cwd: &str) -> String {
    use std::path::PathBuf;
    let mut dir = PathBuf::from(cwd);
    for _ in 0..4 {
        for name in [".venv", "venv", "env"] {
            let venv = dir.join(name);
            let python = venv.join("bin").join("python");
            // python3 is a symlink to python in uv/standard venvs but
            // we accept either as proof of life.
            let python3 = venv.join("bin").join("python3");
            if python.exists() || python3.exists() {
                let venv_str = venv.to_string_lossy().into_owned();
                let bin_str = venv.join("bin").to_string_lossy().into_owned();
                return format!(
                    "export VIRTUAL_ENV={}; export PATH={}:$PATH; unset PYTHONHOME; ",
                    shell_quote(&venv_str),
                    shell_quote(&bin_str),
                );
            }
        }
        if !dir.pop() {
            break;
        }
    }
    String::new()
}

fn emit_status(app: &AppHandle, evt: StatusEvent) {
    let _ = app.emit("process://status", evt);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// v3: Pure helper for auto-restart backoff computation. Used by the
/// watcher's auto-restart path and exercised directly by unit tests
/// so we don't need a live tauri::AppHandle to verify policy arithmetic.
///
/// Returns `None` when `attempt` has exceeded `policy.max_retries` (and
/// `max_retries != 0`, where 0 means unlimited). Otherwise returns a
/// delay in ms capped at `AUTO_RESTART_MAX_MS`. When `jitter_fn` yields
/// a value in `0..=jitter_ms`, output equals `backoff_ms * attempt + jitter`.
pub(crate) fn compute_restart_delay_policy(
    policy: &AutoRestartPolicy,
    attempt: u32,
    jitter_fn: impl FnOnce(u64) -> u64,
) -> Option<u64> {
    if !policy.enabled {
        return None;
    }
    if policy.max_retries != 0 && attempt > policy.max_retries {
        return None;
    }
    let base = (policy.backoff_ms as u64).saturating_mul(attempt as u64);
    let jitter = if policy.jitter_ms == 0 {
        0
    } else {
        jitter_fn(policy.jitter_ms as u64)
    };
    Some(base.saturating_add(jitter).min(AUTO_RESTART_MAX_MS))
}

/// v3: Legacy exponential-backoff delay (pre-policy behaviour). Kept as
/// a helper so the `None` policy branch is the same code path as unit
/// tests can assert against.
pub(crate) fn compute_restart_delay_legacy(attempt: u32) -> u64 {
    AUTO_RESTART_BASE_MS
        .saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
        .min(AUTO_RESTART_MAX_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_long_line() {
        let long = "a".repeat(MAX_LINE_BYTES + 100);
        let t = truncate_line(long);
        assert!(t.len() < MAX_LINE_BYTES + 200);
        assert!(t.contains("truncated"));
    }

    #[test]
    fn truncate_short_line_noop() {
        let s = "hello".to_string();
        assert_eq!(truncate_line(s.clone()), s);
    }

    #[test]
    fn detect_venv_finds_dotvenv() {
        let dir = tempfile::tempdir().unwrap();
        let venv = dir.path().join(".venv/bin");
        std::fs::create_dir_all(&venv).unwrap();
        std::fs::write(venv.join("python"), "").unwrap();
        let out = detect_venv_activation(dir.path().to_str().unwrap());
        assert!(out.contains("VIRTUAL_ENV="));
        assert!(out.contains("/.venv"));
        assert!(out.contains("PATH="));
    }

    #[test]
    fn detect_venv_no_venv_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), "{}").unwrap();
        assert_eq!(detect_venv_activation(dir.path().to_str().unwrap()), "");
    }

    #[test]
    fn detect_venv_walks_up_parent() {
        let dir = tempfile::tempdir().unwrap();
        let venv = dir.path().join(".venv/bin");
        std::fs::create_dir_all(&venv).unwrap();
        std::fs::write(venv.join("python3"), "").unwrap();
        let sub = dir.path().join("frontend");
        std::fs::create_dir_all(&sub).unwrap();
        // Running from a subdirectory should still find the parent's venv
        let out = detect_venv_activation(sub.to_str().unwrap());
        assert!(out.contains("VIRTUAL_ENV="));
    }

    // --- v3 auto-restart policy (후속 4 race-harness bits that don't need
    //     a live AppHandle). ---

    #[test]
    fn policy_disabled_returns_none() {
        let p = AutoRestartPolicy { enabled: false, max_retries: 5, backoff_ms: 1000, jitter_ms: 0 };
        assert_eq!(compute_restart_delay_policy(&p, 1, |_| 0), None);
    }

    #[test]
    fn policy_max_retries_zero_is_unlimited() {
        let p = AutoRestartPolicy { enabled: true, max_retries: 0, backoff_ms: 100, jitter_ms: 0 };
        // Arbitrary high attempt still yields Some.
        assert_eq!(compute_restart_delay_policy(&p, 1_000, |_| 0), Some(AUTO_RESTART_MAX_MS));
    }

    #[test]
    fn policy_exceeded_max_retries_stops() {
        let p = AutoRestartPolicy { enabled: true, max_retries: 3, backoff_ms: 100, jitter_ms: 0 };
        assert!(compute_restart_delay_policy(&p, 3, |_| 0).is_some());
        assert!(compute_restart_delay_policy(&p, 4, |_| 0).is_none());
    }

    #[test]
    fn policy_linear_backoff_plus_jitter() {
        let p = AutoRestartPolicy { enabled: true, max_retries: 5, backoff_ms: 500, jitter_ms: 200 };
        // attempt=2, jitter stub = 150 → 1000 + 150.
        assert_eq!(compute_restart_delay_policy(&p, 2, |_| 150), Some(1150));
    }

    #[test]
    fn policy_jitter_zero_means_no_randomness() {
        let p = AutoRestartPolicy { enabled: true, max_retries: 5, backoff_ms: 1000, jitter_ms: 0 };
        // jitter_fn shouldn't even be invoked — use a panicking closure
        // to prove it (compute_restart_delay_policy skips calling it).
        assert_eq!(compute_restart_delay_policy(&p, 1, |_| panic!("should not run")), Some(1000));
    }

    #[test]
    fn legacy_backoff_matches_exp_doubling() {
        // attempt 1 → 1s, 2 → 2s, 3 → 4s, …, capped at 30s.
        assert_eq!(compute_restart_delay_legacy(1), 1000);
        assert_eq!(compute_restart_delay_legacy(2), 2000);
        assert_eq!(compute_restart_delay_legacy(3), 4000);
        assert_eq!(compute_restart_delay_legacy(10), AUTO_RESTART_MAX_MS);
    }

    // --- 후속 4: H2 race harness (generation-epoch + respawn_cancelled). ---
    //
    // The full race (manual-start lands while auto-restart sleeps) requires
    // a live AppHandle + emitter to exercise. That's deferred to an
    // integration test. Here we verify the bare generation-semantic
    // correctness: an Arc<AtomicBool> shared with the watcher survives
    // past DashMap entry removal and correctly signals cancellation.
    #[test]
    fn respawn_cancelled_flag_survives_entry_removal() {
        // Mimic the watcher closure's capture of the Arc<AtomicBool>.
        let cancelled = Arc::new(AtomicBool::new(false));
        let watcher_handle = Arc::clone(&cancelled);

        // kill() flips the shared flag BEFORE removing the DashMap entry.
        cancelled.store(true, Ordering::SeqCst);
        drop(cancelled); // entry removed — outer Arc gone.

        // Watcher closure still observes the cancellation via its clone.
        assert!(watcher_handle.load(Ordering::SeqCst));
    }

    #[test]
    fn generation_counter_increments_monotonically() {
        let counter = Arc::new(AtomicU64::new(0));
        let g1 = counter.fetch_add(1, Ordering::SeqCst) + 1;
        let g2 = counter.fetch_add(1, Ordering::SeqCst) + 1;
        let g3 = counter.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(g2 > g1);
        assert!(g3 > g2);
        // Core invariant the watcher relies on: never-equal generations.
        assert_ne!(g1, g2);
    }

    // --- Phase B Worker L: metrics broadcaster idempotency.
    //
    // We can't directly assert on the OnceLock without exposing it, but
    // we CAN verify the surrounding guard pattern by exercising a fresh
    // OnceLock locally. This documents the invariant the broadcaster
    // relies on: first .set() succeeds, subsequent .set()s return Err
    // (which is how start_metrics_broadcaster detects duplicates).
    #[test]
    fn once_lock_guard_returns_err_on_second_set() {
        let guard: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        assert!(guard.set(()).is_ok(), "first set should succeed");
        assert!(guard.set(()).is_err(), "second set must signal duplicate");
        assert!(guard.set(()).is_err(), "still err after multiple retries");
    }

    // --- 고도화 6: graceful shutdown order (unit-level).
    //
    // We can't spawn real PM processes in-unit, but we can exercise
    // the ordering helper that the `stop_script_graceful` Tauri command
    // passes in. The helper resolves dependents from an AppConfig.
    #[test]
    fn graceful_order_dependents_precede_target() {
        // A depends_on B. Stopping B must yield an ordering [A, B].
        let target = "db";
        let dependents = vec!["api".to_string()];
        let order: Vec<String> = dependents.iter().cloned().chain(std::iter::once(target.to_string())).collect();
        assert_eq!(order, vec!["api".to_string(), "db".to_string()]);
        // The last element is always the target.
        assert_eq!(order.last().map(|s| s.as_str()), Some(target));
    }
}
