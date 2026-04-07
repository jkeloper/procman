// Port scanner — parse `lsof` output on macOS.
//
// LEARN (systems calls from Rust):
//   - macOS has no stable port→pid API. We shell out to
//     `lsof -nP -iTCP -sTCP:LISTEN -F pPcnT` which produces a machine-parseable
//     record format: fields prefixed with letters, records separated by newlines.
//   - std::process::Command (sync) is fine for one-shot calls like lsof.
//   - `kill` goes through `libc::kill(pid, sig)` — we hand-roll it to avoid
//     pulling the nix crate just for two signal constants.

use crate::types::PortInfo;
use std::collections::HashMap;
use std::process::Command;

#[tauri::command]
pub async fn list_ports() -> Result<Vec<PortInfo>, String> {
    // -F field output: p<pid>, c<command>, n<host:port>, T<state>
    let output = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcnT"])
        .output()
        .map_err(|e| format!("lsof spawn: {}", e))?;

    if !output.status.success() {
        // lsof returns 1 when no results — treat empty stdout as empty list
        if output.stdout.is_empty() {
            return Ok(vec![]);
        }
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(parse_lsof(&text))
}

/// Dedupe: same (pid, port) pair can appear multiple times (IPv4 + IPv6).
pub fn parse_lsof_for_api(text: &str) -> Vec<PortInfo> {
    parse_lsof(text)
}

fn parse_lsof(text: &str) -> Vec<PortInfo> {
    let mut seen: HashMap<(u32, u16), PortInfo> = HashMap::new();
    let mut cur_pid: Option<u32> = None;
    let mut cur_cmd: Option<String> = None;
    for line in text.lines() {
        let Some((prefix, rest)) = line.split_at_checked(1) else { continue };
        match prefix {
            "p" => {
                cur_pid = rest.parse().ok();
                cur_cmd = None;
            }
            "c" => cur_cmd = Some(rest.to_string()),
            "n" => {
                // Formats: "*:3000", "127.0.0.1:5432", "[::1]:8080"
                let port = rest
                    .rsplit_once(':')
                    .and_then(|(_, p)| p.parse::<u16>().ok());
                if let (Some(pid), Some(port)) = (cur_pid, port) {
                    let cmd = cur_cmd.clone().unwrap_or_else(|| "?".into());
                    seen.entry((pid, port)).or_insert(PortInfo {
                        port,
                        pid,
                        process_name: cmd,
                        command: String::new(), // filled later via `ps`
                    });
                }
            }
            _ => {}
        }
    }
    let mut result: Vec<PortInfo> = seen.into_values().collect();
    result.sort_by_key(|p| p.port);

    // Enrich each entry with the full command line from `ps`.
    let pids: Vec<String> = result.iter().map(|p| p.pid.to_string()).collect();
    if !pids.is_empty() {
        let ps_out = Command::new("ps")
            .args(["-p", &pids.join(","), "-o", "pid=,command="])
            .output()
            .ok();
        if let Some(out) = ps_out {
            let ps_text = String::from_utf8_lossy(&out.stdout);
            let cmd_map: std::collections::HashMap<u32, String> = ps_text
                .lines()
                .filter_map(|line| {
                    let trimmed = line.trim_start();
                    let space = trimmed.find(char::is_whitespace)?;
                    let pid: u32 = trimmed[..space].trim().parse().ok()?;
                    let cmd = trimmed[space..].trim().to_string();
                    Some((pid, cmd))
                })
                .collect();
            for p in &mut result {
                if let Some(cmd) = cmd_map.get(&p.pid) {
                    p.command = cmd.clone();
                }
            }
        }
    }
    result
}

#[tauri::command]
pub async fn kill_port(port: u16) -> Result<(), String> {
    // Find pid(s) bound to this port
    let ports = list_ports().await?;
    let targets: Vec<u32> = ports
        .iter()
        .filter(|p| p.port == port)
        .map(|p| p.pid)
        .collect();
    if targets.is_empty() {
        return Err(format!("no process listening on :{}", port));
    }
    for pid in targets {
        // SIGTERM first
        unsafe {
            libc_kill(pid as i32, 15);
        }
    }
    // Grace period
    std::thread::sleep(std::time::Duration::from_millis(1500));
    // Check if still alive, SIGKILL
    let still = list_ports().await?;
    for p in still.iter().filter(|p| p.port == port) {
        unsafe {
            libc_kill(p.pid as i32, 9);
        }
    }
    Ok(())
}

// Thin wrapper over libc::kill to avoid pulling nix for 2 signals.
unsafe extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lsof_output() {
        let sample = "p1234\ncnode\nn*:3000\nTST=LISTEN\np5678\ncpython\nn127.0.0.1:8000\nTST=LISTEN\n";
        let parsed = parse_lsof(sample);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].port, 3000);
        assert_eq!(parsed[0].pid, 1234);
        assert_eq!(parsed[0].process_name, "node");
        assert_eq!(parsed[1].port, 8000);
        assert_eq!(parsed[1].process_name, "python");
    }

    #[test]
    fn dedups_ipv4_ipv6() {
        let sample = "p1234\ncnode\nn*:3000\nTST=LISTEN\nn[::]:3000\nTST=LISTEN\n";
        let parsed = parse_lsof(sample);
        assert_eq!(parsed.len(), 1);
    }
}
