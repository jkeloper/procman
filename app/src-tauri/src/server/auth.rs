// Token-based authentication for remote API.
//
// Single pre-shared bearer token, checked via constant-time comparison.
// Token is generated on first server start and persisted; rotation wipes it.

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use base64::{engine::general_purpose, Engine as _};
use rand::RngCore;

use super::ServerState;

/// Generate a cryptographically random 32-byte token, base64-url encoded.
pub fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Middleware: reject requests without a valid bearer token.
pub async fn require_token(
    State(state): State<ServerState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let Some(provided) = extract_bearer(&req) else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let expected = state.token.read().await.clone();
    if expected.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    if !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

fn extract_bearer(req: &Request) -> Option<String> {
    // Prefer Authorization: Bearer <token>; fall back to ?token=<> query for WS.
    if let Some(val) = req.headers().get(header::AUTHORIZATION) {
        let s = val.to_str().ok()?;
        if let Some(tok) = s.strip_prefix("Bearer ") {
            return Some(tok.to_string());
        }
    }
    // Query string (WebSocket can't set custom headers easily from browsers)
    let uri = req.uri();
    let query = uri.query()?;
    for pair in query.split('&') {
        if let Some(v) = pair.strip_prefix("token=") {
            return Some(urlencoding_decode(v));
        }
    }
    None
}

fn urlencoding_decode(s: &str) -> String {
    // Minimal percent-decoding for token strings (base64url has no reserved chars)
    s.replace("%2B", "+").replace("%2F", "/").replace("%3D", "=")
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
}
