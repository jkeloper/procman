// Tauri commands for managing the remote control server.

use crate::process::ProcessManager;
use crate::runtime_state::RuntimeStore;
use crate::server::{self, audit::AuditLog, auth, ConnectionCloseReason, ServerMode, ServerState};
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

#[derive(Debug, Clone, Copy, PartialEq)]
struct ServerRestart {
    port: u16,
    mode: ServerMode,
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
            h.close_conns
                .send_replace(Some(ConnectionCloseReason::ServerStopped));
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

    // Fresh per-instance sticky force-close token; it is also stored on the
    // returned `ServerHandle` so stop/rotate can drop every open WebSocket,
    // including one still in the auth→upgrade interval.
    let (close_conns, _) = tokio::sync::watch::channel(None);

    let state = ServerState {
        app_handle: app.clone(),
        app_state,
        pm,
        token: Arc::clone(&remote.token),
        audit: Arc::clone(&remote.audit),
        close_conns,
    };
    server::start(state, port, mode).await
}

#[tauri::command]
pub async fn stop_server(remote: tauri::State<'_, RemoteServerState>) -> Result<(), String> {
    let mut guard = remote.handle.lock().await;
    if let Some(h) = guard.take() {
        h.close_conns
            .send_replace(Some(ConnectionCloseReason::ServerStopped));
        let _ = h.shutdown.send(());
    }
    Ok(())
}

/// Persist and commit a token rotation as one security transition.
///
/// The server handle and live token stay locked while persistence runs. If the
/// write fails, both remain untouched and existing WebSockets remain open with
/// the still-valid old credential. Once persistence succeeds there are no
/// await points between swapping the live token, taking the server handle, and
/// signalling every upgraded connection plus the listener to close.
async fn commit_token_rotation(
    remote: &RemoteServerState,
    store: &Arc<RuntimeStore>,
    new_token: &str,
) -> Result<Option<ServerRestart>, String> {
    // Match server_status's lock order (handle -> token) to avoid inversion.
    let mut handle = remote.handle.lock().await;
    let mut live_token = remote.token.write().await;
    let next_token = new_token.to_string();

    store
        .set_remote_token(next_token.clone())
        .await
        .map_err(|e| e.to_string())?;

    *live_token = next_token;
    let restart = handle.take().map(|server| {
        let restart = ServerRestart {
            port: server.port,
            mode: server.mode,
        };
        server
            .close_conns
            .send_replace(Some(ConnectionCloseReason::TokenRotated));
        let _ = server.shutdown.send(());
        restart
    });
    Ok(restart)
}

#[tauri::command]
pub async fn rotate_token(
    app: AppHandle,
    remote: tauri::State<'_, RemoteServerState>,
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<String, String> {
    let new_token = auth::generate_token();

    // Token auth is only checked at the HTTP/WS handshake, so already-open
    // WebSockets would otherwise keep streaming under the old credential.
    // Graceful server shutdown alone does NOT drop them — an upgraded socket
    // detaches from axum's shutdown at upgrade time — so we explicitly fire
    // `close_conns` (below) to force every live socket closed, then bounce the
    // server on the same port/mode so clients must re-handshake with the new
    // token. The QR/pairing payload is derived from the token, so the desktop
    // UI re-renders it after this returns.
    let restart = commit_token_rotation(&remote, &store, &new_token).await?;
    if let Some(restart) = restart {
        // Give the listener a beat to release the socket before re-binding.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        match spawn_server(&app, &remote, restart.port, restart.mode).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn server_handle(
        port: u16,
    ) -> (
        server::ServerHandle,
        tokio::sync::watch::Receiver<Option<ConnectionCloseReason>>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
        let (close_conns, close_observer) = tokio::sync::watch::channel(None);
        (
            server::ServerHandle {
                shutdown,
                port,
                mode: ServerMode::Loopback,
                tls: false,
                cert_fingerprint_sha256: None,
                close_conns,
            },
            close_observer,
            shutdown_rx,
        )
    }

    fn remote_with_handle(token: &str, handle: server::ServerHandle) -> RemoteServerState {
        RemoteServerState {
            token: Arc::new(RwLock::new(token.to_string())),
            audit: Arc::new(AuditLog::new()),
            handle: Arc::new(tokio::sync::Mutex::new(Some(handle))),
        }
    }

    #[tokio::test]
    async fn rotation_success_persists_swaps_and_closes_as_one_transition() {
        let dir = tempfile::tempdir().unwrap();
        let store = RuntimeStore::load(dir.path().join("runtime.json")).unwrap();
        store.set_remote_token("old-token".into()).await.unwrap();
        let (handle, close_observer, shutdown_rx) = server_handle(43123);
        let remote = remote_with_handle("old-token", handle);

        let restart = commit_token_rotation(&remote, &store, "new-token")
            .await
            .unwrap();

        assert_eq!(
            restart,
            Some(ServerRestart {
                port: 43123,
                mode: ServerMode::Loopback,
            })
        );
        assert_eq!(*remote.token.read().await, "new-token");
        assert_eq!(store.get_remote_token().await, "new-token");
        assert!(remote.handle.lock().await.is_none());
        assert_eq!(
            *close_observer.borrow(),
            Some(ConnectionCloseReason::TokenRotated)
        );
        shutdown_rx.await.unwrap();

        let reloaded = RuntimeStore::load(dir.path().join("runtime.json")).unwrap();
        assert_eq!(reloaded.get_remote_token().await, "new-token");
    }

    #[tokio::test]
    async fn rotation_persistence_failure_preserves_token_handle_and_connections() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let runtime_path = config_dir.join("runtime.json");
        let store = RuntimeStore::load(runtime_path.clone()).unwrap();
        store.set_remote_token("old-token".into()).await.unwrap();

        // Turn the parent directory into a regular file so the next atomic
        // snapshot write fails deterministically on every platform.
        std::fs::remove_file(&runtime_path).unwrap();
        std::fs::remove_dir(&config_dir).unwrap();
        std::fs::write(&config_dir, b"blocks runtime directory").unwrap();

        let (handle, close_observer, mut shutdown_rx) = server_handle(43124);
        let remote = remote_with_handle("old-token", handle);
        let result = commit_token_rotation(&remote, &store, "new-token").await;

        assert!(result.is_err());
        assert_eq!(*remote.token.read().await, "old-token");
        assert_eq!(store.get_remote_token().await, "old-token");
        assert!(remote.handle.lock().await.is_some());
        assert_eq!(*close_observer.borrow(), None);
        assert!(matches!(
            shutdown_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
    }
}
