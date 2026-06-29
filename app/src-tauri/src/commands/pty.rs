use crate::process::{command_line_for_script, ProcessManager};
use crate::state::AppState;
use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const PTY_BUFFER_LIMIT: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
pub struct PtySessionInfo {
    pub id: String,
    pub project_id: String,
    pub script_id: String,
    pub pid: Option<u32>,
    pub command: String,
    pub started_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyDataEvent {
    pub id: String,
    pub script_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyExitEvent {
    pub id: String,
    pub script_id: String,
    pub exit_code: u32,
    pub success: bool,
}

/// WS9: PtyManager is now an I/O front-end. It owns only the master PTY
/// handle (resize), the writer (keystrokes), and the scrollback buffer
/// (snapshot). Process lifecycle — kill, crash classification, metrics,
/// session-restore — is owned by `ProcessManager` via `register_pty` /
/// `notify_pty_exit`. No `ChildKiller` is held here: kill routes through
/// `pm.kill(script_id)` so PTY and piped processes share the same
/// killpg/grace/sweep sequence.
struct PtySession {
    info: PtySessionInfo,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    buffer: Mutex<VecDeque<String>>,
}

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<DashMap<String, Arc<PtySession>>>,
    app: AppHandle,
}

impl PtyManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            app,
        }
    }

    fn list(&self) -> Vec<PtySessionInfo> {
        self.sessions
            .iter()
            .map(|entry| entry.value().info.clone())
            .collect()
    }

    fn find_by_script(&self, script_id: &str) -> Option<PtySessionInfo> {
        self.sessions
            .iter()
            .find(|entry| entry.value().info.script_id == script_id)
            .map(|entry| entry.value().info.clone())
    }

    fn snapshot(&self, id: &str) -> Vec<String> {
        self.sessions
            .get(id)
            .map(|session| {
                session
                    .buffer
                    .lock()
                    .map(|buffer| buffer.iter().cloned().collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| format!("pty session not found: {}", id))?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "pty writer lock poisoned".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("pty write: {}", e))?;
        writer.flush().map_err(|e| format!("pty flush: {}", e))
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| format!("pty session not found: {}", id))?;
        let size = pty_size(cols, rows);
        let result = session
            .master
            .lock()
            .map_err(|_| "pty master lock poisoned".to_string())?
            .resize(size)
            .map_err(|e| format!("pty resize: {}", e));
        result
    }

    /// WS9: remove the I/O session and route the actual process kill through
    /// `ProcessManager::kill`, so a PTY stop goes through the same
    /// killpg → grace → SIGKILL → orphan-sweep sequence as a piped stop. The
    /// I/O session (reader/writer/buffer) is dropped here; the pm entry is
    /// torn down by `kill` (and the wait-thread's `notify_pty_exit`). No-op
    /// when the session is already gone.
    async fn kill(&self, id: &str, pm: &ProcessManager) -> Result<(), String> {
        let Some((_, session)) = self.sessions.remove(id) else {
            return Ok(());
        };
        let script_id = session.info.script_id.clone();
        // Drop our I/O handles before killing so the reader thread sees EOF.
        drop(session);
        pm.kill(&script_id).await
    }

    /// WS9: stop every PTY by routing each through `ProcessManager::kill`
    /// (uniform with piped). Mirrors `kill` for each live I/O session.
    pub async fn kill_all(&self, pm: &ProcessManager) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            let _ = self.kill(&id, pm).await;
        }
    }

    /// WS9: drop a leftover I/O session for `script_id` without killing the
    /// process (the process is already gone). Called by `dismiss_process` so a
    /// dismissed PTY entry leaves no dangling reader/writer/buffer.
    pub fn remove_io_for_script(&self, script_id: &str) {
        let ids: Vec<String> = self
            .sessions
            .iter()
            .filter(|e| e.value().info.script_id == script_id)
            .map(|e| e.key().clone())
            .collect();
        for id in ids {
            self.sessions.remove(&id);
        }
    }

    async fn start_script(
        &self,
        project_id: String,
        script_id: String,
        cols: u16,
        rows: u16,
        state: &AppState,
        pm: &ProcessManager,
    ) -> Result<PtySessionInfo, String> {
        if let Some(existing) = self.find_by_script(&script_id) {
            let _ = self.resize(&existing.id, cols, rows);
            return Ok(existing);
        }

        let (script, cwd) = crate::commands::process::find_script(state, &project_id, &script_id)
            .await
            .ok_or_else(|| format!("script not found: {}/{}", project_id, script_id))?;
        let command_line = command_line_for_script(&script, Some(&cwd));
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(cols, rows))
            .map_err(|e| format!("open pty: {}", e))?;

        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.args(["-l", "-c", &command_line]);
        cmd.cwd(cwd);
        cmd.env("FORCE_COLOR", "1");
        cmd.env("CLICOLOR_FORCE", "1");
        cmd.env("TERM", "xterm-256color");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("pty spawn: {}", e))?;
        let pid = child.process_id();
        drop(pair.slave);

        // WS9 zero-orphan guarantee: the OS process is alive the instant
        // `spawn_command` returns, but it isn't owned by ProcessManager until
        // `register_pty` succeeds, nor reachable for cleanup until the
        // wait-thread is installed. So we hold an independent killer and SIGKILL
        // the child on *every* error path between here and full tracking, and we
        // run all fallible steps (pid / reader / writer / register) BEFORE the
        // infallible session-insert + thread spawn. `register_pty` is therefore
        // the last fallible step, so its failure leaves no pm entry to unwind —
        // we just kill the freshly-spawned child.
        let mut killer = child.clone_killer();
        let Some(pid_u32) = pid else {
            let _ = killer.kill();
            return Err("pty child has no pid".into());
        };
        let mut reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                let _ = killer.kill();
                return Err(format!("pty reader: {}", e));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                let _ = killer.kill();
                return Err(format!("pty writer: {}", e));
            }
        };

        // `register_pty` is the double-run guard: if a live entry already owns
        // this script (piped run or stale PTY) it returns Err, and we do a
        // uniform kill+restart (one retry). Any failure here kills the
        // freshly-spawned child so nothing escapes untracked.
        let (generation, _killed, exited) = match pm.register_pty(&script.id, pid_u32).await {
            Ok(handles) => handles,
            Err(_) => {
                if let Err(e) = pm.kill(&script.id).await {
                    let _ = killer.kill();
                    return Err(e);
                }
                match pm.register_pty(&script.id, pid_u32).await {
                    Ok(handles) => handles,
                    Err(e) => {
                        let _ = killer.kill();
                        return Err(e);
                    }
                }
            }
        };

        let id = Uuid::new_v4().to_string();
        let info = PtySessionInfo {
            id: id.clone(),
            project_id,
            script_id: script.id.clone(),
            pid,
            command: script.command.clone(),
            started_at_ms: now_ms(),
        };
        let session = Arc::new(PtySession {
            info: info.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            buffer: Mutex::new(VecDeque::new()),
        });
        self.sessions.insert(id.clone(), Arc::clone(&session));

        let app = self.app.clone();
        let read_session = Arc::clone(&session);
        let read_id = id.clone();
        let read_script_id = script.id.clone();
        std::thread::spawn(move || {
            let mut bytes = [0_u8; 8192];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&bytes[..n]).to_string();
                        if let Ok(mut buffer) = read_session.buffer.lock() {
                            buffer.push_back(data.clone());
                            while buffer.len() > PTY_BUFFER_LIMIT {
                                buffer.pop_front();
                            }
                        }
                        let _ = app.emit(
                            "pty://data",
                            PtyDataEvent {
                                id: read_id.clone(),
                                script_id: read_script_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        // WS9: the wait-thread owns `child.wait()` (portable-pty's child is a
        // std blocking handle, not tokio). On exit it (a) emits the legacy
        // `pty://exit` for the terminal UI, (b) drops the I/O session, and (c)
        // hands the exit to `ProcessManager::notify_pty_exit` for unified
        // disposition (status classification, crash retention, pid_index,
        // session-restore). The async notify is bridged onto the tauri runtime
        // since we're in a std::thread with no tokio context.
        let app = self.app.clone();
        let sessions = Arc::clone(&self.sessions);
        let wait_id = id.clone();
        let wait_script_id = script.id.clone();
        let pm_for_wait = pm.clone();
        let exited_for_wait = Arc::clone(&exited);
        std::thread::spawn(move || {
            let status = child.wait();
            // Mark exited SYNCHRONOUSLY, the instant the child is reaped, before
            // the async `notify_pty_exit` hop. `kill_with_timeout` gates its
            // `killpg` on this flag; setting it only inside the deferred async
            // task leaves a window where the pid is already reaped (and the OS
            // may reuse it) yet a concurrent kill still sees exited==false and
            // could `killpg` a freed pid. (notify_pty_exit also sets it —
            // idempotent.)
            exited_for_wait.store(true, std::sync::atomic::Ordering::SeqCst);
            let (exit_code, success) = match &status {
                Ok(s) => (Some(s.exit_code() as i32), s.success()),
                Err(_) => (None, false),
            };
            if let Ok(status) = &status {
                let _ = app.emit(
                    "pty://exit",
                    PtyExitEvent {
                        id: wait_id.clone(),
                        script_id: wait_script_id.clone(),
                        exit_code: status.exit_code(),
                        success: status.success(),
                    },
                );
            }
            sessions.remove(&wait_id);
            tauri::async_runtime::spawn(async move {
                pm_for_wait
                    .notify_pty_exit(&wait_script_id, generation, exit_code, success)
                    .await;
            });
        });

        Ok(info)
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(20, 500),
        rows: rows.clamp(5, 200),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn start_pty_session(
    project_id: String,
    script_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    state: tauri::State<'_, Arc<AppState>>,
    pty: tauri::State<'_, PtyManager>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<PtySessionInfo, String> {
    pty.start_script(
        project_id,
        script_id,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        &state,
        &pm,
    )
    .await
}

#[tauri::command]
pub async fn write_pty(
    id: String,
    data: String,
    pty: tauri::State<'_, PtyManager>,
) -> Result<(), String> {
    pty.write(&id, &data)
}

#[tauri::command]
pub async fn resize_pty(
    id: String,
    cols: u16,
    rows: u16,
    pty: tauri::State<'_, PtyManager>,
) -> Result<(), String> {
    pty.resize(&id, cols, rows)
}

#[tauri::command]
pub async fn kill_pty(
    id: String,
    pty: tauri::State<'_, PtyManager>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    pty.kill(&id, &pm).await
}

#[tauri::command]
pub async fn list_pty_sessions(
    pty: tauri::State<'_, PtyManager>,
) -> Result<Vec<PtySessionInfo>, String> {
    Ok(pty.list())
}

#[tauri::command]
pub async fn pty_snapshot(
    id: String,
    pty: tauri::State<'_, PtyManager>,
) -> Result<Vec<String>, String> {
    Ok(pty.snapshot(&id))
}

#[tauri::command]
pub async fn kill_all_pty_sessions(
    pty: tauri::State<'_, PtyManager>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    pty.kill_all(&pm).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_size_clamps_to_safe_bounds() {
        let tiny = pty_size(1, 1);
        assert_eq!(tiny.cols, 20);
        assert_eq!(tiny.rows, 5);

        let huge = pty_size(9999, 9999);
        assert_eq!(huge.cols, 500);
        assert_eq!(huge.rows, 200);
    }
}
