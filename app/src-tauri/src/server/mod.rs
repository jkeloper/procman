// Remote control server: axum HTTP + WebSocket API.
//
// Lifecycle:
//   - `start(state, port, bind_addr)` spawns a tokio task running axum.
//   - `stop()` signals the task to shut down.
//   - Token is generated on first start and persisted via the runtime_state file.

pub mod audit;
pub mod auth;
pub mod routes;
pub mod ws;

use crate::process::ProcessManager;
use crate::state::AppState;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::{oneshot, RwLock};

#[derive(Clone)]
pub struct ServerState {
    pub app_handle: AppHandle,
    pub app_state: Arc<AppState>,
    pub pm: ProcessManager,
    pub token: Arc<RwLock<String>>,
    pub audit: Arc<audit::AuditLog>,
}

pub struct ServerHandle {
    pub shutdown: oneshot::Sender<()>,
    pub addr: SocketAddr,
    pub port: u16,
    pub mode: ServerMode,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerMode {
    /// Bind to 127.0.0.1 only.
    Loopback,
    /// Bind to 0.0.0.0 so devices on the same LAN can reach it.
    Lan,
}

pub async fn start(
    state: ServerState,
    port: u16,
    mode: ServerMode,
) -> Result<ServerHandle, String> {
    let router = routes::build_router(state.clone());

    let bind_ip = match mode {
        ServerMode::Loopback => [127, 0, 0, 1],
        ServerMode::Lan => [0, 0, 0, 0],
    };
    let addr = SocketAddr::from((bind_ip, port));

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {}: {}", addr, e))?;
    let actual_addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {}", e))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    log::info!("procman remote server listening on {} ({:?})", actual_addr, mode);

    Ok(ServerHandle {
        shutdown: shutdown_tx,
        addr: actual_addr,
        port: actual_addr.port(),
        mode,
    })
}
