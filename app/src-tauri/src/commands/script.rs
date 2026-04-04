// Script CRUD commands — scripts live inline inside their parent project.
//
// LEARN (nested collection mutation):
//   - Scripts are `Vec<Script>` inside `Project`. To mutate, we find the
//     parent Project first via iter_mut().find(|p| p.id == project_id),
//     then manipulate its `scripts` Vec. This is simpler than a flat
//     `scripts: Vec<(project_id, Script)>` at the cost of one lookup.
//   - `Option::ok_or_else` converts `Option<T>` into `Result<T, E>` with
//     a lazily-constructed error — use over `.ok_or` when the error value
//     requires allocation (e.g. format!).

use crate::state::AppState;
use crate::types::Script;
use std::sync::Arc;
use uuid::Uuid;

#[tauri::command]
pub async fn list_scripts(
    project_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<Script>, String> {
    let guard = state.config.lock().await;
    let proj = guard
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project not found: {}", project_id))?;
    Ok(proj.scripts.clone())
}

#[tauri::command]
pub async fn create_script(
    project_id: String,
    name: String,
    command: String,
    expected_port: Option<u16>,
    auto_restart: bool,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Script, String> {
    if name.trim().is_empty() {
        return Err("name cannot be empty".into());
    }
    if command.trim().is_empty() {
        return Err("command cannot be empty".into());
    }
    let script = Script {
        id: Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        command: command.trim().to_string(),
        expected_port,
        auto_restart,
    };
    let to_return = script.clone();
    let found = state
        .mutate(|cfg| {
            if let Some(proj) = cfg.projects.iter_mut().find(|p| p.id == project_id) {
                proj.scripts.push(script);
                true
            } else {
                false
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    if !found {
        return Err(format!("project not found: {}", project_id));
    }
    Ok(to_return)
}

#[tauri::command]
pub async fn update_script(
    project_id: String,
    id: String,
    name: Option<String>,
    command: Option<String>,
    expected_port: Option<Option<u16>>, // Some(None) = clear, None = don't change
    auto_restart: Option<bool>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Script, String> {
    let result = state
        .mutate(|cfg| {
            let proj = cfg.projects.iter_mut().find(|p| p.id == project_id)?;
            let script = proj.scripts.iter_mut().find(|s| s.id == id)?;
            if let Some(n) = name {
                script.name = n.trim().to_string();
            }
            if let Some(c) = command {
                script.command = c.trim().to_string();
            }
            if let Some(p) = expected_port {
                script.expected_port = p;
            }
            if let Some(a) = auto_restart {
                script.auto_restart = a;
            }
            Some(script.clone())
        })
        .await
        .map_err(|e| e.to_string())?;
    result.ok_or_else(|| format!("script not found: {}/{}", project_id, id))
}

#[tauri::command]
pub async fn delete_script(
    project_id: String,
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let removed = state
        .mutate(|cfg| {
            let Some(proj) = cfg.projects.iter_mut().find(|p| p.id == project_id) else {
                return false;
            };
            let before = proj.scripts.len();
            proj.scripts.retain(|s| s.id != id);
            // Cleanup from groups.
            for group in cfg.groups.iter_mut() {
                group
                    .members
                    .retain(|m| !(m.project_id == project_id && m.script_id == id));
            }
            before != proj.scripts.len()
        })
        .await
        .map_err(|e| e.to_string())?;
    if !removed {
        return Err(format!("script not found: {}/{}", project_id, id));
    }
    Ok(())
}
