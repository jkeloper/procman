// Process lifecycle commands (T11-T14, T16, T18).

use crate::log_buffer::LogLine;
use crate::process::{ProcessManager, ProcessSnapshot};
use crate::state::AppState;
use std::sync::Arc;

/// Resolve (project_id, script_id) → (Script, cwd) from the in-memory config.
/// Uses async lock to avoid blocking the tokio runtime (UNI-1 fix).
async fn find_script(
    state: &AppState,
    project_id: &str,
    script_id: &str,
) -> Option<(crate::types::Script, String)> {
    let guard = state.config.lock().await;
    let proj = guard.projects.iter().find(|p| p.id == project_id)?;
    let script = proj.scripts.iter().find(|s| s.id == script_id)?.clone();
    Some((script, proj.path.clone()))
}

#[tauri::command]
pub async fn spawn_process(
    project_id: String,
    script_id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<u32, String> {
    let (script, cwd) = find_script(&state, &project_id, &script_id)
        .await
        .ok_or_else(|| format!("script not found: {}/{}", project_id, script_id))?;
    pm.spawn(&script, Some(cwd)).await
}

#[tauri::command]
pub async fn kill_process(
    script_id: String,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    pm.kill(&script_id).await
}

#[tauri::command]
pub async fn restart_process(
    project_id: String,
    script_id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<u32, String> {
    let (script, cwd) = find_script(&state, &project_id, &script_id)
        .await
        .ok_or_else(|| format!("script not found: {}/{}", project_id, script_id))?;
    pm.restart(&script, Some(cwd)).await
}

#[tauri::command]
pub async fn list_processes(
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Vec<ProcessSnapshot>, String> {
    Ok(pm.list())
}

#[tauri::command]
pub async fn log_snapshot(
    script_id: String,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Vec<LogLine>, String> {
    Ok(pm.log_snapshot(&script_id))
}
