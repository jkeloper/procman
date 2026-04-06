// HTTP routes for remote control API.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::Serialize;
use tower_http::cors::{Any, CorsLayer};

use super::{auth, ws::ws_handler, ServerState};
use crate::types::PortInfo;

pub fn build_router(state: ServerState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_headers(Any)
        .allow_methods(Any);

    let protected = Router::new()
        .route("/api/ping", get(ping))
        .route("/api/processes", get(list_processes))
        .route("/api/processes/:id/start", post(start_process))
        .route("/api/processes/:id/stop", post(stop_process))
        .route("/api/processes/:id/restart", post(restart_process))
        .route("/api/projects", get(list_projects))
        .route("/api/ports", get(list_ports))
        .route("/api/logs/:id", get(log_snapshot))
        .route("/api/audit", get(audit_snapshot))
        .route("/api/stream", get(ws_handler))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ));

    Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        // PWA static files (everything not matched above falls to SPA)
        .fallback(super::spa::spa_fallback)
        .layer(cors)
        .with_state(state)
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

async fn list_projects(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let guard = state.app_state.config.lock().await;
    Json(serde_json::to_value(&*guard).unwrap_or(serde_json::Value::Null))
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
