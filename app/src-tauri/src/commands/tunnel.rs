// One-click Cloudflare quick tunnel for remote access.
//
// `cloudflared tunnel --url http://localhost:<port>` creates an ad-hoc
// tunnel with a random trycloudflare.com URL. We parse stdout for the
// URL and track the child process so the user can stop it.

use serde::Serialize;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct TunnelStatus {
    pub running: bool,
    pub url: Option<String>,
    pub pid: Option<u32>,
}

pub struct TunnelState {
    inner: Mutex<Option<TunnelInner>>,
}

struct TunnelInner {
    pid: u32,
    url: String,
}

impl TunnelState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(None),
        })
    }
}

#[tauri::command]
pub async fn start_tunnel(
    port: u16,
    state: tauri::State<'_, Arc<TunnelState>>,
) -> Result<TunnelStatus, String> {
    // Stop existing tunnel first
    {
        let mut guard = state.inner.lock().await;
        if let Some(inner) = guard.take() {
            unsafe { libc::kill(inner.pid as i32, libc::SIGTERM); }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    let mut child = Command::new("cloudflared")
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

    // Background reader — parse URL from stderr, then just drain
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(tx) = url_tx.take() {
                // Look for the trycloudflare.com URL
                if let Some(url) = extract_tunnel_url(&line) {
                    let _ = tx.send(url);
                    continue;
                }
                url_tx = Some(tx);
            }
            // Also check subsequent lines (URL might not be on the first line)
            if url_tx.is_some() {
                if let Some(url) = extract_tunnel_url(&line) {
                    if let Some(tx) = url_tx.take() {
                        let _ = tx.send(url);
                    }
                }
            }
        }
        // If we never found a URL, drop the sender (receiver gets error)
        drop(url_tx);
    });

    // Wait up to 15s for the URL
    let url = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        url_rx,
    )
    .await
    .map_err(|_| "Timeout waiting for tunnel URL (15s)".to_string())?
    .map_err(|_| "cloudflared exited before printing URL".to_string())?;

    // Store state
    {
        let mut guard = state.inner.lock().await;
        *guard = Some(TunnelInner {
            pid,
            url: url.clone(),
        });
    }

    // Background: wait for child exit, then clear state
    let state_clone = Arc::clone(state.inner());
    tokio::spawn(async move {
        let _ = child.wait().await;
        let mut guard = state_clone.inner.lock().await;
        if guard.as_ref().map(|i| i.pid) == Some(pid) {
            *guard = None;
        }
    });

    Ok(TunnelStatus {
        running: true,
        url: Some(url),
        pid: Some(pid),
    })
}

#[tauri::command]
pub async fn stop_tunnel(
    state: tauri::State<'_, Arc<TunnelState>>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if let Some(inner) = guard.take() {
        unsafe {
            libc::kill(inner.pid as i32, libc::SIGTERM);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // SIGKILL if still alive
        unsafe {
            libc::kill(inner.pid as i32, libc::SIGKILL);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn tunnel_status(
    state: tauri::State<'_, Arc<TunnelState>>,
) -> Result<TunnelStatus, String> {
    let guard = state.inner.lock().await;
    Ok(match &*guard {
        Some(inner) => TunnelStatus {
            running: true,
            url: Some(inner.url.clone()),
            pid: Some(inner.pid),
        },
        None => TunnelStatus {
            running: false,
            url: None,
            pid: None,
        },
    })
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
