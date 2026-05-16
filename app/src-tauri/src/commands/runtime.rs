use crate::commands::port;
use crate::process::{ProcessManager, ProcessSnapshot};
use crate::state::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const RUNTIME_DELTA_EVENT: &str = "runtime://delta";

static RUNTIME_PORTS_DELTA_EMIT_PENDING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
pub struct RuntimePortInfo {
    pub port: u16,
    pub pid: u32,
    pub process_name: String,
    pub command: String,
    pub managed: bool,
    pub owner_project_id: Option<String>,
    pub owner_script_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeSnapshot {
    pub generated_at_ms: u64,
    pub processes: Vec<ProcessSnapshot>,
    pub ports: Vec<RuntimePortInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimePortsSnapshot {
    pub generated_at_ms: u64,
    pub ports: Vec<RuntimePortInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeDelta {
    Metrics {
        generated_at_ms: u64,
        processes: Vec<ProcessSnapshot>,
    },
    Ports {
        generated_at_ms: u64,
        ports: Vec<RuntimePortInfo>,
    },
}

/// Single frontend bootstrap point for runtime state.
///
/// This is the first step toward making the Rust backend the authority for
/// process/port ownership. The frontend can render Dashboard state from this
/// one snapshot instead of stitching together list_ports + list_processes +
/// descendant pid scans itself.
#[tauri::command]
pub async fn runtime_snapshot(
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<RuntimeSnapshot, String> {
    build_runtime_snapshot(&state, &pm).await
}

#[tauri::command]
pub async fn runtime_ports(
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<RuntimePortsSnapshot, String> {
    let processes = pm.list();
    let ports = build_runtime_ports(&state, &processes).await?;
    Ok(RuntimePortsSnapshot {
        generated_at_ms: now_ms(),
        ports,
    })
}

pub async fn build_runtime_snapshot(
    state: &AppState,
    pm: &ProcessManager,
) -> Result<RuntimeSnapshot, String> {
    let processes = pm.list();
    let ports = build_runtime_ports(state, &processes).await?;

    Ok(RuntimeSnapshot {
        generated_at_ms: now_ms(),
        processes,
        ports,
    })
}

pub async fn build_runtime_ports(
    state: &AppState,
    processes: &[ProcessSnapshot],
) -> Result<Vec<RuntimePortInfo>, String> {
    let ports = port::list_ports().await?;
    let script_projects = script_project_index(state).await;
    let roots: Vec<port::PortOwnerRoot> = processes
        .iter()
        .filter_map(|process| {
            let project_id = script_projects.get(&process.id)?;
            Some(port::PortOwnerRoot {
                root_pid: process.pid,
                project_id: project_id.clone(),
                script_id: process.id.clone(),
            })
        })
        .collect();
    let owners = port::PortOwnershipCache::build(&ports, &roots);

    let ports = ports
        .into_iter()
        .map(|info| {
            let owner = owners.owner_for(info.pid);
            RuntimePortInfo {
                port: info.port,
                pid: info.pid,
                process_name: info.process_name,
                command: info.command,
                managed: owner.is_some(),
                owner_project_id: owner.map(|(project_id, _)| project_id.clone()),
                owner_script_id: owner.map(|(_, script_id)| script_id.clone()),
            }
        })
        .collect();
    Ok(ports)
}

pub fn schedule_runtime_ports_delta_emit(app: &AppHandle, delay: Duration) {
    if RUNTIME_PORTS_DELTA_EMIT_PENDING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }

        let result = async {
            let state = app
                .try_state::<Arc<AppState>>()
                .ok_or_else(|| "AppState unavailable".to_string())?;
            let pm = app
                .try_state::<ProcessManager>()
                .ok_or_else(|| "ProcessManager unavailable".to_string())?;
            let processes = pm.list();
            let ports = build_runtime_ports(state.inner(), &processes).await?;
            let delta = RuntimeDelta::Ports {
                generated_at_ms: now_ms(),
                ports,
            };
            app.emit(RUNTIME_DELTA_EVENT, &delta)
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        }
        .await;

        if let Err(e) = result {
            log::warn!("runtime ports delta emit failed: {}", e);
        }
        RUNTIME_PORTS_DELTA_EMIT_PENDING.store(false, Ordering::SeqCst);
    });
}

pub fn emit_runtime_metrics_delta(app: &AppHandle, processes: &[ProcessSnapshot]) {
    let delta = RuntimeDelta::Metrics {
        generated_at_ms: now_ms(),
        processes: processes.to_vec(),
    };
    if let Err(e) = app.emit(RUNTIME_DELTA_EVENT, &delta) {
        log::warn!("runtime delta emit failed: {}", e);
    }
}

async fn script_project_index(state: &AppState) -> HashMap<String, String> {
    let guard = state.config.lock().await;
    let mut out = HashMap::new();
    for project in &guard.projects {
        for script in &project.scripts {
            out.insert(script.id.clone(), project.id.clone());
        }
    }
    out
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
