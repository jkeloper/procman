// Per-script Cloudflare quick tunnel for remote access.
//
// Multiple tunnels can run concurrently, keyed by script_id. Each one
// is `cloudflared tunnel --url http://localhost:<port>` which produces
// a random trycloudflare.com URL. The child process is tracked so the
// user can stop an individual tunnel without affecting others.

use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use url::Url;

use crate::cloudflared::{CloudflaredIdentity, RunningCloudflared};

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
    inner: Mutex<HashMap<String, Vec<TunnelInner>>>,
    /// Serializes recovery/start/stop transitions while status reads remain
    /// non-blocking. This prevents two concurrent starts from each replacing
    /// the other's process after the old tunnel has been terminated.
    lifecycle: Mutex<()>,
}

#[derive(Debug, Clone)]
struct TunnelInner {
    pid: u32,
    url: String,
    port: u16,
    identity: CloudflaredIdentity,
}

impl TunnelState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(()),
        })
    }

    /// Recover tunnels from running cloudflared processes found via `ps`.
    /// Managed processes carry their exact script id in argv[0]. Legacy
    /// unmarked processes are admitted only when their origin port maps to one
    /// unique configured script. The public trycloudflare URL is lost after a
    /// restart, so recovered entries use a non-URL status placeholder.
    pub async fn recover_from_running(
        &self,
        running: &[RunningCloudflared],
        scripts: &[(String, u16)], // (script_id, port)
    ) {
        let _lifecycle = self.lifecycle.lock().await;
        self.recover_from_running_with(running, scripts, |pid, identity| async move {
            crate::cloudflared::kill_cloudflared_pid_exact(pid, &identity).await
        })
        .await;
    }

    async fn recover_from_running_with<F, Fut>(
        &self,
        running: &[RunningCloudflared],
        scripts: &[(String, u16)],
        mut kill: F,
    ) where
        F: FnMut(u32, CloudflaredIdentity) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        // None means more than one configured script claims the port, so an
        // unmarked legacy process cannot be attributed safely.
        let mut port_to_script: HashMap<u16, Option<&str>> = HashMap::new();
        for (script_id, port) in scripts {
            port_to_script
                .entry(*port)
                .and_modify(|owner| {
                    if owner.is_some_and(|existing| existing != script_id.as_str()) {
                        *owner = None;
                    }
                })
                .or_insert(Some(script_id.as_str()));
        }

        // Prefer exact managed ownership over a legacy port inference if both
        // kinds are present. The relative PID/`ps` ordering must not decide
        // which process becomes the logical primary tunnel.
        let ordered = running
            .iter()
            .filter(|process| process.managed_script_id.is_some())
            .chain(
                running
                    .iter()
                    .filter(|process| process.managed_script_id.is_none()),
            );
        for process in ordered {
            let Some(target_url) = process.url.as_deref() else {
                continue;
            };
            let Some(port) = parse_port_from_url(target_url) else {
                continue;
            };
            let script_id = match process.managed_script_id.as_deref() {
                Some(script_id) => script_id,
                None => match port_to_script.get(&port).copied().flatten() {
                    Some(script_id) => script_id,
                    None => continue,
                },
            };
            let identity = process.identity();
            let entry = TunnelInner {
                pid: process.pid,
                url: format!("(tunnel active on :{})", port),
                port,
                identity: identity.clone(),
            };

            let is_already_tracked = {
                let guard = self.inner.lock().await;
                guard
                    .get(script_id)
                    .is_some_and(|entries| entries.iter().any(|item| item.pid == process.pid))
            };
            if is_already_tracked {
                continue;
            }

            let has_owner = {
                let guard = self.inner.lock().await;
                guard
                    .get(script_id)
                    .is_some_and(|entries| !entries.is_empty())
            };
            if has_owner && process.managed_script_id.is_some() {
                // A second marked process for the exact same id is an orphaned
                // duplicate, not a second logical tunnel. Kill only after exact
                // identity verification. If termination fails, retain it so a
                // later stop/start can retry instead of losing a public origin.
                match kill(process.pid, identity).await {
                    Ok(()) => {
                        log::warn!(
                            "tunnel recovery removed duplicate cloudflared pid {} for script {}",
                            process.pid,
                            script_id
                        );
                        continue;
                    }
                    Err(error) => {
                        log::warn!(
                            "tunnel recovery could not remove duplicate pid {} for script {}: {}",
                            process.pid,
                            script_id,
                            error
                        );
                    }
                }
            } else if !has_owner {
                log::info!(
                    "tunnel recovery: cloudflared pid {} on :{} → script {}",
                    process.pid,
                    port,
                    script_id
                );
            }

            self.inner
                .lock()
                .await
                .entry(script_id.to_string())
                .or_default()
                .push(entry);
        }
    }

    pub async fn stop_one(&self, script_id: &str) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_one_inner(script_id).await
    }

    async fn stop_one_inner(&self, script_id: &str) -> Result<(), String> {
        self.stop_one_inner_with(script_id, |pid, identity| async move {
            crate::cloudflared::kill_cloudflared_pid_exact(pid, &identity).await
        })
        .await
    }

    async fn stop_one_inner_with<F, Fut>(&self, script_id: &str, mut kill: F) -> Result<(), String>
    where
        F: FnMut(u32, CloudflaredIdentity) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        let entries = self
            .inner
            .lock()
            .await
            .remove(script_id)
            .unwrap_or_default();
        let mut failed = Vec::new();
        let mut errors = Vec::new();
        for entry in entries {
            if let Err(error) = kill(entry.pid, entry.identity.clone()).await {
                errors.push(format!("{} pid {}: {}", script_id, entry.pid, error));
                failed.push(entry);
            }
        }
        if !failed.is_empty() {
            self.inner
                .lock()
                .await
                .entry(script_id.to_string())
                .or_default()
                .extend(failed);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join(", "))
        }
    }

    async fn remove_pid(&self, script_id: &str, pid: u32) {
        let mut guard = self.inner.lock().await;
        if let Some(entries) = guard.get_mut(script_id) {
            entries.retain(|entry| entry.pid != pid);
            if entries.is_empty() {
                guard.remove(script_id);
            }
        }
    }
}

