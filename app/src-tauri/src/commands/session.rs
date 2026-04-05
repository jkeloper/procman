// Session-restore commands (T27).
//
// Backed by RuntimeStore (separate from config.yaml) so that rapid
// process state changes don't dirty the user's git-tracked config.

use crate::runtime_state::RuntimeStore;
use std::sync::Arc;

#[tauri::command]
pub async fn get_last_running(
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<Vec<String>, String> {
    Ok(store.snapshot().await.last_running)
}

#[tauri::command]
pub async fn clear_last_running(
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<(), String> {
    store.clear_last_running().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_last_running(
    script_id: String,
    running: bool,
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<(), String> {
    store.mark_running(&script_id, running).await;
    Ok(())
}
