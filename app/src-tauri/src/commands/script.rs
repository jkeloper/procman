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

use crate::process::ProcessManager;
use crate::state::AppState;
use crate::types::{PortSpec, Script};
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

/// S1: Validate and canonicalize a list of PortSpecs.
/// - Rejects empty or overly long names, rejects duplicates within one script.
/// - Rejects invalid characters. Defaults bind if empty.
/// Returns a normalized Vec (clone-with-defaults) or an error message.
pub(crate) fn validate_ports(input: &[PortSpec]) -> Result<Vec<PortSpec>, String> {
    let mut seen_names: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(input.len());
    for p in input {
        let name = p.name.trim().to_string();
        if name.is_empty() {
            return Err("port name cannot be empty".into());
        }
        if name.len() > 32 {
            return Err(format!("port name '{}' exceeds 32 chars", name));
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!(
                "port name '{}' has invalid chars (allowed: a-zA-Z0-9_-)",
                name
            ));
        }
        if !seen_names.insert(name.clone()) {
            return Err(format!("duplicate port name '{}'", name));
        }
        if p.number == 0 {
            return Err(format!("port number 0 is reserved"));
        }
        let bind = if p.bind.trim().is_empty() {
            "127.0.0.1".to_string()
        } else {
            p.bind.clone()
        };
        out.push(PortSpec {
            name,
            number: p.number,
            bind,
            proto: p.proto,
            optional: p.optional,
            note: p.note.clone().filter(|s| !s.trim().is_empty()),
        });
    }
    Ok(out)
}

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
    ports: Option<Vec<PortSpec>>,
    auto_restart: bool,
    env_file: Option<String>,
    depends_on: Option<Vec<String>>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Script, String> {
    if name.trim().is_empty() {
        return Err("name cannot be empty".into());
    }
    if command.trim().is_empty() {
        return Err("command cannot be empty".into());
    }
    let trimmed_name = name.trim().to_string();
    let trimmed_cmd = command.trim().to_string();

    // Dedup within the same project: same (name) OR same (command) is rejected.
    {
        let guard = state.config.lock().await;
        let proj = guard
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .ok_or_else(|| format!("project not found: {}", project_id))?;
        if proj.scripts.iter().any(|s| s.name == trimmed_name) {
            return Err(format!("script with name '{}' already exists", trimmed_name));
        }
        if proj.scripts.iter().any(|s| s.command == trimmed_cmd) {
            return Err(format!("script with identical command already exists"));
        }
    }

    // S1: If declared ports provided, they become authoritative and
    // expected_port is synced from ports[0] at save time. Falling back to
    // legacy expected_port is still allowed when ports is None/empty.
    let validated_ports = validate_ports(&ports.unwrap_or_default())?;
    let effective_expected = validated_ports
        .first()
        .map(|p| p.number)
        .or(expected_port);

    let script = Script {
        id: Uuid::new_v4().to_string(),
        name: trimmed_name,
        command: trimmed_cmd,
        expected_port: effective_expected,
        ports: validated_ports,
        auto_restart,
        env_file: env_file.filter(|s| !s.trim().is_empty()),
        depends_on: depends_on.unwrap_or_default(),
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
    ports: Option<Vec<PortSpec>>,       // S1: None = don't change, Some(vec) = replace (empty clears)
    auto_restart: Option<bool>,
    env_file: Option<Option<String>>,   // Some(None) = clear, None = don't change
    depends_on: Option<Vec<String>>,    // S4: None = don't change, Some(vec) = replace
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Script, String> {
    // Validate ports up front so we can bail without mutating state.
    let validated_ports = match ports {
        Some(v) => Some(validate_ports(&v)?),
        None => None,
    };

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
            if let Some(pts) = validated_ports {
                // Replace declared ports, then sync expected_port from ports[0]
                // so downstream orphan cleanup stays consistent.
                if let Some(first) = pts.first() {
                    script.expected_port = Some(first.number);
                }
                script.ports = pts;
            }
            if let Some(a) = auto_restart {
                script.auto_restart = a;
            }
            if let Some(ef) = env_file {
                script.env_file = ef.filter(|s| !s.trim().is_empty());
            }
            if let Some(deps) = depends_on {
                script.depends_on = deps;
            }
            Some(script.clone())
        })
        .await
        .map_err(|e| e.to_string())?;
    result.ok_or_else(|| format!("script not found: {}/{}", project_id, id))
}

#[tauri::command]
pub async fn reorder_scripts(
    project_id: String,
    ids: Vec<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .mutate(|cfg| {
            let Some(proj) = cfg.projects.iter_mut().find(|p| p.id == project_id) else {
                return;
            };
            let mut reordered = Vec::with_capacity(ids.len());
            for id in &ids {
                if let Some(pos) = proj.scripts.iter().position(|s| s.id == *id) {
                    reordered.push(proj.scripts.remove(pos));
                }
            }
            // Append any scripts not mentioned in ids (safety)
            reordered.append(&mut proj.scripts);
            proj.scripts = reordered;
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_script(
    project_id: String,
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<(), String> {
    // Kill any running process for this script first (B4 orphan cleanup).
    let _ = pm.kill(&id).await;
    // Idempotent delete: if the script (or its parent project) is
    // already gone, treat as success.
    state
        .mutate(|cfg| {
            if let Some(proj) = cfg.projects.iter_mut().find(|p| p.id == project_id) {
                proj.scripts.retain(|s| s.id != id);
            }
            for group in cfg.groups.iter_mut() {
                group
                    .members
                    .retain(|m| !(m.project_id == project_id && m.script_id == id));
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
