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
use std::fmt::Write as _;
use std::process::Command;

const MANAGED_ARGV0_PREFIX: &str = "procman-cloudflared:";

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
    /// Exact procman tunnel owner decoded from the custom argv[0]. Legacy
    /// cloudflared processes have no owner marker and remain `None`.
    #[serde(skip_serializing)]
    pub managed_script_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudflaredIdentity {
    Managed(String),
    /// Legacy processes cannot carry a procman owner marker. Retain the exact
    /// observed command so a recycled PID cannot be mistaken for a different
    /// cloudflared process during the TERM -> KILL grace period.
    LegacyCommand(String),
}

pub fn managed_argv0(script_id: &str) -> Result<String, String> {
    if script_id.is_empty() || script_id.contains('\0') {
        return Err("tunnel script id must be non-empty and contain no NUL bytes".to_string());
    }

    let mut marker = String::with_capacity(MANAGED_ARGV0_PREFIX.len() + script_id.len() * 2);
    marker.push_str(MANAGED_ARGV0_PREFIX);
    for byte in script_id.as_bytes() {
        let _ = write!(marker, "{:02x}", byte);
    }
    Ok(marker)
}

fn decode_managed_argv0(token: &str) -> Option<String> {
    let encoded = token.strip_prefix(MANAGED_ARGV0_PREFIX)?;
    if encoded.is_empty() || encoded.len() % 2 != 0 {
        return None;
    }

    let mut bytes = Vec::with_capacity(encoded.len() / 2);
    for pair in encoded.as_bytes().chunks_exact(2) {
        let pair = std::str::from_utf8(pair).ok()?;
        bytes.push(u8::from_str_radix(pair, 16).ok()?);
    }
    let script_id = String::from_utf8(bytes).ok()?;
    if script_id.is_empty() || script_id.contains('\0') {
        return None;
    }
    Some(script_id)
}

impl RunningCloudflared {
    pub fn identity(&self) -> CloudflaredIdentity {
        match &self.managed_script_id {
            Some(script_id) => CloudflaredIdentity::Managed(script_id.clone()),
            None => CloudflaredIdentity::LegacyCommand(self.command.trim().to_string()),
        }
    }
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
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let created_at = item
            .get("created_at")
            .and_then(|v| v.as_str())
            .map(String::from);
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
    // `-ww` prevents the custom owner marker in argv[0] from being truncated.
    let out = Command::new("ps")
        .args(["-ww", "-eo", "pid=,command="])
        .output()
        .map_err(|e| format!("ps: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "ps failed while detecting cloudflared: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(parse_ps_for_cloudflared(&text))
}

fn parse_ps_for_cloudflared(text: &str) -> Vec<RunningCloudflared> {
    let mut result = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let Some(space) = trimmed.find(char::is_whitespace) else {
            continue;
        };
        let pid_str = &trimmed[..space];
        let rest = trimmed[space..].trim_start();
        let Some(identity) = parse_process_identity(rest) else {
            continue;
        };
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
            managed_script_id: match identity {
                ParsedIdentity::Managed(script_id) => Some(script_id),
                ParsedIdentity::Legacy => None,
            },
        });
    }
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ParsedIdentity {
    Managed(String),
    Legacy,
}

fn parse_process_identity(command: &str) -> Option<ParsedIdentity> {
    let first = command.split_whitespace().next()?;
    if let Some(script_id) = decode_managed_argv0(first) {
        return Some(ParsedIdentity::Managed(script_id));
    }
    if first == "cloudflared" || first.ends_with("/cloudflared") {
        return Some(ParsedIdentity::Legacy);
    }
    None
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
    terminate_cloudflared_pid(pid, None).await
}

pub async fn kill_cloudflared_pid_exact(
    pid: u32,
    expected: &CloudflaredIdentity,
) -> Result<(), String> {
    terminate_cloudflared_pid(pid, Some(expected)).await
}

async fn terminate_cloudflared_pid(
    pid: u32,
    expected: Option<&CloudflaredIdentity>,
) -> Result<(), String> {
    let Some(command) = process_command(pid)? else {
        return Ok(());
    };
    // Even the public, PID-only command pins the exact initially observed
    // identity. This prevents a different cloudflared process that reuses the
    // PID during the TERM grace period from being killed as the replacement.
    let exact_identity = match expected {
        Some(identity) => identity.clone(),
        None => identity_from_command(&command).ok_or_else(|| {
            format!(
                "PID {} is not a verified cloudflared process ({})",
                pid,
                command.trim()
            )
        })?,
    };
    // A pinned-identity mismatch means the recorded cloudflared already
    // exited and the PID was recycled by an unrelated process: there is
    // nothing of ours left to signal, and the current occupant must not be
    // touched. Treat the stop as idempotently complete — propagating an error
    // here would make the tracked entry un-stoppable (and un-startable)
    // forever, since retries can never succeed against a recycled PID.
    if let Err(mismatch) = verify_identity(pid, &command, Some(&exact_identity)) {
        log::info!(
            "cloudflared stop: {} — treating as already exited",
            mismatch
        );
        return Ok(());
    }

    let pid_i32 = i32::try_from(pid).map_err(|_| format!("invalid process id {}", pid))?;
    if send_signal(pid_i32, libc::SIGTERM, "SIGTERM")? == SignalResult::Missing {
        return Ok(());
    }

    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

    // Re-read and re-verify immediately before SIGKILL. A process can exit and
    // its PID can be recycled during the grace period; checking only `kill(0)`
    // would then kill an unrelated replacement.
    let Some(command) = process_command(pid)? else {
        return Ok(());
    };
    if let Err(mismatch) = verify_identity(pid, &command, Some(&exact_identity)) {
        log::info!(
            "cloudflared stop: {} after SIGTERM grace — treating as exited",
            mismatch
        );
        return Ok(());
    }
    let _ = send_signal(pid_i32, libc::SIGKILL, "SIGKILL")?;
    Ok(())
}

