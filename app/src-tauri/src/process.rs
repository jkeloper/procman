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
use crate::types::{LogStream, Script};
use dashmap::DashMap;
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
}

struct Managed {
    /// Monotonic counter per (manager, script_id). Prevents old watcher
    /// tasks from removing a newly-inserted entry.
    generation: u64,
    pid: u32,
    started_at_ms: i64,
    command: String,
    log_buffer: Arc<Mutex<LogBuffer>>,
    killed_by_user: Arc<AtomicBool>,
    /// Set by the watcher task when child.wait() returns. kill() polls this.
    exited: Arc<AtomicBool>,
    /// W2: Auto-restart tracking.
    auto_restart: bool,
    restart_count: Arc<AtomicU32>,
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
        self.procs.insert(
            script.id.clone(),
            Managed {
                generation,
                pid,
                started_at_ms,
                command: command_line,
                log_buffer,
                killed_by_user: Arc::clone(&killed),
                exited: Arc::clone(&exited),
                auto_restart: script.auto_restart,
                restart_count: Arc::clone(&restart_count),
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
        let pm_clone = self.clone();
        let script_clone = script.clone();
        let cwd_clone = cwd.clone();
        let auto_restart = script.auto_restart;
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

            // W2: Auto-restart with exponential backoff if crashed and not user-killed.
            if auto_restart && status == RuntimeStatus::Crashed && !user_killed {
                let attempt = restart_count.fetch_add(1, Ordering::SeqCst) + 1;
                let delay_ms = (AUTO_RESTART_BASE_MS * 2u64.saturating_pow(attempt.saturating_sub(1)))
                    .min(AUTO_RESTART_MAX_MS);
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
                // Re-spawn only if no new instance was started while we waited.
                if !procs.contains_key(&id) {
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
        let (pid, killed_flag, exited_flag, generation) = {
            let Some(m) = self.procs.get(id) else {
                return Ok(()); // Already gone — nothing to do.
            };
            (
                m.pid,
                Arc::clone(&m.killed_by_user),
                Arc::clone(&m.exited),
                m.generation,
            )
        };
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
            let _ = crate::commands::port::kill_port(port as u16).await;
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
}
