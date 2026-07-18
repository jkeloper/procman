// HTTP routes for remote control API.

use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::Serialize;
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;

use super::{auth, ws::ws_handler, ServerMode, ServerState};
use crate::types::PortInfo;

pub fn build_router(state: ServerState, mode: ServerMode) -> Router {
    let auth_state = auth::AuthState::new(state.token.clone());
    // SEC-08: CORS — allow known origins + any *.trycloudflare.com host.
    // Native mobile uses capacitor:// scheme; tunnel uses https://*.trycloudflare.com;
    // Browser/PWA LAN access is intentionally unsupported: LAN REST + WS use
    // the iOS native pinned transport, while browser clients use a public-TLS
    // Cloudflare tunnel. Substring matches are deliberately avoided here —
    // "trycloudflare.com.evil.example" would have passed the old check.
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
        .route("/api/groups/:id/run", post(run_group))
        .route("/api/projects", get(list_projects))
        .route("/api/ports", get(list_ports))
        .route(
            "/api/port-aliases",
            get(get_port_aliases).post(set_port_alias),
        )
        .route("/api/logs/:id", get(log_snapshot))
        .route("/api/logs/:id/search", get(search_log))
        .route("/api/ports/status", post(port_status_batch))
        .route("/api/ports/:script_id/status", get(port_status))
        .route("/api/ports/:script_id/conflicts", get(port_conflicts))
        .route("/api/ports/:script_id/list", get(ports_for_script))
        .route("/api/audit", get(audit_snapshot))
        .route("/api/stream", get(ws_handler))
        .route_layer(middleware::from_fn_with_state(
            auth_state.clone(),
            auth::require_token,
        ));

    // A stale service worker or an already-open copy of the former LAN PWA
    // must not bypass the new native-pinning boundary. Browsers attach Fetch
    // Metadata and/or Origin headers that native URLSession does not. Native
    // REST/WS also carries a versioned transport marker that old PWA bundles
    // never sent. Require both properties before an authenticated LAN endpoint
    // can run.
    let protected = if matches!(mode, ServerMode::Lan) {
        protected.route_layer(middleware::from_fn(require_native_lan_transport))
    } else {
        protected
    };

    let router = Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        // Rate limit runs on EVERY request (including /api/health + SPA). Placed
        // outermost (after `.layer()` stacking it's innermost-applied) so anonymous
        // floods can't exhaust the auth middleware.
        .layer(middleware::from_fn_with_state(auth_state, auth::rate_limit))
        .layer(cors)
        // SEC-10: Security headers
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ));

    let router = if matches!(mode, ServerMode::Lan) {
        // The LAN QR is consumed by the scanner inside the iOS app. If a phone
        // camera opens it in Safari, show a safe explanation rather than
        // booting a browser client that cannot inspect or pin TLS certificates.
        router.fallback(lan_native_client_required)
    } else {
        router.fallback(super::spa::spa_fallback)
    };

    router.with_state(state)
}

async fn require_native_lan_transport(req: Request, next: Next) -> Response {
    if request_has_browser_metadata(req.headers()) || !request_has_native_lan_marker(req.headers())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

fn request_has_browser_metadata(headers: &axum::http::HeaderMap) -> bool {
    headers.contains_key(header::ORIGIN)
        || headers.contains_key("sec-fetch-site")
        || headers.contains_key("sec-fetch-mode")
        || headers.contains_key("sec-fetch-dest")
}

fn request_has_native_lan_marker(headers: &axum::http::HeaderMap) -> bool {
    if headers
        .get("x-procman-transport")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == "ios-pinned-v1")
    {
        return true;
    }

    headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|protocols| {
            protocols
                .split(',')
                .any(|protocol| protocol.trim() == "procman-native-pinned-v1")
        })
}