fn process_command(pid: u32) -> Result<Option<String>, String> {
    let out = Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .map_err(|e| format!("ps: {}", e))?;
    let command = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() {
        // BSD `ps` exits non-zero with empty stdout when the PID no longer
        // exists. Treat that as an idempotent successful stop, but propagate
        // real invocation/permission errors.
        if command.is_empty()
            && out.status.code() == Some(1)
            && String::from_utf8_lossy(&out.stderr).trim().is_empty()
        {
            return Ok(None);
        }
        return Err(format!(
            "ps failed for PID {}: {}",
            pid,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    if command.is_empty() {
        return Ok(None);
    }
    Ok(Some(command))
}

fn identity_from_command(command: &str) -> Option<CloudflaredIdentity> {
    match parse_process_identity(command)? {
        ParsedIdentity::Managed(script_id) => Some(CloudflaredIdentity::Managed(script_id)),
        ParsedIdentity::Legacy => Some(CloudflaredIdentity::LegacyCommand(
            command.trim().to_string(),
        )),
    }
}

fn verify_identity(
    pid: u32,
    command: &str,
    expected: Option<&CloudflaredIdentity>,
) -> Result<(), String> {
    let parsed = parse_process_identity(command).ok_or_else(|| {
        format!(
            "PID {} is not a verified cloudflared process ({})",
            pid,
            command.trim()
        )
    })?;

    match expected {
        None => Ok(()),
        Some(CloudflaredIdentity::Managed(expected_script_id)) => match parsed {
            ParsedIdentity::Managed(actual_script_id)
                if actual_script_id == *expected_script_id =>
            {
                Ok(())
            }
            _ => Err(format!(
                "PID {} cloudflared owner mismatch: expected {:?}, found {}",
                pid,
                expected_script_id,
                command.trim()
            )),
        },
        Some(CloudflaredIdentity::LegacyCommand(expected_command)) => {
            if parsed == ParsedIdentity::Legacy && command.trim() == expected_command.trim() {
                Ok(())
            } else {
                Err(format!(
                    "PID {} legacy cloudflared command changed: expected {}, found {}",
                    pid,
                    expected_command.trim(),
                    command.trim()
                ))
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalResult {
    Sent,
    Missing,
}

fn send_signal(pid: i32, signal: i32, name: &str) -> Result<SignalResult, String> {
    if unsafe { libc::kill(pid, signal) } == 0 {
        return Ok(SignalResult::Sent);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(SignalResult::Missing);
    }
    Err(format!("{} PID {} failed: {}", name, pid, error))
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
        assert_eq!(parsed[0].managed_script_id, None);
    }

    #[test]
    fn parses_managed_owner_from_custom_argv0() {
        let marker = managed_argv0("project A/서버").unwrap();
        let sample = format!("777 {} tunnel --url http://localhost:7777", marker);
        let parsed = parse_ps_for_cloudflared(&sample);
        assert_eq!(parsed.len(), 1);
        assert_eq!(
            parsed[0].managed_script_id.as_deref(),
            Some("project A/서버")
        );
        assert_eq!(
            parsed[0].identity(),
            CloudflaredIdentity::Managed("project A/서버".into())
        );
    }

    #[test]
    fn rejects_malformed_managed_markers_and_prefix_spoofs() {
        let sample = concat!(
            "1 procman-cloudflared:0 tunnel --url http://localhost:1\n",
            "2 procman-cloudflared:zz tunnel --url http://localhost:2\n",
            "3 attacker-procman-cloudflared:6162 tunnel --url http://localhost:3\n",
            "4 procman-cloudflared: tunnel --url http://localhost:4"
        );
        assert!(parse_ps_for_cloudflared(sample).is_empty());
    }

    #[test]
    fn exact_identity_rejects_owner_and_legacy_command_changes() {
        let alpha = format!(
            "{} tunnel --url http://localhost:7000",
            managed_argv0("alpha").unwrap()
        );
        let beta = format!(
            "{} tunnel --url http://localhost:7000",
            managed_argv0("beta").unwrap()
        );
        assert!(verify_identity(
            10,
            &alpha,
            Some(&CloudflaredIdentity::Managed("alpha".into()))
        )
        .is_ok());
        assert!(verify_identity(
            10,
            &beta,
            Some(&CloudflaredIdentity::Managed("alpha".into()))
        )
        .is_err());

        let legacy = "cloudflared tunnel --url http://localhost:7000";
        assert!(verify_identity(
            11,
            legacy,
            Some(&CloudflaredIdentity::LegacyCommand(legacy.into()))
        )
        .is_ok());
        assert!(verify_identity(
            11,
            "cloudflared tunnel --url http://localhost:7001",
            Some(&CloudflaredIdentity::LegacyCommand(legacy.into()))
        )
        .is_err());
    }

    #[test]
    fn skips_grep_noise() {
        let sample = "1 grep cloudflared\n2 vim cloudflared-notes.md";
        let parsed = parse_ps_for_cloudflared(sample);
        assert_eq!(parsed.len(), 0);
    }
}
