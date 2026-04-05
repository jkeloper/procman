// Group CRUD + batch-run (T19).
//
// LEARN (sequential vs concurrent launches):
//   - We run group members sequentially with a small inter-launch delay so
//     that dependent services (e.g. db before api) have time to boot.
//   - Launch errors DON'T abort the group — we return a list of (member,
//     result) tuples so the UI can show partial success.

use crate::process::ProcessManager;
use crate::state::AppState;
use crate::types::{Group, GroupMember};
use serde::Serialize;
use std::sync::Arc;
use uuid::Uuid;

const INTER_LAUNCH_DELAY_MS: u64 = 400;

#[tauri::command]
pub async fn list_groups(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<Group>, String> {
    let guard = state.config.lock().await;
    Ok(guard.groups.clone())
}

#[tauri::command]
pub async fn create_group(
    name: String,
    members: Vec<GroupMember>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Group, String> {
    if name.trim().is_empty() {
        return Err("name cannot be empty".into());
    }
    let group = Group {
        id: Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        members,
    };
    let to_return = group.clone();
    state
        .mutate(|cfg| cfg.groups.push(group))
        .await
        .map_err(|e| e.to_string())?;
    Ok(to_return)
}

#[tauri::command]
pub async fn update_group(
    id: String,
    name: Option<String>,
    members: Option<Vec<GroupMember>>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Group, String> {
    let result = state
        .mutate(|cfg| {
            let g = cfg.groups.iter_mut().find(|g| g.id == id)?;
            if let Some(n) = name {
                g.name = n.trim().to_string();
            }
            if let Some(m) = members {
                g.members = m;
            }
            Some(g.clone())
        })
        .await
        .map_err(|e| e.to_string())?;
    result.ok_or_else(|| format!("group not found: {}", id))
}

#[tauri::command]
pub async fn delete_group(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let removed = state
        .mutate(|cfg| {
            let before = cfg.groups.len();
            cfg.groups.retain(|g| g.id != id);
            before != cfg.groups.len()
        })
        .await
        .map_err(|e| e.to_string())?;
    if !removed {
        return Err(format!("group not found: {}", id));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct GroupRunResult {
    pub project_id: String,
    pub script_id: String,
    pub ok: bool,
    pub error: Option<String>,
    pub pid: Option<u32>,
}

#[tauri::command]
pub async fn run_group(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Vec<GroupRunResult>, String> {
    // Snapshot members + their scripts/cwd first to avoid holding the lock.
    let members: Vec<(String, String, crate::types::Script, String)> = {
        let guard = state.config.lock().await;
        let g = guard
            .groups
            .iter()
            .find(|g| g.id == id)
            .ok_or_else(|| format!("group not found: {}", id))?;
        g.members
            .iter()
            .filter_map(|m| {
                let proj = guard.projects.iter().find(|p| p.id == m.project_id)?;
                let script = proj.scripts.iter().find(|s| s.id == m.script_id)?.clone();
                Some((m.project_id.clone(), m.script_id.clone(), script, proj.path.clone()))
            })
            .collect()
    };

    let mut out = Vec::new();
    for (project_id, script_id, script, cwd) in members {
        let res = pm.spawn(&script, Some(cwd)).await;
        out.push(match res {
            Ok(pid) => GroupRunResult {
                project_id,
                script_id,
                ok: true,
                error: None,
                pid: Some(pid),
            },
            Err(e) => GroupRunResult {
                project_id,
                script_id,
                ok: false,
                error: Some(e),
                pid: None,
            },
        });
        tokio::time::sleep(std::time::Duration::from_millis(INTER_LAUNCH_DELAY_MS)).await;
    }
    Ok(out)
}
