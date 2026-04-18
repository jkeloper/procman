// Tauri commands exposing persistent log search (Phase B Worker K).
//
// The actual sqlite work is in `crate::log_storage`. These wrappers just
// surface it over the IPC boundary with a small ergonomic layer (optional
// limit default, etc.).

use crate::log_storage::{self, LogLineRecord, StorageStats};

const DEFAULT_SEARCH_LIMIT: usize = 500;
const MAX_SEARCH_LIMIT: usize = 5000;

#[tauri::command]
pub async fn search_log(
    query: String,
    script_id: Option<String>,
    since_ms: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<LogLineRecord>, String> {
    let cap = limit.unwrap_or(DEFAULT_SEARCH_LIMIT).min(MAX_SEARCH_LIMIT);
    // Run the (synchronous) sqlite call on tokio's blocking pool so we don't
    // park the executor during a slow FTS scan. The bulk of queries return
    // in <5 ms on typical dev-workstation DBs, but pathological regex-heavy
    // MATCH strings can spike.
    tokio::task::spawn_blocking(move || {
        log_storage::search(&query, script_id.as_deref(), since_ms, cap)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

#[tauri::command]
pub async fn get_log_storage_stats() -> Result<StorageStats, String> {
    tokio::task::spawn_blocking(log_storage::stats)
        .await
        .map_err(|e| format!("join: {}", e))?
}
