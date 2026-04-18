// HTTP routes for remote control API.

use axum::{
    extract::{Path, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;

use super::{auth, ws::ws_handler, ServerState};
use crate::types::PortInfo;

pub fn build_router(state: ServerState) -> Router {
    // SEC-08: CORS — allow known origins + any *.trycloudflare.com host.
    // Native mobile uses capacitor:// scheme; tunnel uses https://*.trycloudflare.com;
    // LAN dev uses http://<private-ip>:port. Substring matches are deliberately
    // avoided here — "trycloudflare.com.evil.example" would have passed the
    // previous implementation.
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::predicate(
            |origin: &HeaderValue, _req: &axum::http::request::Parts| {
                let s = origin.to_str().unwrap_or("");
                origin_is_allowed(s)
            },
        ))
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS]);

    let protected = Router::new()
        .route("/api/ping", get(ping))
        .route("/api/processes", get(list_processes))
        .route("/api/processes/:id/start", post(start_process))
        .route("/api/processes/:id/stop", post(stop_process))
        .route("/api/processes/:id/restart", post(restart_process))
        .route("/api/projects", get(list_projects))
        .route("/api/ports", get(list_ports))
        .route("/api/port-aliases", get(get_port_aliases).post(set_port_alias))
        .route("/api/logs/:id", get(log_snapshot))
        .route("/api/logs/:id/search", get(search_log))
        .route("/api/ports/:script_id/status", get(port_status))
        .route("/api/ports/:script_id/conflicts", get(port_conflicts))
        .route("/api/ports/:script_id/list", get(ports_for_script))
        .route("/api/audit", get(audit_snapshot))
        .route("/api/stream", get(ws_handler))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ));

    Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .fallback(super::spa::spa_fallback)
        // Rate limit runs on EVERY request (including /api/health + SPA). Placed
        // outermost (after `.layer()` stacking it's innermost-applied) so anonymous
        // floods can't exhaust the auth middleware.
        .layer(middleware::from_fn(auth::rate_limit))
        .layer(cors)
        // SEC-10: Security headers
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .with_state(state)
}

/// Returns true if the given Origin header value is allowed by CORS policy.
/// Exposed for unit testing.
pub(crate) fn origin_is_allowed(origin: &str) -> bool {
    if origin.is_empty() {
        return false;
    }
    // Native app via Capacitor. Accept the whole capacitor:// scheme.
    if let Some(rest) = origin.strip_prefix("capacitor://") {
        return !rest.is_empty();
    }
    // Parse the rest as a URL-ish triple: scheme://host[:port]
    let Some((scheme, host)) = parse_origin(origin) else {
        return false;
    };
    match scheme {
        "http" | "https" => {}
        _ => return false,
    }
    // localhost / 127.0.0.1 on any port
    if host == "localhost" || host == "127.0.0.1" || host == "[::1]" {
        return true;
    }
    // *.trycloudflare.com (exact subdomain match, NOT substring)
    if host == "trycloudflare.com" || host.ends_with(".trycloudflare.com") {
        return true;
    }
    // RFC1918 / link-local IPs
    if let Some(ip) = parse_host_ip(host) {
        return is_private_ip(ip);
    }
    false
}

/// Parse "scheme://host[:port][/...]" into (scheme, host-without-port).
/// Brackets around IPv6 hosts are preserved.
fn parse_origin(s: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = s.split_once("://")?;
    // host[:port]/path — we only want the authority
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    // strip port if present; be careful with IPv6 "[::1]:8080"
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        // IPv6 literal
        let end = stripped.find(']')?;
        &authority[..end + 2] // include "[...]"
    } else if let Some((h, _port)) = authority.rsplit_once(':') {
        // plain host:port
        h
    } else {
        authority
    };
    Some((scheme, host))
}

fn parse_host_ip(host: &str) -> Option<IpAddr> {
    // Strip IPv6 brackets if present.
    let h = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    h.parse::<IpAddr>().ok()
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => is_private_v6(v6),
    }
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private() // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local() // 169.254/16
}

fn is_private_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    let segs = ip.segments();
    // fc00::/7 unique-local
    if (segs[0] & 0xfe00) == 0xfc00 {
        return true;
    }
    // fe80::/10 link-local
    if (segs[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    false
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    name: &'static str,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        ok: true,
        name: "procman",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn ping() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "pong": true, "ts_ms": now_ms() }))
}

async fn list_processes(
    State(state): State<ServerState>,
) -> Json<Vec<crate::process::ProcessSnapshot>> {
    Json(state.pm.list())
}

