// Worker J: Docker Compose native integration.
//
// Thin wrappers around `docker compose up/down/ps` keyed by registered
// `ComposeProject` entries in config.yaml. No daemon supervision, no log
// streaming — this surface is deliberately minimal so compose stacks live
// alongside procman-managed processes without colliding with `ProcessManager`.
//
// Design notes:
//   - Every shell invocation uses `tokio::process::Command` (no new deps).
//   - All commands time out after `COMPOSE_TIMEOUT_SECS` to avoid hanging
//     the UI when docker daemon is unresponsive.
//   - `docker compose ps --format json` output differs across versions:
//     recent (v2.x) returns newline-delimited JSON objects; older clients
//     return a single JSON array. `parse_compose_ps` handles both.

use crate::state::AppState;
use crate::types::{ComposeProject, ComposeService};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use uuid::Uuid;

const COMPOSE_TIMEOUT_SECS: u64 = 15;

fn build_compose_args<'a>(path: &'a str, project_name: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec!["compose", "-f", path];
    if let Some(name) = project_name {
        if !name.is_empty() {
            args.push("-p");
            args.push(name);
        }
    }
    args
}

async fn run_docker(args: Vec<&str>) -> Result<std::process::Output, String> {
    let exec = Command::new("docker").args(&args).output();
    match tokio::time::timeout(Duration::from_secs(COMPOSE_TIMEOUT_SECS), exec).await {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(format!("docker spawn failed: {}", e)),
        Err(_) => Err(format!(
            "docker timed out after {}s",
            COMPOSE_TIMEOUT_SECS
        )),
    }
}

fn lookup(state: &AppConfigSnapshot, id: &str) -> Result<ComposeProject, String> {
    state
        .compose_projects
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| format!("compose project not found: {}", id))
}

// Tiny helper struct to avoid leaking the full AppState mutex beyond each call.
struct AppConfigSnapshot {
    compose_projects: Vec<ComposeProject>,
}

async fn snapshot(state: &AppState) -> AppConfigSnapshot {
    let cfg = state.config.lock().await;
    AppConfigSnapshot {
        compose_projects: cfg.compose_projects.clone(),
    }
}

#[tauri::command]
pub async fn compose_installed() -> Result<bool, String> {
    // `docker --version` is fast and doesn't require daemon connectivity.
    let out = Command::new("docker").arg("--version").output().await;
    Ok(out.map(|o| o.status.success()).unwrap_or(false))
}

#[tauri::command]
pub async fn compose_projects_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ComposeProject>, String> {
    let guard = state.config.lock().await;
    Ok(guard.compose_projects.clone())
}

