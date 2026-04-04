// Project CRUD commands — persist to config.yaml via AppState.
//
// LEARN (Tauri state + async commands):
//   - Parameter `state: tauri::State<'_, Arc<AppState>>` is Tauri-injected
//     by matching the type we passed to `.manage(...)` in lib.rs.
//   - `state.inner()` returns `&Arc<AppState>`; clone it to pass to helpers.
//   - Commands return `Result<T, String>` — `.map_err(|e| e.to_string())`
//     on every fallible call converts typed errors into JS-facing strings.

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

    let project = Project {
        id: Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        path,
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
) -> Result<(), String> {
    let removed = state
        .mutate(|cfg| {
            let before = cfg.projects.len();
            cfg.projects.retain(|p| p.id != id);
            // Also remove from any groups.
            for group in cfg.groups.iter_mut() {
                group.members.retain(|m| m.project_id != id);
            }
            before != cfg.projects.len()
        })
        .await
        .map_err(|e| e.to_string())?;
    if !removed {
        return Err(format!("project not found: {}", id));
    }
    Ok(())
}
