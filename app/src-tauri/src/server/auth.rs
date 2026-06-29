// Token-based authentication for remote API.
//
// Single pre-shared bearer token, checked via constant-time comparison.
// Token is generated on first server start and persisted; rotation wipes it.
//
// Requests also pass through a per-IP rate limiter (see ratelimit.rs). Auth
// failures feed a 401-circuit-breaker so brute force token guessing hits a
// short ban quickly. The limiter lives as a process-wide singleton (see
// ratelimit::global) so the middleware stack doesn't need the `rate` handle
// plumbed into ServerState — ServerState is constructed by commands/
// which is out-of-scope for this module.

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use base64::{engine::general_purpose, Engine as _};
use rand::RngCore;
use std::net::{IpAddr, SocketAddr};

use super::{ratelimit, ratelimit::Decision, ServerState};

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
    connect_info: Option<ConnectInfo<SocketAddr>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if let Some(ConnectInfo(peer)) = connect_info {
        match ratelimit::global().check(peer.ip()) {
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
    State(state): State<ServerState>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let peer_ip: Option<IpAddr> = connect_info.map(|ConnectInfo(s)| s.ip());
    // Reject early if this IP is in the auth-failure ban window. Use the
    // budget-free `is_banned` here: the outer `rate_limit` layer already
    // consumed this request's rate budget via `check`, so calling `check`
    // again would double-count and roughly halve the effective per-IP limit.
    if let Some(ip) = peer_ip {
        if ratelimit::global().is_banned(ip) {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
    }

    let provided = match extract_bearer(&req) {
        Some(v) => v,
        None => {
            if let Some(ip) = peer_ip {
                let _ = ratelimit::global().record_auth_failure(ip);
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
            let _ = ratelimit::global().record_auth_failure(ip);
        }
        return Err(StatusCode::UNAUTHORIZED);
    }
    if let Some(ip) = peer_ip {
        ratelimit::global().record_auth_success(ip);
    }
    Ok(next.run(req).await)
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
}
