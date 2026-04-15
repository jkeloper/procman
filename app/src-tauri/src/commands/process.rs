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
    // S4: wait for dependencies to be reachable before spawning.
    if !script.depends_on.is_empty() {
        wait_for_dependencies(&state, &pm, &script.depends_on).await?;
    }
    pm.spawn(&script, Some(cwd)).await
}

/// S4: Block until every dep script is (a) currently running in the
/// ProcessManager AND (b) all its declared ports pass a TCP probe.
/// Times out after 30 seconds. Returns a descriptive error describing
/// which dep isn't ready so the user can start / fix it.
async fn wait_for_dependencies(
    state: &AppState,
    pm: &ProcessManager,
    dep_ids: &[String],
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    // Resolve dep scripts once upfront so we fail fast on unknown IDs.
    let dep_scripts: Vec<crate::types::Script> = {
        let guard = state.config.lock().await;
        let mut acc = Vec::with_capacity(dep_ids.len());
        for id in dep_ids {
            let found = guard
                .projects
                .iter()
                .flat_map(|p| p.scripts.iter())
                .find(|s| s.id == *id)
                .cloned();
            match found {
                Some(s) => acc.push(s),
                None => return Err(format!("unknown dependency script id: {}", id)),
            }
        }
        acc
    };

    loop {
        let running: std::collections::HashSet<String> =
            pm.list().into_iter().map(|s| s.id).collect();
        let mut pending: Vec<String> = Vec::new();
        for dep in &dep_scripts {
            if !running.contains(&dep.id) {
                pending.push(format!("{} (not running)", dep.name));
                continue;
            }
            // If the dep has declared ports, probe them. No ports → just
            // require running state.
            for spec in &dep.ports {
                let ok = crate::commands::port::tcp_probe(&spec.bind, spec.number, 300).await;
                if !ok {
                    pending.push(format!("{}:{}", dep.name, spec.name));
                }
            }
        }
        if pending.is_empty() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "timed out waiting for dependencies: {}",
                pending.join(", ")
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
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

/// S3: Substring search over the in-memory ring buffer. `limit` caps
/// the number of hits returned. `case_sensitive` defaults to false.
#[tauri::command]
pub async fn search_log(
    script_id: String,
    query: String,
    case_sensitive: Option<bool>,
    limit: Option<usize>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Vec<LogLine>, String> {
    Ok(pm.log_search(
        &script_id,
        &query,
        case_sensitive.unwrap_or(false),
        limit.unwrap_or(500),
    ))
}

#[tauri::command]
pub async fn clear_log(
    script_id: String,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    pm.log_clear(&script_id);
    Ok(())
}

/// E1: Kill all running processes and exit the app.
#[tauri::command]
pub async fn force_quit(
    pm: tauri::State<'_, ProcessManager>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    pm.kill_all().await;
    app.exit(0);
    Ok(())
}
