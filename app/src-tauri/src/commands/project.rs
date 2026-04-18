// Project CRUD commands — persist to config.yaml via AppState.
//
// LEARN (Tauri state + async commands):
//   - Parameter `state: tauri::State<'_, Arc<AppState>>` is Tauri-injected
//     by matching the type we passed to `.manage(...)` in lib.rs.
//   - `state.inner()` returns `&Arc<AppState>`; clone it to pass to helpers.
//   - Commands return `Result<T, String>` — `.map_err(|e| e.to_string())`
//     on every fallible call converts typed errors into JS-facing strings.

use crate::process::ProcessManager;
use crate::state::AppState;
use crate::types::Project;
use std::sync::Arc;
use uuid::Uuid;

#[tauri::command]
pub async fn list_projects(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<Project>, String> {
    let guard = state.config.lock().await;
    Ok(guard.projects.clone())
}

#[tauri::command]
pub async fn create_project(
    name: String,
    path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Project, String> {
    // Validate path exists + is a directory.
    let pb = std::path::Path::new(&path);
    if !pb.exists() {
        return Err(format!("path does not exist: {}", path));
    }
    if !pb.is_dir() {
        return Err(format!("path is not a directory: {}", path));
    }
    if name.trim().is_empty() {
        return Err("name cannot be empty".into());
    }

    // Dedup by canonical path — same folder can't be registered twice.
    let canon = pb
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.clone());
    {
        let guard = state.config.lock().await;
        if guard.projects.iter().any(|p| {
            std::path::Path::new(&p.path)
                .canonicalize()
                .map(|c| c.to_string_lossy() == canon)
                .unwrap_or(false)
                || p.path == path
        }) {
            return Err(format!("project already registered: {}", canon));
        }
    }

    let project = Project {
        id: Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        path: canon,
        scripts: Vec::new(),
    };
    let to_return = project.clone();
    state
        .mutate(|cfg| cfg.projects.push(project))
        .await
        .map_err(|e| e.to_string())?;
    Ok(to_return)
}

#[tauri::command]
pub async fn update_project(
    id: String,
    name: Option<String>,
    path: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Project, String> {
    // Pre-validate path if provided.
    if let Some(ref p) = path {
        let pb = std::path::Path::new(p);
        if !pb.exists() || !pb.is_dir() {
            return Err(format!("invalid path: {}", p));
        }
    }
    let result = state
        .mutate(|cfg| {
            if let Some(proj) = cfg.projects.iter_mut().find(|p| p.id == id) {
                if let Some(n) = name {
                    proj.name = n.trim().to_string();
                }
                if let Some(p) = path {
                    proj.path = p;
                }
                Some(proj.clone())
            } else {
                None
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    result.ok_or_else(|| format!("project not found: {}", id))
}

#[tauri::command]
pub async fn delete_project(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    // Kill any running processes belonging to this project's scripts (B4).
    let script_ids: Vec<String> = {
        let guard = state.config.lock().await;
        guard
            .projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.scripts.iter().map(|s| s.id.clone()).collect())
            .unwrap_or_default()
    };
    for sid in script_ids {
        let _ = pm.kill(&sid).await;
    }

    // Idempotent delete: if the project is already gone (e.g. removed
    // out-of-band by a config edit), we treat that as success. The
    // end state is what the user wants.
    state
        .mutate(|cfg| {
            cfg.projects.retain(|p| p.id != id);
            for group in cfg.groups.iter_mut() {
                group.members.retain(|m| m.project_id != id);
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn reorder_projects(
    ids: Vec<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .mutate(|cfg| {
            let mut reordered = Vec::with_capacity(ids.len());
            for id in &ids {
                if let Some(pos) = cfg.projects.iter().position(|p| p.id == *id) {
                    reordered.push(cfg.projects.remove(pos));
                }
            }
            // Append any projects not in the ids list (safety)
            reordered.append(&mut cfg.projects);
            cfg.projects = reordered;
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
