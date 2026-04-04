// Project CRUD stubs — real impl in T05 (Sprint 1 Week 2).
//
// LEARN (async Tauri commands):
//   - `async fn` + `#[tauri::command]` = this function runs on the Tokio
//     executor managed by Tauri. You can `.await` freely inside.
//   - Returning `Result<Vec<Project>, String>`: the Vec is JSON-serialized as
//     an array, the String error becomes `throw` on the JS side.
//   - `unimplemented!()` is a runtime panic that means "this code path must
//     not be reached yet". Calling this command from JS right now will
//     return an error; the app still compiles.

use crate::types::Project;

#[tauri::command]
pub async fn list_projects() -> Result<Vec<Project>, String> {
    // T04/T05: read from ConfigStore (YAML) and return all registered projects.
    Ok(vec![])
}

#[tauri::command]
pub async fn create_project(_name: String, _path: String) -> Result<Project, String> {
    // T05: validate path exists, generate uuid, persist to config.yaml, return new Project.
    unimplemented!("T05: project creation")
}

#[tauri::command]
pub async fn delete_project(_id: String) -> Result<(), String> {
    // T05: remove from config.yaml + cleanup child scripts.
    unimplemented!("T05: project deletion")
}
