// Token-based authentication for remote API.
//
// Single pre-shared bearer token, checked via constant-time comparison.
// Token is generated on first server start and persisted; rotation wipes it.
//
// Requests also pass through a per-IP rate limiter (see ratelimit.rs). Auth
// failures feed a 401-circuit-breaker so brute force token guessing hits a
// short ban quickly. Production AuthState values share the process-wide
// limiter; tests inject an isolated limiter so exact boundary counts are
// deterministic even when the Rust test runner executes cases concurrently.

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use base64::{engine::general_purpose, Engine as _};
use rand::RngCore;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use tokio::sync::RwLock;

use super::{ratelimit, ratelimit::Decision};

/// The security state needed by the HTTP middleware, deliberately kept
/// separate from [`super::ServerState`]. Besides making the boundary explicit,
/// this lets the middleware be exercised through a real axum router without
/// constructing a Tauri runtime or a process manager.
#[derive(Clone)]
pub struct AuthState {
    token: Arc<RwLock<String>>,
    limiter: Arc<ratelimit::RateLimiter>,
}

impl AuthState {
    pub fn new(token: Arc<RwLock<String>>) -> Self {
        Self {
            token,
            limiter: ratelimit::global(),
        }
    }

    #[cfg(test)]
    pub(crate) fn isolated(token: Arc<RwLock<String>>) -> Self {
        Self {
            token,
            limiter: Arc::new(ratelimit::RateLimiter::new()),
        }
    }
}

/// Generate a cryptographically random 32-byte token, base64-url encoded.
pub fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Per-IP global rate limiter. Runs before auth so anonymous floods don't
/// amplify into token-guessing work. ConnectInfo is optional so the layer
/// degrades gracefully when peer addresses aren't available — safer than
/// the tower_governor 500s we replaced.
pub async fn rate_limit(
    State(state): State<AuthState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if let Some(ip) = effective_client_ip(connect_info, req.headers()) {
        match state.limiter.check(ip) {
            Decision::Allow => {}
            Decision::TooMany | Decision::Banned => {
                return Err(StatusCode::TOO_MANY_REQUESTS);
            }
        }
    }
    Ok(next.run(req).await)
}

/// Middleware: reject requests without a valid bearer token.
pub async fn require_token(
    State(state): State<AuthState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let peer_ip = effective_client_ip(connect_info, req.headers());
    // Reject early if this IP is in the auth-failure ban window. Use the
    // budget-free `is_banned` here: the outer `rate_limit` layer already
    // consumed this request's rate budget via `check`, so calling `check`
    // again would double-count and roughly halve the effective per-IP limit.
    if let Some(ip) = peer_ip {
        if state.limiter.is_banned(ip) {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
    }

    let provided = match extract_bearer(&req) {
        Some(v) => v,
        None => {
            if let Some(ip) = peer_ip {
                let _ = state.limiter.record_auth_failure(ip);
            }
            return Err(StatusCode::UNAUTHORIZED);
        }
    };
    let expected = state.token.read().await.clone();
    if expected.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    if !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        if let Some(ip) = peer_ip {
            let _ = state.limiter.record_auth_failure(ip);
        }
        return Err(StatusCode::UNAUTHORIZED);
    }
    if let Some(ip) = peer_ip {
        state.limiter.record_auth_success(ip);
    }
    Ok(next.run(req).await)
}

/// Resolve the rate-limit/auth-failure key at the trusted reverse-proxy
/// boundary. Quick tunnels connect to the loopback listener, so keying only on
/// the TCP peer would collapse every internet client into 127.0.0.1. Trust
/// Cloudflare's single-IP header only when the direct peer is loopback; a LAN
/// peer can never select another client's bucket by spoofing this header.
fn effective_client_ip(
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: &HeaderMap,
) -> Option<IpAddr> {
    let peer = connect_info?.0.ip();
    if !peer.is_loopback() {
        return Some(peer);
    }

    let mut forwarded = headers.get_all("cf-connecting-ip").iter();
    let Some(value) = forwarded.next() else {
        return Some(peer);
    };
    // Multiple values are ambiguous. Do not accept a comma-joined list or a
    // second header field: Cloudflare supplies exactly one address.
    if forwarded.next().is_some() {
        return Some(peer);
    }
    value
        .to_str()
        .ok()
        .and_then(|value| value.parse::<IpAddr>().ok())
        .or(Some(peer))
}