async fn lan_native_client_required() -> impl IntoResponse {
    (
        StatusCode::FORBIDDEN,
        Html(
            r#"<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>procman iOS app required</title><script>if(location.hash)history.replaceState(null,"",location.pathname+location.search)</script><body style="font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1.25rem;line-height:1.55"><h1>Open the procman iOS app</h1><p>Direct LAN control requires certificate pinning and is available only through the QR scanner inside the procman iOS app.</p><p>For browser access, start a Cloudflare Tunnel from procman and open its HTTPS URL.</p></body></html>"#,
        ),
    )
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
                    "ports": s.ports,
                    "auto_restart": s.auto_restart,
                    "schedule": s.schedule,
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
                cfg.settings
                    .port_aliases
                    .insert(port, alias.trim().to_string());
            }
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn log_snapshot(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<Vec<crate::log_buffer::LogLine>> {
    let limit = params
        .get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(5000usize)
        .clamp(1, 5000);
    Json(state.pm.log_tail(&id, limit))
}

async fn audit_snapshot(State(state): State<ServerState>) -> Json<Vec<super::audit::AuditEntry>> {
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
        state
            .audit
            .record("start", &id, false, Some("not found".into()))
            .await;
        return Err(StatusCode::NOT_FOUND);
    };
    match crate::commands::port::blocking_conflicts_for_script(
        &script.id,
        &script.ports,
        state.app_state.as_ref(),
        &state.pm,
    )
    .await
    {
        Ok(conflicts) => {
            if let Some(conflict) = conflicts.first() {
                let message = crate::commands::port::describe_port_conflict(conflict);
                state.audit.record("start", &id, false, Some(message)).await;
                return Err(StatusCode::CONFLICT);
            }
        }
        Err(e) => {
            state.audit.record("start", &id, false, Some(e)).await;
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }
    match state.pm.spawn(&script, Some(cwd)).await {
        Ok(pid) => {
            state
                .audit
                .record("start", &id, true, Some(format!("pid {}", pid)))
                .await;
            Ok(Json(serde_json::json!({ "pid": pid })))
        }
        Err(e) => {
            state
                .audit
                .record("start", &id, false, Some(e.clone()))
                .await;
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn stop_process(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let timeout_ms = shutdown_timeout_ms(&state).await;
    let res = state.pm.kill_with_timeout(&id, timeout_ms).await;
    // WS5: remote stop is a user-explicit stop — drop it from the
    // session-restore set (kill() leaves last_running untouched on purpose).
    state.pm.runtime_store().mark_running(&id, false).await;
    match res {
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
        state
            .audit
            .record("restart", &id, false, Some("not found".into()))
            .await;
        return Err(StatusCode::NOT_FOUND);
    };
    match crate::commands::port::blocking_conflicts_for_script(
        &script.id,
        &script.ports,
        state.app_state.as_ref(),
        &state.pm,
    )
    .await
    {
        Ok(conflicts) => {
            if let Some(conflict) = conflicts.first() {
                let message = crate::commands::port::describe_port_conflict(conflict);
                state
                    .audit
                    .record("restart", &id, false, Some(message))
                    .await;
                return Err(StatusCode::CONFLICT);
            }
        }
        Err(e) => {
            state.audit.record("restart", &id, false, Some(e)).await;
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }
    let timeout_ms = shutdown_timeout_ms(&state).await;
    match state
        .pm
        .restart_with_timeout(&script, Some(cwd), timeout_ms)
        .await
    {
        Ok(pid) => {
            state
                .audit
                .record("restart", &id, true, Some(format!("pid {}", pid)))
                .await;
            Ok(Json(serde_json::json!({ "pid": pid })))
        }
        Err(e) => {
            state.audit.record("restart", &id, false, Some(e)).await;
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// WS8: remote group batch-run. Delegates to the exact same
/// `commands::group::run_group_core` the desktop uses, so ordering,
/// depends_on readiness gating, port-conflict blocking and partial-success
/// reporting are identical across desktop and phone. The whole-group outcome
/// is audited (`run_group`), and each launch additionally lands a per-member
/// `start` audit entry mirroring the single-process route so the audit log
/// reads the same whether a script was started solo or via a group.
async fn run_group(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<crate::commands::group::GroupRunResult>>, StatusCode> {
    match crate::commands::group::run_group_core(&id, state.app_state.as_ref(), &state.pm).await {
        Ok(results) => {
            for r in &results {
                let detail = match (r.ok, &r.error, r.pid) {
                    (true, _, Some(pid)) => Some(format!("pid {}", pid)),
                    (false, Some(e), _) => Some(e.clone()),
                    _ => None,
                };
                state
                    .audit
                    .record("start", &r.script_id, r.ok, detail)
                    .await;
            }
            let started = results.iter().filter(|r| r.ok).count();
            state
                .audit
                .record(
                    "run_group",
                    &id,
                    results.iter().all(|r| r.ok),
                    Some(format!("{}/{} started", started, results.len())),
                )
                .await;
            Ok(Json(results))
        }
        Err(e) => {
            // Group lookup failure (unknown id) — nothing was launched.
            state.audit.record("run_group", &id, false, Some(e)).await;
            Err(StatusCode::NOT_FOUND)
        }
    }
}

async fn shutdown_timeout_ms(state: &ServerState) -> u64 {
    let guard = state.app_state.config.lock().await;
    crate::types::clamp_shutdown_timeout_ms(guard.settings.shutdown_timeout_ms)
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
    // WS3: read path → cached ownership snapshot.
    let ownership = crate::commands::port::build_port_ownership_cache_cached(
        state.app_state.as_ref(),
        &state.pm,
        &listening,
    )
    .await;
    let statuses = crate::commands::port::declared_status_with_probe(
        &script_id,
        &script.ports,
        &listening,
        &ownership,
    )
    .await;
    Ok(Json(statuses))
}

/// WS3: batch port status. Body: `{"script_ids": ["a","b",...]}`. Builds the
/// listening snapshot + ownership view once and classifies every requested
/// script against it, mirroring the desktop `port_status_all` command so the
/// mobile client pays one round trip and the server pays one `ps`/`lsof`
/// build for the whole dashboard poll.
async fn port_status_batch(
    State(state): State<ServerState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Vec<(String, Vec<crate::commands::port::DeclaredPortStatus>)>>, StatusCode> {
    let script_ids: Vec<String> = body
        .get("script_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if script_ids.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let specs_by_id = lookup_scripts_from_state(&state, &script_ids).await;

    let listening = crate::commands::port::list_ports()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let ownership = crate::commands::port::build_port_ownership_cache_cached(
        state.app_state.as_ref(),
        &state.pm,
        &listening,
    )
    .await;

    let mut out: Vec<(String, Vec<crate::commands::port::DeclaredPortStatus>)> =
        Vec::with_capacity(script_ids.len());
    for id in &script_ids {
        let statuses = match specs_by_id.get(id) {
            Some(specs) if !specs.is_empty() => {
                crate::commands::port::declared_status_with_probe(id, specs, &listening, &ownership)
                    .await
            }
            _ => Vec::new(),
        };
        out.push((id.clone(), statuses));
    }
    Ok(Json(out))
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
    let ownership = crate::commands::port::build_port_ownership_cache(
        state.app_state.as_ref(),
        &state.pm,
        &listening,
    )
    .await;
    Ok(Json(crate::commands::port::build_conflicts_with_ownership(
        &script_id,
        &script.ports,
        &listening,
        &ownership,
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
    // WS3: read path → cached ownership snapshot.
    let ownership = crate::commands::port::build_port_ownership_cache_cached(
        state.app_state.as_ref(),
        &state.pm,
        &all,
    )
    .await;
    Ok(Json(
        crate::commands::port::list_ports_for_script_from_snapshot(
            &script_id,
            &script.ports,
            &all,
            &ownership,
        ),
    ))
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

/// WS3: resolve many script_ids → their declared PortSpecs in one config
/// lock acquisition (used by the batch status route).
async fn lookup_scripts_from_state(
    state: &ServerState,
    script_ids: &[String],
) -> std::collections::HashMap<String, Vec<crate::types::PortSpec>> {
    let wanted: std::collections::HashSet<&str> = script_ids.iter().map(|s| s.as_str()).collect();
    let guard = state.app_state.config.lock().await;
    let mut out = std::collections::HashMap::new();
    for proj in &guard.projects {
        for s in &proj.scripts {
            if wanted.contains(s.id.as_str()) {
                out.insert(s.id.clone(), s.ports.clone());
            }
        }
    }
    out
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
    }

    #[test]
    fn cors_rejects_substring_spoof() {
        // The old .contains("trycloudflare.com") implementation accepted these.
        assert!(!origin_is_allowed(
            "http://attacker-trycloudflare.com.evil.com"
        ));
        assert!(!origin_is_allowed("https://evil.com/trycloudflare.com"));
        assert!(!origin_is_allowed("http://trycloudflare.com.evil.co"));
    }

    #[test]
    fn cors_rejects_public_ips_and_random_hosts() {
        assert!(!origin_is_allowed("http://8.8.8.8"));
        assert!(!origin_is_allowed("https://example.com"));
        assert!(!origin_is_allowed("https://192.168.1.5:7777"));
        assert!(!origin_is_allowed("http://10.0.0.2"));
        assert!(!origin_is_allowed("http://172.16.0.1"));
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
        assert_eq!(parse_origin("http://[::1]:8080/x"), Some(("http", "[::1]")));
    }

    #[tokio::test]
    async fn lan_transport_rejects_browser_metadata_but_accepts_native_requests() {
        use axum::{body::Body, routing::get, Router};
        use tower::ServiceExt;

        let app = Router::new()
            .route("/protected", get(|| async { StatusCode::NO_CONTENT }))
            .route_layer(middleware::from_fn(require_native_lan_transport));

        let missing_marker = Request::builder()
            .uri("/protected")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(missing_marker).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );

        for (name, value) in [
            ("x-procman-transport", "ios-pinned-v1"),
            (
                "sec-websocket-protocol",
                "procman, procman-native-pinned-v1, procman-token.test",
            ),
        ] {
            let native = Request::builder()
                .uri("/protected")
                .header(name, value)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(native).await.unwrap().status(),
                StatusCode::NO_CONTENT,
                "native LAN marker {name} must be accepted"
            );
        }

        for (name, value) in [
            ("origin", "https://192.168.1.20:7777"),
            ("sec-fetch-site", "same-origin"),
            ("sec-fetch-mode", "cors"),
            ("sec-fetch-dest", "empty"),
        ] {
            let browser = Request::builder()
                .uri("/protected")
                .header("x-procman-transport", "ios-pinned-v1")
                .header(name, value)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(browser).await.unwrap().status(),
                StatusCode::FORBIDDEN,
                "browser metadata header {name} must be rejected"
            );
        }
    }

    #[tokio::test]
    async fn lan_browser_fallback_strips_pairing_secret_fragment() {
        let response = lan_native_client_required().await.into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = axum::body::to_bytes(response.into_body(), 16 * 1024)
            .await
            .unwrap();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains("history.replaceState"));
        assert!(html.contains("location.pathname+location.search"));
        assert!(!html.contains("token="));
        assert!(html.contains("Open the procman iOS app"));
    }
}
