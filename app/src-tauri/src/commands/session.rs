// Session-restore commands (T27).
//
// When a script spawns, we append its id to `last_running`. When it stops,
// we remove it. On startup the UI calls get_last_running() to decide
// whether to show the restore prompt.

use crate::state::AppState;
use std::sync::Arc;

#[tauri::command]
pub async fn get_last_running(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let guard = state.config.lock().await;
    Ok(guard.last_running.clone())
}

#[tauri::command]
pub async fn clear_last_running(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .mutate(|cfg| cfg.last_running.clear())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mark_last_running(
    script_id: String,
    running: bool,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .mutate(|cfg| {
            if running {
                if !cfg.last_running.contains(&script_id) {
                    cfg.last_running.push(script_id);
                }
            } else {
                cfg.last_running.retain(|id| id != &script_id);
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
