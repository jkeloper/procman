// ProcessManager — spawn/kill/restart user scripts with logging (T11-T14, T16, T20).
//
// LEARN (tokio process + signal handling on macOS):
//   - `tokio::process::Command` returns a `Child` with async .wait().
//     stdout/stderr piped to AsyncRead implementers we can read line-by-line.
//   - `process_group(0)` sets the child's pgid = its own pid. Then
//     `libc::killpg(pid, sig)` signals the whole group — vital because a
//     shell often spawns grandchildren (sh → node → worker).
//   - Reader tasks (stdout + stderr) push into a std::sync::Mutex<LogBuffer>.
//     We never hold that lock across .await points.

use crate::log_buffer::{LogBuffer, LogLine};
use crate::types::{LogStream, Script};
use dashmap::DashMap;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};

const LOG_CAPACITY: usize = 5000;
const KILL_GRACE_MS: u64 = 1500;

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
    pid: u32,
    started_at_ms: i64,
    command: String,
    cwd: Option<String>,
    log_buffer: Arc<Mutex<LogBuffer>>,
    killed_by_user: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct ProcessManager {
    procs: Arc<DashMap<String, Managed>>,
    app: AppHandle,
}

impl ProcessManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            procs: Arc::new(DashMap::new()),
            app,
        }
    }

    pub async fn spawn(&self, script: &Script, cwd: Option<String>) -> Result<u32, String> {
        // Single-instance guard per script_id.
        if self.procs.contains_key(&script.id) {
            let _ = self.kill(&script.id).await;
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

        let log_buffer = Arc::new(Mutex::new(LogBuffer::new(LOG_CAPACITY)));
        let killed = Arc::new(AtomicBool::new(false));

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
        self.procs.insert(
            script.id.clone(),
            Managed {
                pid,
                started_at_ms,
                command: command_line,
                cwd,
                log_buffer,
                killed_by_user: Arc::clone(&killed),
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

        // Watcher: when child exits, classify and emit + remove from map.
        let app = self.app.clone();
        let procs = Arc::clone(&self.procs);
        let id = script.id.clone();
        let killed_for_watcher = Arc::clone(&killed);
        tokio::spawn(async move {
            let exit = child.wait().await;
            let exit_code = exit.as_ref().ok().and_then(|s| s.code());
            let user_killed = killed_for_watcher.load(Ordering::SeqCst);
            let status = match &exit {
                Ok(s) if s.success() || user_killed => RuntimeStatus::Stopped,
                Ok(_) => RuntimeStatus::Crashed,
                Err(_) => RuntimeStatus::Crashed,
            };
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
            procs.remove(&id);
        });

        Ok(pid)
    }

    pub async fn kill(&self, id: &str) -> Result<(), String> {
        let (pid, killed_flag) = {
            let Some(m) = self.procs.get(id) else {
                return Err(format!("not running: {}", id));
            };
            (m.pid, Arc::clone(&m.killed_by_user))
        };
        killed_flag.store(true, Ordering::SeqCst);
        unsafe {
            libc::killpg(pid as i32, libc::SIGTERM);
        }
        tokio::time::sleep(Duration::from_millis(KILL_GRACE_MS)).await;
        if self.procs.contains_key(id) {
            unsafe {
                libc::killpg(pid as i32, libc::SIGKILL);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Ok(())
    }

    pub async fn restart(&self, script: &Script, cwd: Option<String>) -> Result<u32, String> {
        let _ = self.kill(&script.id).await;
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
        while let Ok(Some(line)) = lines.next_line().await {
            let entry = buf.lock().unwrap().push(LogStream::Stdout, line);
            let _ = app.emit(&format!("log://{}", id), entry);
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
        while let Ok(Some(line)) = lines.next_line().await {
            let entry = buf.lock().unwrap().push(LogStream::Stderr, line);
            let _ = app.emit(&format!("log://{}", id), entry);
        }
    });
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
