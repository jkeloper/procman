use crate::process::command_line_for_script;
use crate::state::AppState;
use dashmap::DashMap;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
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

struct PtySession {
    info: PtySessionInfo,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
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

    pub fn active_count(&self) -> usize {
        self.sessions.len()
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

    fn kill(&self, id: &str) -> Result<(), String> {
        let Some((_, session)) = self.sessions.remove(id) else {
            return Ok(());
        };
        let result = session
            .killer
            .lock()
            .map_err(|_| "pty killer lock poisoned".to_string())?
            .kill()
            .map_err(|e| format!("pty kill: {}", e));
        result
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }

    async fn start_script(
        &self,
        project_id: String,
        script_id: String,
        cols: u16,
        rows: u16,
        state: &AppState,
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
        let killer = child.clone_killer();
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("pty reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("pty writer: {}", e))?;

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
            killer: Mutex::new(killer),
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

        let app = self.app.clone();
        let sessions = Arc::clone(&self.sessions);
        let wait_id = id.clone();
        let wait_script_id = script.id;
        std::thread::spawn(move || {
            let status = child.wait();
            if let Ok(status) = status {
                let _ = app.emit(
                    "pty://exit",
                    PtyExitEvent {
                        id: wait_id.clone(),
                        script_id: wait_script_id,
                        exit_code: status.exit_code(),
                        success: status.success(),
                    },
                );
            }
            sessions.remove(&wait_id);
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
) -> Result<PtySessionInfo, String> {
    pty.start_script(
        project_id,
        script_id,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        &state,
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
pub async fn kill_pty(id: String, pty: tauri::State<'_, PtyManager>) -> Result<(), String> {
    pty.kill(&id)
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
pub async fn kill_all_pty_sessions(pty: tauri::State<'_, PtyManager>) -> Result<(), String> {
    pty.kill_all();
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
