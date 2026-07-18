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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionCloseReason {
    ServerStopped,
    TokenRotated,
}

#[derive(Clone)]
pub struct ServerState {
    pub app_handle: AppHandle,
    pub app_state: Arc<AppState>,
    pub pm: ProcessManager,
    pub token: Arc<RwLock<String>>,
    pub audit: Arc<audit::AuditLog>,
    /// Sticky, reason-carrying signal that force-closes every WebSocket stream.
    /// Token auth is
    /// only checked at the handshake, and an upgraded WebSocket detaches from
    /// axum's graceful shutdown at upgrade time, so bouncing the server does
    /// NOT drop live streams. The latest reason remains observable even if it
    /// lands between auth middleware and the upgrade callback.
    pub close_conns: tokio::sync::watch::Sender<Option<ConnectionCloseReason>>,
}

pub struct ServerHandle {
    pub shutdown: oneshot::Sender<()>,
    pub port: u16,
    pub mode: ServerMode,
    /// True when axum-server is terminating TLS locally (LAN mode).
    pub tls: bool,
    /// SHA-256 fingerprint of the active LAN TLS certificate.
    pub cert_fingerprint_sha256: Option<String>,
    /// Set a close reason to force every open WebSocket on this instance to
    /// close. Must be triggered alongside `shutdown` when bouncing the server (see
    /// `ServerState::close_conns`).
    pub close_conns: tokio::sync::watch::Sender<Option<ConnectionCloseReason>>,
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
    if matches!(mode, ServerMode::Lan) {
        log::warn!(
            "LAN mode enabled: only native clients pinning the pairing certificate are supported."
        );
    }

    let router = routes::build_router(state.clone(), mode);

    let bind_ip = match mode {
        ServerMode::Loopback => [127, 0, 0, 1],
        ServerMode::Lan => [0, 0, 0, 0],
    };
    let addr = SocketAddr::from((bind_ip, port));

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    // LAN mode bootstraps a self-signed cert and terminates TLS here.
    // Loopback serves plain HTTP (cloudflared does its own TLS, and the
    // local UI trusts loopback without certs).
    // LAN is a remote-control security boundary: never bind 0.0.0.0 unless
    // both the certificate and its pairing fingerprint are ready. Falling
    // back to plaintext here would expose the bearer token and every process
    // mutation API to passive LAN observers.
    let lan_transport = match mode {
        ServerMode::Loopback => None,
        ServerMode::Lan => {
            let dir = resolve_tls_dir().ok_or_else(|| {
                "LAN TLS unavailable: cannot resolve config directory".to_string()
            })?;
            Some(prepare_lan_transport(&dir, addr).await?)
        }
    };
    let use_tls = lan_transport.is_some();
    let cert_fingerprint_sha256 = lan_transport
        .as_ref()
        .map(|prepared| prepared.cert_fingerprint_sha256.clone());

    let (actual_addr, port_n) = if let Some(prepared) = lan_transport {
        let std_listener = prepared.listener;
        let actual = std_listener
            .local_addr()
            .map_err(|e| format!("local_addr: {e}"))?;
        let actual_port = actual.port();
        let app_service = router.into_make_service_with_connect_info::<SocketAddr>();

        tokio::spawn(async move {
            let handle = axum_server::Handle::new();
            let handle_for_shutdown = handle.clone();
            tokio::spawn(async move {
                let _ = shutdown_rx.await;
                handle_for_shutdown.graceful_shutdown(Some(std::time::Duration::from_secs(2)));
            });
            let server = axum_server::from_tcp_rustls(std_listener, prepared.tls_config);
            if let Err(e) = server.handle(handle).serve(app_service).await {
                log::warn!("axum-server (tls) exited: {e}");
            }
        });

        (actual, actual_port)
    } else {
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| format!("bind {addr}: {e}"))?;
        let actual = listener
            .local_addr()
            .map_err(|e| format!("local_addr: {e}"))?;
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

    log::info!("procman remote server listening on {actual_addr} ({mode:?}) tls={use_tls}");

    Ok(ServerHandle {
        shutdown: shutdown_tx,
        port: port_n,
        mode,
        tls: use_tls,
        cert_fingerprint_sha256,
        close_conns: state.close_conns.clone(),
    })
}

struct PreparedLanTransport {
    listener: std::net::TcpListener,
    tls_config: axum_server::tls_rustls::RustlsConfig,
    cert_fingerprint_sha256: String,
}

/// Prepare every TLS prerequisite before opening the LAN listener. Keeping
/// certificate generation, fingerprinting, and rustls parsing in this helper
/// makes the fail-closed ordering testable: no error path above `bind` can
/// accidentally leave a plaintext listener on the requested address.
async fn prepare_lan_transport(
    config_dir: &std::path::Path,
    addr: SocketAddr,
) -> Result<PreparedLanTransport, String> {
    let (files, cert_fingerprint_sha256) = prepare_lan_tls(config_dir)?;
    let tls_config =
        axum_server::tls_rustls::RustlsConfig::from_pem_file(&files.cert_path, &files.key_path)
            .await
            .map_err(|e| format!("load TLS cert/key: {e}"))?;

    // Bind only after the certificate, fingerprint, and rustls config have all
    // succeeded. Port 0 is supported so callers can request an ephemeral port.
    let listener = std::net::TcpListener::bind(addr).map_err(|e| format!("bind {addr}: {e}"))?;
    Ok(PreparedLanTransport {
        listener,
        tls_config,
        cert_fingerprint_sha256,
    })
}

fn prepare_lan_tls(config_dir: &std::path::Path) -> Result<(tls::TlsFiles, String), String> {
    let files = tls::ensure_self_signed_cert(config_dir)
        .map_err(|e| format!("LAN TLS certificate setup failed: {e}"))?;
    let fingerprint = tls::fingerprint_sha256_file(&files.cert_path)
        .map_err(|e| format!("LAN TLS fingerprint failed: {e}"))?;
    Ok((files, fingerprint))
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
            log::warn!("no config dir for TLS cert: {e}");
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

    fn ephemeral_loopback_addr() -> SocketAddr {
        // Keep port 0 rather than probing and releasing a concrete ephemeral
        // port. Parallel tests or local software can legitimately claim a
        // released port between the probe and the assertion, making this
        // fail-closed ordering check flaky for reasons unrelated to TLS.
        SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, 0))
    }

    #[tokio::test]
    async fn lan_certificate_failure_happens_before_listener_bind() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-directory");
        std::fs::write(&blocker, b"block mkdir").unwrap();
        let addr = ephemeral_loopback_addr();

        let result = prepare_lan_transport(&blocker, addr).await;
        assert!(result.is_err());
        let rebound = std::net::TcpListener::bind(addr);
        assert!(
            rebound.is_ok(),
            "TLS setup failure must leave the requested address unbound"
        );
    }

    #[tokio::test]
    async fn invalid_tls_key_happens_before_listener_bind() {
        let dir = tempfile::tempdir().unwrap();
        let files = tls::ensure_self_signed_cert(dir.path()).unwrap();
        std::fs::write(&files.key_path, b"not a PEM private key").unwrap();
        let addr = ephemeral_loopback_addr();

        let error = match prepare_lan_transport(dir.path(), addr).await {
            Ok(_) => panic!("invalid key must reject LAN startup"),
            Err(error) => error,
        };
        assert!(error.contains("load TLS cert/key"), "{error}");
        let rebound = std::net::TcpListener::bind(addr);
        assert!(
            rebound.is_ok(),
            "TLS parsing failure must leave the requested address unbound"
        );
    }
}
