// Remote control server: axum HTTP + WebSocket API.
//
// Lifecycle:
//   - `start(state, port, mode)` spawns a tokio task running axum.
//   - `stop()` signals the task to shut down.
//   - Token is generated on first start and persisted via the runtime_state file.
//
// Mode semantics:
//   - Loopback = bound to 127.0.0.1. Used for local UI + cloudflared tunnel
//     (cloudflared terminates TLS so we serve plain HTTP on loopback).
//   - Lan      = bound to 0.0.0.0, TLS-terminated here with a self-signed
//     certificate cached in the config dir. Mobile clients must pin the
//     cert fingerprint during pairing (self-signed won't validate otherwise).

pub mod audit;
pub mod auth;
pub mod ratelimit;
pub mod routes;
pub mod spa;
pub mod tls;
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
    pub port: u16,
    pub mode: ServerMode,
    /// True when axum-server is terminating TLS locally (LAN mode).
    #[allow(dead_code)]
    pub tls: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerMode {
    /// Bind to 127.0.0.1 only (local UI + cloudflared tunnel).
    Loopback,
    /// Bind to 0.0.0.0 so devices on the same LAN can reach it. TLS enabled.
    Lan,
}

pub async fn start(
    state: ServerState,
    port: u16,
    mode: ServerMode,
) -> Result<ServerHandle, String> {
    // LAN mode advertises TLS but mobile clients can't fully validate a
    // self-signed cert without pinning the fingerprint first. Until that
    // flow lands, surface a loud warning so the user understands the
    // exposure. A hard gate on `AppSettings.lan_mode_opt_in` will replace
    // this once Worker E adds the field.
    // TODO(worker-e): wire AppSettings.lan_mode_opt_in and error out
    // with "LAN mode disabled — TLS pinning incomplete. Set
    // lan_mode_opt_in=true to enable at your own risk." when false.
    if matches!(mode, ServerMode::Lan) {
        log::warn!(
            "LAN mode enabled: TLS pinning flow is incomplete — clients must verify the cert fingerprint manually."
        );
        crate::crash_log::record(
            "LAN mode started without lan_mode_opt_in gate (pending Worker E)",
        );
    }

    let router = routes::build_router(state.clone());

    let bind_ip = match mode {
        ServerMode::Loopback => [127, 0, 0, 1],
        ServerMode::Lan => [0, 0, 0, 0],
    };
    let addr = SocketAddr::from((bind_ip, port));

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    // LAN mode bootstraps a self-signed cert and terminates TLS here.
    // Loopback serves plain HTTP (cloudflared does its own TLS, and the
    // local UI trusts loopback without certs).
    let tls_files = if matches!(mode, ServerMode::Lan) {
        resolve_tls_dir().and_then(|dir| match tls::ensure_self_signed_cert(&dir) {
            Ok(f) => Some(f),
            Err(e) => {
                log::warn!(
                    "TLS cert bootstrap failed, falling back to plain HTTP: {}",
                    e
                );
                None
            }
        })
    } else {
        None
    };
    let use_tls = matches!(mode, ServerMode::Lan) && tls_files.is_some();

    let (actual_addr, port_n) = if use_tls {
        let files = tls_files.expect("use_tls implies tls_files");
        let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(
            &files.cert_path,
            &files.key_path,
        )
        .await
        .map_err(|e| format!("load TLS cert/key: {}", e))?;

        // Pre-bind with std to discover the actual port (port=0 gives an
        // ephemeral one). axum-server flips the listener to non-blocking.
        let std_listener = std::net::TcpListener::bind(addr)
            .map_err(|e| format!("bind {}: {}", addr, e))?;
        let actual = std_listener
            .local_addr()
            .map_err(|e| format!("local_addr: {}", e))?;
        let actual_port = actual.port();
        let app_service = router.into_make_service_with_connect_info::<SocketAddr>();

        tokio::spawn(async move {
            let handle = axum_server::Handle::new();
            let handle_for_shutdown = handle.clone();
            tokio::spawn(async move {
                let _ = shutdown_rx.await;
                handle_for_shutdown
                    .graceful_shutdown(Some(std::time::Duration::from_secs(2)));
            });
            let server = axum_server::from_tcp_rustls(std_listener, tls_config);
            if let Err(e) = server.handle(handle).serve(app_service).await {
                log::warn!("axum-server (tls) exited: {}", e);
            }
        });

        (actual, actual_port)
    } else {
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| format!("bind {}: {}", addr, e))?;
        let actual = listener
            .local_addr()
            .map_err(|e| format!("local_addr: {}", e))?;
        let actual_port = actual.port();
        let app_service = router.into_make_service_with_connect_info::<SocketAddr>();

        tokio::spawn(async move {
            let _ = axum::serve(listener, app_service)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        (actual, actual_port)
    };

    log::info!(
        "procman remote server listening on {} ({:?}) tls={}",
        actual_addr,
        mode,
        use_tls
    );

    Ok(ServerHandle {
        shutdown: shutdown_tx,
        port: port_n,
        mode,
        tls: use_tls,
    })
}

/// Where to persist the self-signed server cert. Mirrors the directory
/// used by `config.yaml` / `runtime.json` so rotation/inspection happens
/// in the same place users already know.
fn resolve_tls_dir() -> Option<std::path::PathBuf> {
    // config_store::default_config_path returns ".../procman/config.yaml";
    // we want its parent directory.
    match crate::config_store::default_config_path() {
        Ok(p) => p.parent().map(std::path::Path::to_path_buf),
        Err(e) => {
            log::warn!("no config dir for TLS cert: {}", e);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_mode_serializes_lowercase() {
        let lan = serde_json::to_string(&ServerMode::Lan).unwrap();
        let lb = serde_json::to_string(&ServerMode::Loopback).unwrap();
        assert_eq!(lan, "\"lan\"");
        assert_eq!(lb, "\"loopback\"");
    }

    #[test]
    fn tls_decision_matrix() {
        // Only Lan + present tls_files activates TLS path.
        let cases = [
            (ServerMode::Loopback, false, false),
            (ServerMode::Loopback, true, false),
            (ServerMode::Lan, false, false),
            (ServerMode::Lan, true, true),
        ];
        for (mode, has_tls, expected) in cases {
            let use_tls = matches!(mode, ServerMode::Lan) && has_tls;
            assert_eq!(use_tls, expected, "mode={:?} has_tls={}", mode, has_tls);
        }
    }
}