#[tauri::command]
pub async fn compose_add_project(
    name: String,
    compose_path: String,
    project_name: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ComposeProject, String> {
    if name.trim().is_empty() {
        return Err("name cannot be empty".into());
    }
    let p = Path::new(&compose_path);
    if !p.exists() || !p.is_file() {
        return Err(format!(
            "compose file does not exist: {}",
            compose_path
        ));
    }
    // Normalize to absolute path so later `docker compose -f` works from anywhere.
    let canon = p
        .canonicalize()
        .map(|pb| pb.to_string_lossy().into_owned())
        .unwrap_or_else(|_| compose_path.clone());

    // Dedup: same compose file can't be registered twice.
    {
        let guard = state.config.lock().await;
        if guard
            .compose_projects
            .iter()
            .any(|cp| cp.compose_path == canon)
        {
            return Err(format!("already registered: {}", canon));
        }
    }

    let cp = ComposeProject {
        id: Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        compose_path: canon,
        project_name: project_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    };
    let to_return = cp.clone();
    state
        .mutate(|cfg| cfg.compose_projects.push(cp))
        .await
        .map_err(|e| e.to_string())?;
    Ok(to_return)
}

#[tauri::command]
pub async fn compose_remove_project(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .mutate(|cfg| cfg.compose_projects.retain(|cp| cp.id != id))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn compose_up(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let snap = snapshot(state.inner().as_ref()).await;
    let cp = lookup(&snap, &id)?;
    let args = {
        let mut a = build_compose_args(&cp.compose_path, cp.project_name.as_deref());
        a.push("up");
        a.push("-d");
        a
    };
    let out = run_docker(args).await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("docker compose up failed (exit {:?})", out.status.code())
        } else {
            stderr
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn compose_down(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let snap = snapshot(state.inner().as_ref()).await;
    let cp = lookup(&snap, &id)?;
    let args = {
        let mut a = build_compose_args(&cp.compose_path, cp.project_name.as_deref());
        a.push("down");
        a
    };
    let out = run_docker(args).await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("docker compose down failed (exit {:?})", out.status.code())
        } else {
            stderr
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn compose_ps(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ComposeService>, String> {
    let snap = snapshot(state.inner().as_ref()).await;
    let cp = lookup(&snap, &id)?;
    let args = {
        let mut a = build_compose_args(&cp.compose_path, cp.project_name.as_deref());
        a.push("ps");
        a.push("--format");
        a.push("json");
        a
    };
    let out = match run_docker(args).await {
        Ok(o) => o,
        // Timeouts / spawn errors: return empty rather than fail the UI.
        Err(_) => return Ok(Vec::new()),
    };
    if !out.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(parse_compose_ps(&stdout))
}

/// Parse `docker compose ps --format json` output across the two common
/// shapes:
///
/// 1. Compose v2.x: newline-delimited JSON, one object per line.
/// 2. Older clients: a single JSON array.
///
/// Unknown/empty lines are ignored. Returns an empty Vec on any parse error.
fn parse_compose_ps(text: &str) -> Vec<ComposeService> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    // Shape 2: JSON array.
    if trimmed.starts_with('[') {
        let parsed: serde_json::Value =
            serde_json::from_str(trimmed).unwrap_or(serde_json::Value::Null);
        if let Some(arr) = parsed.as_array() {
            return arr.iter().filter_map(parse_one_service).collect();
        }
        return Vec::new();
    }

    // Shape 1: NDJSON — one object per line, tolerate blank lines.
    let mut out = Vec::new();
    for line in trimmed.lines() {
        let l = line.trim();
        if l.is_empty() || !l.starts_with('{') {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(l) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(svc) = parse_one_service(&v) {
            out.push(svc);
        }
    }
    out
}

fn parse_one_service(v: &serde_json::Value) -> Option<ComposeService> {
    // Field names vary by version:
    //   recent: "Service", "Image", "State", "Publishers"[{URL,TargetPort,PublishedPort,Protocol}]
    //   older:  "service", "image", "state", "ports" (string)
    let service = v
        .get("Service")
        .or_else(|| v.get("service"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if service.is_empty() {
        return None;
    }
    let image = v
        .get("Image")
        .or_else(|| v.get("image"))
        .and_then(|x| x.as_str())
        .map(String::from);
    let state = v
        .get("State")
        .or_else(|| v.get("state"))
        .and_then(|x| x.as_str())
        .unwrap_or("unknown")
        .to_string();

    let ports = if let Some(arr) = v.get("Publishers").and_then(|x| x.as_array()) {
        arr.iter()
            .filter_map(|p| {
                let url = p.get("URL").and_then(|x| x.as_str()).unwrap_or("");
                let pub_port = p.get("PublishedPort").and_then(|x| x.as_u64()).unwrap_or(0);
                let tgt_port = p.get("TargetPort").and_then(|x| x.as_u64()).unwrap_or(0);
                let proto = p.get("Protocol").and_then(|x| x.as_str()).unwrap_or("tcp");
                // Skip entries with zero published port (not exposed on host).
                if pub_port == 0 && tgt_port == 0 {
                    return None;
                }
                Some(if url.is_empty() {
                    format!("{}->{}/{}", pub_port, tgt_port, proto)
                } else {
                    format!("{}:{}->{}/{}", url, pub_port, tgt_port, proto)
                })
            })
            .collect()
    } else if let Some(s) = v.get("ports").and_then(|x| x.as_str()) {
        if s.is_empty() {
            Vec::new()
        } else {
            s.split(',').map(|p| p.trim().to_string()).collect()
        }
    } else {
        Vec::new()
    };

    Some(ComposeService {
        service,
        image,
        state,
        ports,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ndjson_v2_output() {
        // Truncated but realistic shape from `docker compose ps --format json`
        // on Docker Desktop 4.x.
        let text = r#"{"Service":"db","Image":"postgres:15","State":"running","Publishers":[{"URL":"0.0.0.0","TargetPort":5432,"PublishedPort":5432,"Protocol":"tcp"}]}
{"Service":"redis","Image":"redis:7","State":"running","Publishers":[{"URL":"","TargetPort":6379,"PublishedPort":6379,"Protocol":"tcp"}]}
"#;
        let parsed = parse_compose_ps(text);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].service, "db");
        assert_eq!(parsed[0].image.as_deref(), Some("postgres:15"));
        assert_eq!(parsed[0].state, "running");
        assert_eq!(parsed[0].ports, vec!["0.0.0.0:5432->5432/tcp"]);
        assert_eq!(parsed[1].service, "redis");
        assert_eq!(parsed[1].ports, vec!["6379->6379/tcp"]);
    }

    #[test]
    fn parses_json_array_legacy_output() {
        let text = r#"[{"service":"web","image":"nginx","state":"running","ports":"80/tcp, 443/tcp"}]"#;
        let parsed = parse_compose_ps(text);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].service, "web");
        assert_eq!(parsed[0].ports, vec!["80/tcp", "443/tcp"]);
    }

    #[test]
    fn empty_and_malformed_input_yields_empty_vec() {
        assert!(parse_compose_ps("").is_empty());
        assert!(parse_compose_ps("   \n  ").is_empty());
        assert!(parse_compose_ps("not json at all").is_empty());
        // Malformed line in NDJSON is silently skipped.
        let mixed = "{\"Service\":\"ok\",\"State\":\"running\"}\nnot-json\n";
        let parsed = parse_compose_ps(mixed);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].service, "ok");
    }

    #[test]
    fn skips_entries_without_service_name() {
        let text = r#"{"Image":"noservice","State":"exited"}"#;
        assert!(parse_compose_ps(text).is_empty());
    }

    #[test]
    fn build_compose_args_without_project_name() {
        let args = build_compose_args("/tmp/docker-compose.yml", None);
        assert_eq!(args, vec!["compose", "-f", "/tmp/docker-compose.yml"]);
    }

    #[test]
    fn build_compose_args_with_project_name() {
        let args = build_compose_args("/tmp/docker-compose.yml", Some("mystack"));
        assert_eq!(
            args,
            vec!["compose", "-f", "/tmp/docker-compose.yml", "-p", "mystack"]
        );
    }

    #[test]
    fn build_compose_args_empty_project_name_ignored() {
        let args = build_compose_args("/tmp/docker-compose.yml", Some(""));
        assert_eq!(args, vec!["compose", "-f", "/tmp/docker-compose.yml"]);
    }
}
