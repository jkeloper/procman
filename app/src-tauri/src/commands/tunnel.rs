// Per-script Cloudflare quick tunnel for remote access.
//
// Multiple tunnels can run concurrently, keyed by script_id. Each one
// is `cloudflared tunnel --url http://localhost:<port>` which produces
// a random trycloudflare.com URL. The child process is tracked so the
// user can stop an individual tunnel without affecting others.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct TunnelStatus {
    pub running: bool,
    pub url: Option<String>,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub script_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TunnelEntry {
    pub script_id: String,
    pub url: String,
    pub pid: u32,
    pub port: u16,
}

pub struct TunnelState {
    inner: Mutex<HashMap<String, TunnelInner>>,
}

struct TunnelInner {
    pid: u32,
    url: String,
    port: u16,
}

impl TunnelState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
        })
    }

    /// Recover tunnels from running cloudflared processes found via `ps`.
    /// Matches each cloudflared's `--url http://localhost:<port>` to a
    /// script by declared ports or expected_port. The trycloudflare.com
    /// URL is lost (was printed to stderr at startup), so we show a
    /// placeholder. User can stop+restart to get a fresh URL.
    pub async fn recover_from_running(
        &self,
        running: &[crate::cloudflared::RunningCloudflared],
        scripts: &[(String, u16)], // (script_id, port)
    ) {
        let port_to_script: HashMap<u16, &str> = scripts
            .iter()
            .map(|(id, port)| (*port, id.as_str()))
            .collect();

        let mut guard = self.inner.lock().await;
        for cf in running {
            let Some(ref target_url) = cf.url else { continue };
            let Some(port) = parse_port_from_url(target_url) else { continue };
            let Some(script_id) = port_to_script.get(&port) else { continue };
            // Don't overwrite if already tracked (e.g. user started a
            // fresh tunnel in this session).
            if guard.contains_key(*script_id) {
                continue;
            }
            log::info!(
                "tunnel recovery: cloudflared pid {} on :{} → script {}",
                cf.pid, port, script_id
            );
            guard.insert(
                script_id.to_string(),
                TunnelInner {
                    pid: cf.pid,
                    url: format!("(tunnel active on :{})", port),
                    port,
                },
            );
        }
    }
}

fn parse_port_from_url(url: &str) -> Option<u16> {
    // "http://localhost:3000" or "http://127.0.0.1:8080"
    url.rsplit_once(':')?.1.parse().ok()
}

#[tauri::command]
pub async fn start_tunnel(
    port: u16,
    script_id: String,
    state: tauri::State<'_, Arc<TunnelState>>,
) -> Result<TunnelStatus, String> {
    // Stop existing tunnel for this script_id (if any) so we don't
    // accumulate duplicates for the same process on restart.
    {
        let mut guard = state.inner.lock().await;
        if let Some(inner) = guard.remove(&script_id) {
            unsafe {
                libc::kill(inner.pid as i32, libc::SIGTERM);
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    let bin = resolve_cloudflared();
    let mut child = Command::new(&bin)
        .args(["tunnel", "--url", &format!("http://localhost:{}", port)])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("cloudflared not installed or failed: {}", e))?;

    let pid = child.id().ok_or("no pid")?;

    // cloudflared prints the URL to stderr. Read lines until we find it.
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let (url_tx, url_rx) = tokio::sync::oneshot::channel::<String>();
    let mut url_tx = Some(url_tx);

    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(tx) = url_tx.take() {
                if let Some(url) = extract_tunnel_url(&line) {
                    let _ = tx.send(url);
                    continue;
                }
                url_tx = Some(tx);
            }
            if url_tx.is_some() {
                if let Some(url) = extract_tunnel_url(&line) {
                    if let Some(tx) = url_tx.take() {
                        let _ = tx.send(url);
                    }
                }
            }
        }
        drop(url_tx);
    });

    // Wait up to 15s for the URL
    let url = tokio::time::timeout(std::time::Duration::from_secs(15), url_rx)
        .await
        .map_err(|_| "Timeout waiting for tunnel URL (15s)".to_string())?
        .map_err(|_| "cloudflared exited before printing URL".to_string())?;

    // Store state
    {
        let mut guard = state.inner.lock().await;
        guard.insert(
            script_id.clone(),
            TunnelInner {
                pid,
                url: url.clone(),
                port,
            },
        );
    }

    // Background: wait for child exit, then clear state
    let state_clone: Arc<TunnelState> = Arc::clone(&state);
    let script_id_clone = script_id.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        let mut guard = state_clone.inner.lock().await;
        if let Some(entry) = guard.get(&script_id_clone) {
            if entry.pid == pid {
                guard.remove(&script_id_clone);
            }
        }
    });

    Ok(TunnelStatus {
        running: true,
        url: Some(url),
        pid: Some(pid),
        port: Some(port),
        script_id: Some(script_id),
    })
}

#[tauri::command]
pub async fn stop_tunnel(
    script_id: String,
    state: tauri::State<'_, Arc<TunnelState>>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if let Some(inner) = guard.remove(&script_id) {
        unsafe {
            libc::kill(inner.pid as i32, libc::SIGTERM);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        unsafe {
            libc::kill(inner.pid as i32, libc::SIGKILL);
        }
    }
    Ok(())
}

/// Return all active tunnels. Frontend calls this on mount to
/// rebuild the per-script tunnel display after navigation away.
#[tauri::command]
pub async fn tunnel_status(
    state: tauri::State<'_, Arc<TunnelState>>,
) -> Result<Vec<TunnelEntry>, String> {
    let guard = state.inner.lock().await;
    Ok(guard
        .iter()
        .map(|(script_id, inner)| TunnelEntry {
            script_id: script_id.clone(),
            url: inner.url.clone(),
            pid: inner.pid,
            port: inner.port,
        })
        .collect())
}

/// Resolve the cloudflared binary path. Tauri's Rust process doesn't
/// inherit the user's shell PATH, so bare `cloudflared` may fail with
/// "No such file or directory". Try common Homebrew paths first.
fn resolve_cloudflared() -> String {
    for p in [
        "/opt/homebrew/bin/cloudflared",
        "/usr/local/bin/cloudflared",
    ] {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    "cloudflared".to_string()
}

fn extract_tunnel_url(line: &str) -> Option<String> {
    // cloudflared prints lines like:
    //   INF +----------------------------+
    //   INF |  https://xxx-xxx-xxx.trycloudflare.com |
    //   INF +----------------------------+
    // or sometimes: "... url=https://xxx.trycloudflare.com ..."
    for token in line.split_whitespace() {
        let clean = token.trim_matches(|c: char| c == '|' || c == '+' || c == '-');
        if clean.starts_with("https://") && clean.contains("trycloudflare.com") {
            return Some(clean.to_string());
        }
        if let Some(rest) = token.strip_prefix("url=") {
            if rest.starts_with("https://") {
                return Some(rest.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_tunnel_url_from_box() {
        let line = "INF |  https://my-tunnel-abc.trycloudflare.com |";
        assert_eq!(
            extract_tunnel_url(line),
            Some("https://my-tunnel-abc.trycloudflare.com".into()),
        );
    }

    #[test]
    fn extracts_tunnel_url_from_key() {
        let line = "2024-01-01 INF url=https://foo-bar.trycloudflare.com some other text";
        assert_eq!(
            extract_tunnel_url(line),
            Some("https://foo-bar.trycloudflare.com".into()),
        );
    }

    #[test]
    fn no_url_in_noise() {
        assert_eq!(extract_tunnel_url("INF Starting tunnel"), None);
    }
}