fn parse_port_from_url(url: &str) -> Option<u16> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "http" || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    match parsed.host_str()?.to_ascii_lowercase().as_str() {
        "localhost" | "127.0.0.1" | "::1" | "[::1]" => parsed.port(),
        _ => None,
    }
}

#[cfg(test)]
mod parse_tests {
    use super::parse_port_from_url;

    #[test]
    fn v4_host() {
        assert_eq!(parse_port_from_url("http://127.0.0.1:8080"), Some(8080));
    }

    #[test]
    fn localhost() {
        assert_eq!(parse_port_from_url("http://localhost:3000"), Some(3000));
    }

    #[test]
    fn ipv6_literal() {
        assert_eq!(parse_port_from_url("http://[::1]:3000"), Some(3000));
        assert_eq!(parse_port_from_url("http://[fe80::1]:9000"), None);
    }

    #[test]
    fn no_port_none() {
        assert_eq!(parse_port_from_url("http://localhost"), None);
        assert_eq!(parse_port_from_url("http://[::1]"), None);
    }

    #[test]
    fn with_path() {
        assert_eq!(
            parse_port_from_url("http://localhost:8000/ready"),
            Some(8000)
        );
    }

    #[test]
    fn rejects_non_loopback_or_credentialed_origins() {
        assert_eq!(parse_port_from_url("http://10.0.0.2:7777"), None);
        assert_eq!(parse_port_from_url("https://localhost:7777"), None);
        assert_eq!(parse_port_from_url("http://user@localhost:7777"), None);
    }
}

