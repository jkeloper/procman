// S2 PTY harness — portable-pty based session management.
// Supports multiple concurrent PTY sessions, streams output via events.

use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    _child_killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    writer: Box<dyn Write + Send>,
}

#[derive(Default)]
pub struct PtyState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, PtySession>>,
}

#[derive(Clone, serde::Serialize)]
pub struct PtyDataEvent {
    pub sid: u64,
    pub data: String, // lossy utf8
}

#[derive(Clone, serde::Serialize)]
pub struct PtyExitEvent {
    pub sid: u64,
    pub status: Option<u32>,
}

#[tauri::command]
pub async fn pty_spawn(
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<PtyState>>,
) -> Result<u64, String> {
    let pty_system = NativePtySystem::default();
    let PtyPair { master, slave } = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {}", e))?;

    let mut cmd = CommandBuilder::new(&command);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(d) = cwd {
        cmd.cwd(d);
    }
    // Inherit environment — login shell wrapper handled at caller level
    cmd.env("TERM", "xterm-256color");

    let mut child = slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {}", e))?;
    drop(slave);

    let writer = master.take_writer().map_err(|e| format!("writer: {}", e))?;
    let reader = master.try_clone_reader().map_err(|e| format!("reader: {}", e))?;
    let child_killer = child.clone_killer();

    let sid = state.next_id.fetch_add(1, Ordering::SeqCst);

    // Background reader thread
    let app_clone = app.clone();
    let state_clone = Arc::clone(state.inner());
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_clone.emit(
                        &format!("pty://data/{}", sid),
                        PtyDataEvent { sid, data: s },
                    );
                }
                Err(_) => break,
            }
        }
        let status = child.wait().ok().and_then(|s| Some(s.exit_code()));
        let _ = app_clone.emit(
            &format!("pty://exit/{}", sid),
            PtyExitEvent { sid, status },
        );
        // Auto-remove session on exit
        tokio::task::spawn(async move {
            let mut guard = state_clone.sessions.lock().await;
            guard.remove(&sid);
        });
    });

    state.sessions.lock().await.insert(
        sid,
        PtySession {
            master,
            _child_killer: child_killer,
            writer,
        },
    );

    Ok(sid)
}

#[tauri::command]
pub async fn pty_write(
    sid: u64,
    data: String,
    state: State<'_, Arc<PtyState>>,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().await;
    let sess = guard.get_mut(&sid).ok_or("no such session")?;
    sess.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {}", e))?;
    sess.writer.flush().ok();
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    sid: u64,
    cols: u16,
    rows: u16,
    state: State<'_, Arc<PtyState>>,
) -> Result<(), String> {
    let guard = state.sessions.lock().await;
    let sess = guard.get(&sid).ok_or("no such session")?;
    sess.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(sid: u64, state: State<'_, Arc<PtyState>>) -> Result<(), String> {
    let mut guard = state.sessions.lock().await;
    if let Some(mut sess) = guard.remove(&sid) {
        sess._child_killer.kill().ok();
    }
    Ok(())
}
