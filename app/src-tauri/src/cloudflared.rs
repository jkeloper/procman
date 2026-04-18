// Cloudflared tunnel integration.
//
// Supports:
//   - list_named_tunnels: wraps `cloudflared tunnel list --output json`
//   - detect_running: parses `ps` for running cloudflared processes
//   - kill_cloudflared_pid: SIGTERM then SIGKILL
//   - cloudflared_installed: `which cloudflared` check
//
// If cloudflared is not installed, commands return Ok(empty) so UI can hide
// the section gracefully.

use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct CfInstalled {
    pub installed: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedTunnel {
    pub id: String,
    pub name: String,
    pub created_at: Option<String>,
    pub connections: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunningCloudflared {
    pub pid: u32,
    pub command: String,
    /// Extracted arg hints: --url, --name, run <name>, tunnel <name>
    pub url: Option<String>,
    pub tunnel_name: Option<String>,
}

#[tauri::command]
pub async fn cloudflared_installed() -> Result<CfInstalled, String> {
    let out = Command::new("which").arg("cloudflared").output();
    let installed = out.as_ref().map(|o| o.status.success()).unwrap_or(false);
    if !installed {
        return Ok(CfInstalled {
            installed: false,
            version: None,
        });
    }
    let version = Command::new("cloudflared")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.lines().next().unwrap_or("").trim().to_string());
    Ok(CfInstalled {
        installed: true,
        version,
    })
}

#[tauri::command]
pub async fn list_cf_tunnels() -> Result<Vec<NamedTunnel>, String> {
    let out = Command::new("cloudflared")
        .args(["tunnel", "list", "--output", "json"])
        .output()
        .map_err(|e| format!("cloudflared spawn: {}", e))?;
    if !out.status.success() {
        // Not authenticated / no tunnels / wrong version → return empty
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // cloudflared output shape: [{ id, name, created_at, connections: [...] }]
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let arr = parsed.as_array().cloned().unwrap_or_default();
    let mut result = Vec::new();
    for item in arr {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let created_at = item.get("created_at").and_then(|v| v.as_str()).map(String::from);
        let connections = item
            .get("connections")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        if !id.is_empty() {
            result.push(NamedTunnel {
                id,
                name,
                created_at,
                connections,
            });
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn detect_running_cloudflared() -> Result<Vec<RunningCloudflared>, String> {
    // ps -eo pid=,command= | grep cloudflared
    let out = Command::new("ps")
        .args(["-eo", "pid=,command="])
        .output()
        .map_err(|e| format!("ps: {}", e))?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(parse_ps_for_cloudflared(&text))
}

fn parse_ps_for_cloudflared(text: &str) -> Vec<RunningCloudflared> {
    let mut result = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let Some(space) = trimmed.find(char::is_whitespace) else { continue };
        let pid_str = &trimmed[..space];
        let rest = trimmed[space..].trim_start();
        // Match binaries named cloudflared (not e.g. grep cloudflared)
        if !rest_is_cloudflared(rest) {
            continue;
        }
        let pid: u32 = match pid_str.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let (url, tunnel_name) = extract_tunnel_args(rest);
        result.push(RunningCloudflared {
            pid,
            command: rest.to_string(),
            url,
            tunnel_name,
        });
    }
    result
}

fn rest_is_cloudflared(rest: &str) -> bool {
    // First token must end with `/cloudflared` or be exactly `cloudflared`
    let first = rest.split_whitespace().next().unwrap_or("");
    first == "cloudflared" || first.ends_with("/cloudflared")
}

fn extract_tunnel_args(rest: &str) -> (Option<String>, Option<String>) {
    let toks: Vec<&str> = rest.split_whitespace().collect();
    let mut url = None;
    let mut name = None;
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "--url" if i + 1 < toks.len() => {
                url = Some(toks[i + 1].to_string());
                i += 2;
                continue;
            }
            "--name" if i + 1 < toks.len() => {
                name = Some(toks[i + 1].to_string());
                i += 2;
                continue;
            }
            "run" if i + 1 < toks.len() => {
                // `cloudflared tunnel run <name>`
                let candidate = toks[i + 1];
                if !candidate.starts_with('-') {
                    name = Some(candidate.to_string());
                }
            }
            _ => {}
        }
        if let Some(rest) = toks[i].strip_prefix("--url=") {
            url = Some(rest.to_string());
        }
        if let Some(rest) = toks[i].strip_prefix("--name=") {
            name = Some(rest.to_string());
        }
        i += 1;
    }
    (url, name)
}

#[tauri::command]
pub async fn kill_cloudflared_pid(pid: u32) -> Result<(), String> {
    // SEC-12: verify the PID is actually a cloudflared process before killing
    let check = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .map_err(|e| format!("ps: {}", e))?;
    let cmd = String::from_utf8_lossy(&check.stdout);
    let first_token = cmd.split_whitespace().next().unwrap_or("");
    if first_token != "cloudflared" && !first_token.ends_with("/cloudflared") {
        return Err(format!("PID {} is not a cloudflared process ({})", pid, cmd.trim()));
    }
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    // If still alive, SIGKILL
    let alive = unsafe { libc::kill(pid as i32, 0) == 0 };
    if alive {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tunnel_run() {
        let sample = "12345 /usr/local/bin/cloudflared tunnel run myhouse\n99 bash";
        let parsed = parse_ps_for_cloudflared(sample);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].pid, 12345);
        assert_eq!(parsed[0].tunnel_name.as_deref(), Some("myhouse"));
    }

    #[test]
    fn parses_quick_tunnel() {
        let sample = "999 cloudflared tunnel --url http://localhost:3000";
        let parsed = parse_ps_for_cloudflared(sample);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].url.as_deref(), Some("http://localhost:3000"));
    }

    #[test]
    fn skips_grep_noise() {
        let sample = "1 grep cloudflared\n2 vim cloudflared-notes.md";
        let parsed = parse_ps_for_cloudflared(sample);
        assert_eq!(parsed.len(), 0);
    }
}