/// SEC-14: Return only the fields needed by remote clients (no settings, limited paths).
async fn list_projects(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let guard = state.app_state.config.lock().await;
    let projects: Vec<serde_json::Value> = guard
        .projects
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "scripts": p.scripts.iter().map(|s| serde_json::json!({
                    "id": s.id,
                    "name": s.name,
                    "command": s.command,
                    "expected_port": s.expected_port,
                    "ports": s.ports,
                    "auto_restart": s.auto_restart,
                    "depends_on": s.depends_on,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Json(serde_json::json!({
        "version": guard.version,
        "projects": projects,
        "groups": guard.groups,
    }))
}

async fn list_ports() -> Result<Json<Vec<PortInfo>>, StatusCode> {
    // Reuse the same lsof-based detection
    use std::process::Command;
    let output = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcnT"])
        .output()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(Json(crate::commands::port::parse_lsof_for_api(&text)))
}

async fn get_port_aliases(
    State(state): State<ServerState>,
) -> Json<std::collections::HashMap<u16, String>> {
    let guard = state.app_state.config.lock().await;
    Json(guard.settings.port_aliases.clone())
}

async fn set_port_alias(
    State(state): State<ServerState>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, StatusCode> {
    let port = body["port"].as_u64().ok_or(StatusCode::BAD_REQUEST)? as u16;
    let alias = body["alias"].as_str().unwrap_or("").to_string();
    state
        .app_state
        .mutate(|cfg| {
            if alias.trim().is_empty() {
                cfg.settings.port_aliases.remove(&port);
            } else {
                cfg.settings.port_aliases.insert(port, alias.trim().to_string());
            }
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn log_snapshot(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Json<Vec<crate::log_buffer::LogLine>> {
    Json(state.pm.log_snapshot(&id))
}

async fn audit_snapshot(
    State(state): State<ServerState>,
) -> Json<Vec<super::audit::AuditEntry>> {
    Json(state.audit.snapshot().await)
}

async fn find_script(
    state: &ServerState,
    script_id: &str,
) -> Option<(crate::types::Script, String)> {
    let guard = state.app_state.config.lock().await;
    for proj in &guard.projects {
        if let Some(s) = proj.scripts.iter().find(|s| s.id == script_id) {
            return Some((s.clone(), proj.path.clone()));
        }
    }
    None
}

async fn start_process(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let Some((script, cwd)) = find_script(&state, &id).await else {
        state.audit.record("start", &id, false, Some("not found".into())).await;
        return Err(StatusCode::NOT_FOUND);
    };
    match state.pm.spawn(&script, Some(cwd)).await {
        Ok(pid) => {
            state.audit.record("start", &id, true, Some(format!("pid {}", pid))).await;
            Ok(Json(serde_json::json!({ "pid": pid })))
        }
        Err(e) => {
            state.audit.record("start", &id, false, Some(e.clone())).await;
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn stop_process(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    match state.pm.kill(&id).await {
        Ok(_) => {
            state.audit.record("stop", &id, true, None).await;
            Ok(StatusCode::NO_CONTENT)
        }
        Err(e) => {
            state.audit.record("stop", &id, false, Some(e)).await;
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn restart_process(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let Some((script, cwd)) = find_script(&state, &id).await else {
        state.audit.record("restart", &id, false, Some("not found".into())).await;
        return Err(StatusCode::NOT_FOUND);
    };
    match state.pm.restart(&script, Some(cwd)).await {
        Ok(pid) => {
            state.audit.record("restart", &id, true, Some(format!("pid {}", pid))).await;
            Ok(Json(serde_json::json!({ "pid": pid })))
        }
        Err(e) => {
            state.audit.record("restart", &id, false, Some(e)).await;
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

// --- S1-S5: new API handlers for remote clients ---

async fn search_log(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<Vec<crate::log_buffer::LogLine>> {
    let query = params.get("q").cloned().unwrap_or_default();
    let case_sensitive = params.get("cs").map(|v| v == "1").unwrap_or(false);
    let limit = params
        .get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(500usize);
    Json(state.pm.log_search(&id, &query, case_sensitive, limit))
}

async fn port_status(
    State(state): State<ServerState>,
    Path(script_id): Path<String>,
) -> Result<Json<Vec<crate::commands::port::DeclaredPortStatus>>, StatusCode> {
    let script = lookup_script_from_state(&state, &script_id)
        .await
        .ok_or(StatusCode::NOT_FOUND)?;
    if script.ports.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let listening = crate::commands::port::list_ports()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let managed_pids: std::collections::HashSet<u32> = if let Some(snap) = state
        .pm
        .list()
        .into_iter()
        .find(|s| s.id == script_id)
    {
        crate::commands::port::list_ports_for_script_pid(snap.pid)
            .await
            .map(|v| v.into_iter().map(|p| p.pid).collect())
            .unwrap_or_default()
    } else {
        std::collections::HashSet::new()
    };
    let mut statuses =
        crate::commands::port::build_declared_status(&script.ports, &listening, &managed_pids);
    // TCP probe each port
    let probes: Vec<_> = statuses
        .iter()
        .map(|st| {
            let bind = st.spec.bind.clone();
            let port = st.spec.number;
            tokio::spawn(async move { crate::commands::port::tcp_probe(&bind, port, 400).await })
        })
        .collect();
    for (i, handle) in probes.into_iter().enumerate() {
        statuses[i].reachable = handle.await.ok();
    }
    Ok(Json(statuses))
}

async fn port_conflicts(
    State(state): State<ServerState>,
    Path(script_id): Path<String>,
) -> Result<Json<Vec<crate::commands::port::PortConflict>>, StatusCode> {
    let script = lookup_script_from_state(&state, &script_id)
        .await
        .ok_or(StatusCode::NOT_FOUND)?;
    if script.ports.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let listening = crate::commands::port::list_ports()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(crate::commands::port::build_conflicts(
        &script.ports,
        &listening,
    )))
}

async fn ports_for_script(
    State(state): State<ServerState>,
    Path(script_id): Path<String>,
) -> Result<Json<Vec<PortInfo>>, StatusCode> {
    let script = lookup_script_from_state(&state, &script_id)
        .await
        .ok_or(StatusCode::NOT_FOUND)?;
    let all = crate::commands::port::list_ports()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let by_port: std::collections::HashMap<u16, PortInfo> =
        all.iter().map(|p| (p.port, p.clone())).collect();
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<PortInfo> = Vec::new();
    for spec in &script.ports {
        if let Some(info) = by_port.get(&spec.number) {
            if seen.insert(spec.number) {
                out.push(info.clone());
            }
        }
    }
    if let Some(snap) = state.pm.list().into_iter().find(|s| s.id == script_id) {
        if let Ok(v) = crate::commands::port::list_ports_for_script_pid(snap.pid).await {
            for info in v {
                if seen.insert(info.port) {
                    out.push(info);
                }
            }
        }
    }
    Ok(Json(out))
}

async fn lookup_script_from_state(
    state: &ServerState,
    script_id: &str,
) -> Option<crate::types::Script> {
    let guard = state.app_state.config.lock().await;
    for proj in &guard.projects {
        for s in &proj.scripts {
            if s.id == script_id {
                return Some(s.clone());
            }
        }
    }
    None
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cors_allows_known_origins() {
        assert!(origin_is_allowed("http://localhost:5173"));
        assert!(origin_is_allowed("http://127.0.0.1:1420"));
        assert!(origin_is_allowed("capacitor://localhost"));
        assert!(origin_is_allowed("https://alpha.trycloudflare.com"));
        assert!(origin_is_allowed("https://trycloudflare.com"));
        assert!(origin_is_allowed("http://192.168.1.5:8080"));
        assert!(origin_is_allowed("http://10.0.0.2"));
        assert!(origin_is_allowed("http://172.16.0.1"));
    }

    #[test]
    fn cors_rejects_substring_spoof() {
        // The old .contains("trycloudflare.com") implementation accepted these.
        assert!(!origin_is_allowed("http://attacker-trycloudflare.com.evil.com"));
        assert!(!origin_is_allowed("https://evil.com/trycloudflare.com"));
        assert!(!origin_is_allowed("http://trycloudflare.com.evil.co"));
    }

    #[test]
    fn cors_rejects_public_ips_and_random_hosts() {
        assert!(!origin_is_allowed("http://8.8.8.8"));
        assert!(!origin_is_allowed("https://example.com"));
        assert!(!origin_is_allowed(""));
        assert!(!origin_is_allowed("not-a-url"));
        // Invalid schemes
        assert!(!origin_is_allowed("ftp://localhost:21"));
        assert!(!origin_is_allowed("file:///etc/passwd"));
    }

    #[test]
    fn cors_handles_ipv6() {
        assert!(origin_is_allowed("http://[::1]:8080"));
        assert!(!origin_is_allowed("http://[2001:db8::1]"));
    }

    #[test]
    fn parse_origin_handles_ports_and_paths() {
        assert_eq!(
            parse_origin("http://localhost:3000"),
            Some(("http", "localhost"))
        );
        assert_eq!(
            parse_origin("https://foo.trycloudflare.com/path"),
            Some(("https", "foo.trycloudflare.com"))
        );
        assert_eq!(
            parse_origin("http://[::1]:8080/x"),
            Some(("http", "[::1]"))
        );
    }

    #[test]
    fn private_ip_classifier() {
        assert!(is_private_ip("127.0.0.1".parse().unwrap()));
        assert!(is_private_ip("10.0.0.1".parse().unwrap()));
        assert!(is_private_ip("172.16.5.5".parse().unwrap()));
        assert!(is_private_ip("192.168.1.1".parse().unwrap()));
        assert!(is_private_ip("169.254.1.1".parse().unwrap()));
        assert!(!is_private_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("172.32.0.1".parse().unwrap())); // just outside 172.16/12
    }
}