fn extract_bearer(req: &Request) -> Option<String> {
    // Preferred: Authorization: Bearer <token>
    if let Some(val) = req.headers().get(header::AUTHORIZATION) {
        let s = val.to_str().ok()?;
        if let Some(tok) = s.strip_prefix("Bearer ") {
            return Some(tok.to_string());
        }
    }
    // WebSocket subprotocol: Sec-WebSocket-Protocol: procman-token.<token>
    // Mobile browsers can't set custom headers on the WS handshake but can
    // pass a subprotocol via `new WebSocket(url, [subprotocol])`.
    if let Some(val) = req.headers().get("sec-websocket-protocol") {
        if let Ok(s) = val.to_str() {
            for proto in s.split(',') {
                let p = proto.trim();
                if let Some(tok) = p.strip_prefix("procman-token.") {
                    return Some(tok.to_string());
                }
            }
        }
    }
    None
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{middleware, routing::get, Router};
    use std::net::{Ipv4Addr, SocketAddr};
    use tower::ServiceExt;

    fn protected_router(state: AuthState) -> Router {
        Router::new()
            .route("/protected", get(|| async { StatusCode::NO_CONTENT }))
            .route_layer(middleware::from_fn_with_state(state.clone(), require_token))
            .layer(middleware::from_fn_with_state(state, rate_limit))
    }

    async fn request_status_from(
        router: &Router,
        bearer: Option<&str>,
        ws_protocol: Option<&str>,
        peer: SocketAddr,
        cf_connecting_ip: Option<&str>,
    ) -> StatusCode {
        let mut builder = Request::builder().uri("/protected");
        if let Some(token) = bearer {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(protocol) = ws_protocol {
            builder = builder.header("sec-websocket-protocol", protocol);
        }
        if let Some(ip) = cf_connecting_ip {
            builder = builder.header("cf-connecting-ip", ip);
        }
        let mut request = builder.body(axum::body::Body::empty()).unwrap();
        request.extensions_mut().insert(ConnectInfo(peer));
        router.clone().oneshot(request).await.unwrap().status()
    }

    async fn request_status(
        router: &Router,
        bearer: Option<&str>,
        ws_protocol: Option<&str>,
        ip_last_octet: u8,
    ) -> StatusCode {
        request_status_from(
            router,
            bearer,
            ws_protocol,
            SocketAddr::from((Ipv4Addr::new(10, 77, 0, ip_last_octet), 43210)),
            None,
        )
        .await
    }

    #[test]
    fn token_is_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        assert!(a.len() >= 40); // 32 bytes base64-url is ~43 chars
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq(b"hello", b"hello"));
        assert!(!constant_time_eq(b"hello", b"world"));
        assert!(!constant_time_eq(b"hello", b"hello!"));
    }

    #[test]
    fn extracts_authorization_bearer() {
        let req = Request::builder()
            .header(header::AUTHORIZATION, "Bearer abc123")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(extract_bearer(&req), Some("abc123".into()));
    }

    #[test]
    fn extracts_websocket_token_subprotocol() {
        let req = Request::builder()
            .header("sec-websocket-protocol", "procman, procman-token.abc123")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(extract_bearer(&req), Some("abc123".into()));
    }

    #[test]
    fn ignores_legacy_query_token() {
        let req = Request::builder()
            .uri("/api/stream?token=abc123")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(extract_bearer(&req), None);
    }

    #[tokio::test]
    async fn protected_route_enforces_bearer_and_websocket_auth() {
        let token = Arc::new(RwLock::new("correct-token".to_string()));
        let router = protected_router(AuthState::isolated(token));

        assert_eq!(
            request_status(&router, None, None, 1).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request_status(&router, Some("wrong-token"), None, 1).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request_status(&router, Some("correct-token"), None, 1).await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            request_status(
                &router,
                None,
                Some("procman, procman-token.correct-token"),
                1,
            )
            .await,
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn empty_server_token_fails_closed() {
        let token = Arc::new(RwLock::new(String::new()));
        let router = protected_router(AuthState::isolated(token));
        assert_eq!(
            request_status(&router, Some("anything"), None, 2).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn failed_auth_bans_the_peer_at_the_documented_threshold() {
        let token = Arc::new(RwLock::new("correct-token".to_string()));
        let router = protected_router(AuthState::isolated(token));

        for _ in 0..5 {
            assert_eq!(
                request_status(&router, Some("wrong-token"), None, 3).await,
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            request_status(&router, Some("correct-token"), None, 3).await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn request_budget_rejects_request_sixty_one() {
        let token = Arc::new(RwLock::new("correct-token".to_string()));
        let router = protected_router(AuthState::isolated(token));

        for _ in 0..60 {
            assert_eq!(
                request_status(&router, Some("correct-token"), None, 4).await,
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(
            request_status(&router, Some("correct-token"), None, 4).await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn shared_token_rotation_invalidates_old_requests_immediately() {
        let token = Arc::new(RwLock::new("old-token".to_string()));
        let router = protected_router(AuthState::isolated(Arc::clone(&token)));

        assert_eq!(
            request_status(&router, Some("old-token"), None, 5).await,
            StatusCode::NO_CONTENT
        );
        *token.write().await = "new-token".to_string();
        assert_eq!(
            request_status(&router, Some("old-token"), None, 5).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request_status(&router, Some("new-token"), None, 5).await,
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn loopback_proxy_header_separates_client_rate_budgets() {
        let token = Arc::new(RwLock::new("correct-token".to_string()));
        let router = protected_router(AuthState::isolated(token));
        let loopback = SocketAddr::from((Ipv4Addr::LOCALHOST, 43210));

        for _ in 0..60 {
            assert_eq!(
                request_status_from(
                    &router,
                    Some("correct-token"),
                    None,
                    loopback,
                    Some("203.0.113.10"),
                )
                .await,
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(
            request_status_from(
                &router,
                Some("correct-token"),
                None,
                loopback,
                Some("203.0.113.10"),
            )
            .await,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            request_status_from(
                &router,
                Some("correct-token"),
                None,
                loopback,
                Some("203.0.113.11"),
            )
            .await,
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn loopback_proxy_header_separates_auth_failure_bans() {
        let token = Arc::new(RwLock::new("correct-token".to_string()));
        let router = protected_router(AuthState::isolated(token));
        let loopback = SocketAddr::from((Ipv4Addr::LOCALHOST, 43211));

        for _ in 0..5 {
            assert_eq!(
                request_status_from(
                    &router,
                    Some("wrong-token"),
                    None,
                    loopback,
                    Some("198.51.100.20"),
                )
                .await,
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            request_status_from(
                &router,
                Some("correct-token"),
                None,
                loopback,
                Some("198.51.100.21"),
            )
            .await,
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn non_loopback_peer_cannot_spoof_proxy_identity() {
        let token = Arc::new(RwLock::new("correct-token".to_string()));
        let router = protected_router(AuthState::isolated(token));
        let lan_peer = SocketAddr::from((Ipv4Addr::new(10, 77, 0, 42), 43212));

        for suffix in 1..=5 {
            assert_eq!(
                request_status_from(
                    &router,
                    Some("wrong-token"),
                    None,
                    lan_peer,
                    Some(&format!("203.0.113.{suffix}")),
                )
                .await,
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            request_status_from(
                &router,
                Some("correct-token"),
                None,
                lan_peer,
                Some("203.0.113.200"),
            )
            .await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn invalid_proxy_header_falls_back_to_loopback_peer() {
        let token = Arc::new(RwLock::new("correct-token".to_string()));
        let router = protected_router(AuthState::isolated(token));
        let loopback = SocketAddr::from((Ipv4Addr::LOCALHOST, 43213));

        for _ in 0..5 {
            assert_eq!(
                request_status_from(
                    &router,
                    Some("wrong-token"),
                    None,
                    loopback,
                    Some("not-an-ip"),
                )
                .await,
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            request_status_from(&router, Some("correct-token"), None, loopback, None).await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }
}
