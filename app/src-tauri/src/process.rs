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
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};

const LOG_CAPACITY_DEFAULT: usize = 5000;
const KILL_GRACE_MS: u64 = 1500;
const KILL_POLL_INTERVAL_MS: u64 = 50;

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
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessSnapshot {
    pub id: String,
    pub pid: u32,
    pub status: RuntimeStatus,
    pub started_at_ms: i64,
    pub command: String,
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
}

#[derive(Clone)]
pub struct ProcessManager {
    procs: Arc<DashMap<String, Managed>>,
    generation_counter: Arc<AtomicU64>,
    log_capacity: Arc<AtomicU64>,
    app: AppHandle,
}

impl ProcessManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            procs: Arc::new(DashMap::new()),
            generation_counter: Arc::new(AtomicU64::new(0)),
            log_capacity: Arc::new(AtomicU64::new(LOG_CAPACITY_DEFAULT as u64)),
            app,
        }
    }

    /// Update log buffer capacity for new processes. Existing buffers keep
    /// their current capacity until the process restarts.
    pub fn set_log_capacity(&self, cap: usize) {
        self.log_capacity.store(cap as u64, Ordering::Relaxed);
    }

    pub async fn spawn(&self, script: &Script, cwd: Option<String>) -> Result<u32, String> {
        // Ensure previous instance is fully exited before respawning (UNI-2).
        if self.procs.contains_key(&script.id) {
            self.kill(&script.id).await?;
        }

        let command_line = script.command.clone();
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
            },
        );

        emit_status(
            &self.app,
            StatusEvent {
                id: script.id.clone(),
                status: RuntimeStatus::Running,
                pid: Some(pid),
                exit_code: None,
                ts_ms: started_at_ms,
            },
        );

        // Watcher: classify exit + emit + remove (only if generation matches).
        let app = self.app.clone();
        let procs = Arc::clone(&self.procs);
        let id = script.id.clone();
        let killed_for_watcher = Arc::clone(&killed);
        let exited_for_watcher = Arc::clone(&exited);
        tokio::spawn(async move {
            let exit = child.wait().await;
            let exit_code = exit.as_ref().ok().and_then(|s| s.code());
            let user_killed = killed_for_watcher.load(Ordering::SeqCst);
            let status = match &exit {
                Ok(s) if s.success() || user_killed => RuntimeStatus::Stopped,
                _ => RuntimeStatus::Crashed,
            };
            exited_for_watcher.store(true, Ordering::SeqCst);
            emit_status(
                &app,
                StatusEvent {
                    id: id.clone(),
                    status,
                    pid: Some(pid),
                    exit_code,
                    ts_ms: now_ms(),
                },
            );
            // Remove entry only if it still matches this generation.
            procs.remove_if(&id, |_, m| m.generation == generation);
        });

        Ok(pid)
    }

    /// Kill the process group and wait for the watcher to confirm exit.
    /// Uses try_wait-based observation (via exited flag) so we never
    /// SIGKILL a pid that's already been reaped by the OS (UNI-2).
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

        // SIGTERM
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

        // Ensure entry is removed (watcher may have beat us to it).
        self.procs.remove_if(id, |_, m| m.generation == generation);
        Ok(())
    }

    pub async fn restart(&self, script: &Script, cwd: Option<String>) -> Result<u32, String> {
        self.kill(&script.id).await?;
        self.spawn(script, cwd).await
    }

    pub fn list(&self) -> Vec<ProcessSnapshot> {
        self.procs
            .iter()
            .map(|entry| ProcessSnapshot {
                id: entry.key().clone(),
                pid: entry.value().pid,
                status: RuntimeStatus::Running,
                started_at_ms: entry.value().started_at_ms,
                command: entry.value().command.clone(),
            })
            .collect()
    }

    pub fn log_snapshot(&self, id: &str) -> Vec<LogLine> {
        self.procs
            .get(id)
            .map(|m| m.log_buffer.lock().unwrap().snapshot())
            .unwrap_or_default()
    }
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
}
