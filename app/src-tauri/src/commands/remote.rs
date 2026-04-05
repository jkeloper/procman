// Tauri commands for managing the remote control server.

use crate::process::ProcessManager;
use crate::runtime_state::RuntimeStore;
use crate::server::{self, audit::AuditLog, auth, ServerMode, ServerState};
use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct RemoteServerState {
    pub token: Arc<RwLock<String>>,
    pub audit: Arc<AuditLog>,
    pub handle: Arc<tokio::sync::Mutex<Option<server::ServerHandle>>>,
}

impl RemoteServerState {
    pub fn new(initial_token: String) -> Self {
        Self {
            token: Arc::new(RwLock::new(initial_token)),
            audit: Arc::new(AuditLog::new()),
            handle: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub mode: Option<ServerMode>,
    pub token: String,
}

#[tauri::command]
pub async fn server_status(
    remote: tauri::State<'_, RemoteServerState>,
) -> Result<ServerStatus, String> {
    let guard = remote.handle.lock().await;
    let token = remote.token.read().await.clone();
    Ok(match &*guard {
        Some(h) => ServerStatus {
            running: true,
            port: Some(h.port),
            mode: Some(h.mode),
            token,
        },
        None => ServerStatus {
            running: false,
            port: None,
            mode: None,
            token,
        },
    })
}

#[tauri::command]
pub async fn start_server(
    port: u16,
    mode: ServerMode,
    app: AppHandle,
    remote: tauri::State<'_, RemoteServerState>,
) -> Result<ServerStatus, String> {
    // Stop any existing instance first.
    {
        let mut guard = remote.handle.lock().await;
        if let Some(h) = guard.take() {
            let _ = h.shutdown.send(());
        }
    }

    let app_state = app.state::<Arc<AppState>>().inner().clone();
    let pm = app.state::<ProcessManager>().inner().clone();

    let state = ServerState {
        app_handle: app.clone(),
        app_state,
        pm,
        token: Arc::clone(&remote.token),
        audit: Arc::clone(&remote.audit),
    };

    let handle = server::start(state, port, mode).await?;
    let status = ServerStatus {
        running: true,
        port: Some(handle.port),
        mode: Some(handle.mode),
        token: remote.token.read().await.clone(),
    };
    *remote.handle.lock().await = Some(handle);
    Ok(status)
}

#[tauri::command]
pub async fn stop_server(
    remote: tauri::State<'_, RemoteServerState>,
) -> Result<(), String> {
    let mut guard = remote.handle.lock().await;
    if let Some(h) = guard.take() {
        let _ = h.shutdown.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn rotate_token(
    remote: tauri::State<'_, RemoteServerState>,
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<String, String> {
    let new_token = auth::generate_token();
    *remote.token.write().await = new_token.clone();
    store.set_remote_token(new_token.clone()).await.map_err(|e| e.to_string())?;
    Ok(new_token)
}

#[tauri::command]
pub async fn get_audit_log(
    remote: tauri::State<'_, RemoteServerState>,
) -> Result<Vec<crate::server::audit::AuditEntry>, String> {
    Ok(remote.audit.snapshot().await)
}

#[tauri::command]
pub fn local_ip() -> Result<String, String> {
    // Find first non-loopback IPv4 address on the machine.
    use std::net::{IpAddr, UdpSocket};
    // Trick: connect to a public address (no packets sent) to determine
    // which interface/IP would be used.
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.connect("8.8.8.8:80").map_err(|e| e.to_string())?;
    let addr = socket.local_addr().map_err(|e| e.to_string())?;
    match addr.ip() {
        IpAddr::V4(ip) => Ok(ip.to_string()),
        IpAddr::V6(ip) => Ok(ip.to_string()),
    }
}