#[tauri::command]
pub async fn start_tunnel(
    port: u16,
    script_id: String,
    state: tauri::State<'_, Arc<TunnelState>>,
) -> Result<TunnelStatus, String> {
    if port == 0 {
        return Err("tunnel origin port must be greater than zero".to_string());
    }
    let managed_argv0 = crate::cloudflared::managed_argv0(&script_id)?;
    let identity = CloudflaredIdentity::Managed(script_id.clone());

    // Validate all new inputs before touching an existing process, then hold
    // the lifecycle lock through replacement and publication of the new state.
    let _lifecycle = state.lifecycle.lock().await;
    state.stop_one_inner(&script_id).await?;

    let bin = resolve_cloudflared();
    let origin = format!("http://localhost:{}", port);
    let mut command = Command::new(&bin);
    command
        .args(["tunnel", "--url", &origin])
        // cloudflared emits its quick-tunnel URL on stderr. Do not pipe stdout
        // without consuming it, because a full pipe would deadlock the child.
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().arg0(&managed_argv0);

    let mut child = command
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
            if let Some(url) = extract_tunnel_url(&line) {
                if let Some(tx) = url_tx.take() {
                    let _ = tx.send(url);
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
            vec![TunnelInner {
                pid,
                url: url.clone(),
                port,
                identity,
            }],
        );
    }

    // Background: wait for child exit, then clear state
    let state_clone: Arc<TunnelState> = Arc::clone(&state);
    let script_id_clone = script_id.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        state_clone.remove_pid(&script_id_clone, pid).await;
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
    state.stop_one(&script_id).await
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
        .flat_map(|(script_id, entries)| {
            entries.iter().map(|inner| TunnelEntry {
                script_id: script_id.clone(),
                url: inner.url.clone(),
                pid: inner.pid,
                port: inner.port,
            })
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
        let candidate =
            token
                .strip_prefix("url=")
                .unwrap_or(token)
                .trim_matches(|character: char| {
                    matches!(
                        character,
                        '|' | '+' | '"' | '\'' | '(' | ')' | '[' | ']' | ',' | ';'
                    )
                });
        if let Some(origin) = canonical_trycloudflare_origin(candidate) {
            return Some(origin);
        }
    }
    None
}

fn canonical_trycloudflare_origin(candidate: &str) -> Option<String> {
    let parsed = Url::parse(candidate).ok()?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443)
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }

    let host = parsed.host_str()?.to_ascii_lowercase();
    let prefix = host.strip_suffix(".trycloudflare.com")?;
    if prefix.is_empty() || prefix.split('.').any(str::is_empty) {
        return None;
    }
    Some(format!("https://{}", host))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::ready;
    use std::sync::Mutex as StdMutex;

    fn managed_process(pid: u32, script_id: &str, port: u16) -> RunningCloudflared {
        let command = format!(
            "{} tunnel --url http://localhost:{}",
            crate::cloudflared::managed_argv0(script_id).unwrap(),
            port
        );
        RunningCloudflared {
            pid,
            command,
            url: Some(format!("http://localhost:{}", port)),
            tunnel_name: None,
            managed_script_id: Some(script_id.to_string()),
        }
    }

    fn legacy_process(pid: u32, port: u16) -> RunningCloudflared {
        let command = format!("cloudflared tunnel --url http://localhost:{}", port);
        RunningCloudflared {
            pid,
            command,
            url: Some(format!("http://localhost:{}", port)),
            tunnel_name: None,
            managed_script_id: None,
        }
    }

    fn tracked_process(pid: u32, script_id: &str, port: u16) -> TunnelInner {
        TunnelInner {
            pid,
            url: format!("https://{}.trycloudflare.com", script_id),
            port,
            identity: CloudflaredIdentity::Managed(script_id.to_string()),
        }
    }

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
    fn canonicalizes_default_tls_port_and_host_case() {
        assert_eq!(
            extract_tunnel_url("url=HTTPS://Foo-Bar.TryCloudflare.Com:443/"),
            Some("https://foo-bar.trycloudflare.com".into())
        );
    }

    #[test]
    fn rejects_non_origin_or_spoofed_tunnel_urls() {
        for line in [
            "url=http://foo.trycloudflare.com",
            "url=https://trycloudflare.com",
            "url=https://eviltrycloudflare.com",
            "url=https://foo.trycloudflare.com.evil.example",
            "url=https://foo.trycloudflare.com:444",
            "url=https://foo.trycloudflare.com/path",
            "url=https://foo.trycloudflare.com/?query=yes",
            "url=https://foo.trycloudflare.com/#fragment",
            "url=https://user@foo.trycloudflare.com",
            "url=https://foo.trycloudflare.com@evil.example",
            "url=https://foo..trycloudflare.com",
        ] {
            assert_eq!(extract_tunnel_url(line), None, "accepted {line}");
        }
    }

    #[test]
    fn no_url_in_noise() {
        assert_eq!(extract_tunnel_url("INF Starting tunnel"), None);
    }

    #[tokio::test]
    async fn managed_marker_recovers_exact_script_without_a_port_mapping() {
        let state = TunnelState::new();
        let running = vec![managed_process(4242, "remote/server", 7777)];

        state
            .recover_from_running_with(&running, &[], |_, _| ready(Ok(())))
            .await;

        let guard = state.inner.lock().await;
        let recovered = guard
            .get("remote/server")
            .expect("the marker is the exact recovery owner");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].pid, 4242);
        assert_eq!(recovered[0].port, 7777);
    }

    #[tokio::test]
    async fn legacy_recovery_requires_a_unique_configured_port() {
        let state = TunnelState::new();
        let running = vec![legacy_process(100, 7777), legacy_process(101, 3000)];
        let scripts = vec![("configured".to_string(), 3000)];

        state
            .recover_from_running_with(&running, &scripts, |_, _| ready(Ok(())))
            .await;

        let guard = state.inner.lock().await;
        assert!(!guard.contains_key("__remote_server__"));
        let recovered = guard.get("configured").unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].pid, 101);
    }

    #[tokio::test]
    async fn ambiguous_legacy_port_is_not_recovered() {
        let state = TunnelState::new();
        let running = vec![legacy_process(100, 3000)];
        let scripts = vec![("alpha".to_string(), 3000), ("beta".to_string(), 3000)];

        state
            .recover_from_running_with(&running, &scripts, |_, _| ready(Ok(())))
            .await;

        assert!(state.inner.lock().await.is_empty());
    }

    #[tokio::test]
    async fn duplicate_marked_owner_is_terminated_with_exact_identity() {
        let state = TunnelState::new();
        let running = vec![
            managed_process(10, "alpha", 3000),
            managed_process(11, "alpha", 3000),
        ];
        let killed = Arc::new(StdMutex::new(Vec::new()));
        let killed_for_call = Arc::clone(&killed);

        state
            .recover_from_running_with(&running, &[], move |pid, identity| {
                killed_for_call.lock().unwrap().push((pid, identity));
                ready(Ok(()))
            })
            .await;

        assert_eq!(
            *killed.lock().unwrap(),
            vec![(11, CloudflaredIdentity::Managed("alpha".into()))]
        );
        let guard = state.inner.lock().await;
        let recovered = guard.get("alpha").unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].pid, 10);
    }

    #[tokio::test]
    async fn duplicate_kill_failure_remains_tracked_for_retry() {
        let state = TunnelState::new();
        let running = vec![
            managed_process(10, "alpha", 3000),
            managed_process(11, "alpha", 3000),
        ];

        state
            .recover_from_running_with(&running, &[], |_, _| {
                ready(Err("permission denied".to_string()))
            })
            .await;

        let guard = state.inner.lock().await;
        let pids: Vec<u32> = guard["alpha"].iter().map(|entry| entry.pid).collect();
        assert_eq!(pids, vec![10, 11]);
    }

    #[tokio::test]
    async fn stop_one_retains_only_processes_that_failed_to_stop() {
        let state = TunnelState::new();
        state.inner.lock().await.insert(
            "alpha".into(),
            vec![
                tracked_process(10, "alpha", 3000),
                tracked_process(11, "alpha", 3000),
            ],
        );

        let result = state
            .stop_one_inner_with("alpha", |pid, _| {
                ready(if pid == 11 {
                    Err("signal denied".to_string())
                } else {
                    Ok(())
                })
            })
            .await;

        assert!(result.unwrap_err().contains("alpha pid 11"));
        let guard = state.inner.lock().await;
        let remaining = guard.get("alpha").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].pid, 11);
    }
}
