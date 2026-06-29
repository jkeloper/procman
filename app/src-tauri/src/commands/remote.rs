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
        // Persist the audit trail to disk so remote mutations (kill/start of
        // prod-adjacent processes from a phone) survive app restarts. The
        // rotating writer (5 MB × keep-3) creates the parent dir on open and
        // degrades to in-memory-only if the path can't be opened.
        let audit = match crate::server::audit::default_audit_path() {
            Some(path) => AuditLog::with_file(path),
            None => AuditLog::new(),
        };
        Self {
            token: Arc::new(RwLock::new(initial_token)),
            audit: Arc::new(audit),
            handle: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub mode: Option<ServerMode>,
    pub tls: bool,
    pub cert_fingerprint_sha256: Option<String>,
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
            tls: h.tls,
            cert_fingerprint_sha256: h.cert_fingerprint_sha256.clone(),
            token,
        },
        None => ServerStatus {
            running: false,
            port: None,
            mode: None,
            tls: false,
            cert_fingerprint_sha256: None,
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
    if matches!(mode, ServerMode::Lan) {
        let app_state = app.state::<Arc<AppState>>().inner().clone();
        let cfg = app_state.config.lock().await;
        if !cfg.settings.lan_mode_opt_in {
            return Err("LAN mode is disabled. Enable it in Settings first.".into());
        }
    }

    // Stop any existing instance first.
    {
        let mut guard = remote.handle.lock().await;
        if let Some(h) = guard.take() {
            let _ = h.shutdown.send(());
        }
    }

    let handle = spawn_server(&app, &remote, port, mode).await?;
    let status = ServerStatus {
        running: true,
        port: Some(handle.port),
        mode: Some(handle.mode),
        tls: handle.tls,
        cert_fingerprint_sha256: handle.cert_fingerprint_sha256.clone(),
        token: remote.token.read().await.clone(),
    };
    *remote.handle.lock().await = Some(handle);
    Ok(status)
}

/// Build a fresh `ServerState` from the live Tauri state and start the axum
/// server. Shared by `start_server` and the token-rotation restart path so
/// both construct the server identically.
async fn spawn_server(
    app: &AppHandle,
    remote: &RemoteServerState,
    port: u16,
    mode: ServerMode,
) -> Result<server::ServerHandle, String> {
    let app_state = app.state::<Arc<AppState>>().inner().clone();
    let pm = app.state::<ProcessManager>().inner().clone();

    let state = ServerState {
        app_handle: app.clone(),
        app_state,
        pm,
        token: Arc::clone(&remote.token),
        audit: Arc::clone(&remote.audit),
    };
    server::start(state, port, mode).await
}

#[tauri::command]
pub async fn stop_server(remote: tauri::State<'_, RemoteServerState>) -> Result<(), String> {
    let mut guard = remote.handle.lock().await;
    if let Some(h) = guard.take() {
        let _ = h.shutdown.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn rotate_token(
    app: AppHandle,
    remote: tauri::State<'_, RemoteServerState>,
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<String, String> {
    let new_token = auth::generate_token();
    *remote.token.write().await = new_token.clone();
    store
        .set_remote_token(new_token.clone())
        .await
        .map_err(|e| e.to_string())?;

    // Token auth is only checked at the HTTP/WS handshake, so already-open
    // WebSockets would otherwise keep streaming under the old credential.
    // Bounce the server (if running) on the same port/mode: graceful
    // shutdown drops every active connection, forcing clients to re-handshake
    // with the new token. The QR/pairing payload is derived from the token,
    // so the desktop UI re-renders it after this returns.
    let prev = {
        let mut guard = remote.handle.lock().await;
        guard.take()
    };
    if let Some(h) = prev {
        let port = h.port;
        let mode = h.mode;
        let _ = h.shutdown.send(());
        // Give the listener a beat to release the socket before re-binding.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        match spawn_server(&app, &remote, port, mode).await {
            Ok(new_handle) => {
                *remote.handle.lock().await = Some(new_handle);
            }
            Err(e) => {
                // Restart failed: leave the server stopped rather than running
                // with stale active sockets. The user can start it again.
                log::warn!("server restart after token rotation failed: {}", e);
                return Err(format!(
                    "token rotated but server restart failed: {}. Start the server again.",
                    e
                ));
            }
        }
    }

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
