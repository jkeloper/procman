// Port scanner — parse `lsof` output on macOS.
//
// LEARN (systems calls from Rust):
//   - macOS has no stable port→pid API. We shell out to
//     `lsof -nP -iTCP -sTCP:LISTEN -F pPcnT` which produces a machine-parseable
//     record format: fields prefixed with letters, records separated by newlines.
//   - std::process::Command (sync) is fine for one-shot calls like lsof.
//   - `kill` goes through `libc::kill(pid, sig)` — we hand-roll it to avoid
//     pulling the nix crate just for two signal constants.

use crate::process::ProcessManager;
use crate::state::AppState;
use crate::types::{PortInfo, PortSpec};
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;

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
    let ports = list_ports().await?;
    let targets: Vec<u32> = ports
        .iter()
        .filter(|p| p.port == port)
        .map(|p| p.pid)
        .collect();
    if targets.is_empty() {
        return Err(format!("no process listening on :{}", port));
    }
    for &pid in &targets {
        unsafe {
            libc_kill(pid as i32, 15); // SIGTERM
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    // SIGKILL only the ORIGINAL targets — never re-scan the port,
    // because a different process may have bound to it in the meantime.
    for &pid in &targets {
        unsafe {
            libc_kill(pid as i32, 9); // SIGKILL (no-op if already exited)
        }
    }
    Ok(())
}

/// Given a list of root pids (the wrapper shells procman spawned),
/// return every pid whose pgid is one of those roots. This is the
/// full set of descendants because procman spawns scripts with
/// `process_group(0)`, making the wrapper its own group leader.
///
/// Used by the Dashboard to mark listening ports as "managed" even
/// when the bound pid is a grandchild (the actual uvicorn / vite /
/// next-server process) rather than the wrapper.
#[tauri::command]
pub async fn list_descendant_pids(root_pids: Vec<u32>) -> Result<Vec<u32>, String> {
    if root_pids.is_empty() {
        return Ok(vec![]);
    }
    let root_set: std::collections::HashSet<u32> = root_pids.iter().copied().collect();
    let ps_out = Command::new("ps")
        .args(["-ax", "-o", "pid=,pgid="])
        .output()
        .map_err(|e| format!("ps: {}", e))?;
    let text = String::from_utf8_lossy(&ps_out.stdout);
    let mut result: Vec<u32> = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let pid: Option<u32> = parts.next().and_then(|s| s.parse().ok());
        let pgid: Option<u32> = parts.next().and_then(|s| s.parse().ok());
        if let (Some(pid), Some(pgid)) = (pid, pgid) {
            if root_set.contains(&pgid) {
                result.push(pid);
            }
        }
    }
    Ok(result)
}

/// Find all listening ports owned by descendants of `root_pid`.
///
/// Three membership tests are unioned because individual tools break
/// each one in different ways:
///
/// 1. **pgid match** — procman spawns scripts with `process_group(0)`, so
///    the wrapper PID is the pgid leader. Most direct children inherit
///    the pgid. Catches normal `node`/`python`/`go run` cases.
/// 2. **ppid descent** — wrappers like `concurrently`, `nodemon`, or any
///    helper that calls `setsid()` will start their server in a fresh
///    process group, defeating the pgid test. Walking the parent→child
///    tree from `root_pid` catches those.
/// 3. **cwd match** — daemon-style runners (Gradle, Maven daemon, sbt,
///    bazel) spawn the actual server JVM under launchd, completely
///    detached from procman's tree AND group. They still share the
///    project's working directory though. We resolve `root_pid`'s cwd
///    via `lsof` and tag any listening process whose cwd points at the
///    same directory.
#[tauri::command]
pub async fn list_ports_for_script_pid(root_pid: u32) -> Result<Vec<PortInfo>, String> {
    let ports = list_ports().await?;
    if ports.is_empty() {
        return Ok(vec![]);
    }

    // Single ps call yields pid, ppid, pgid for everything.
    let ps_out = Command::new("ps")
        .args(["-ax", "-o", "pid=,ppid=,pgid="])
        .output()
        .map_err(|e| format!("ps: {}", e))?;
    let text = String::from_utf8_lossy(&ps_out.stdout);

    let mut pid_ppid: HashMap<u32, u32> = HashMap::new();
    let mut pid_pgid: HashMap<u32, u32> = HashMap::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let pid: Option<u32> = parts.next().and_then(|s| s.parse().ok());
        let ppid: Option<u32> = parts.next().and_then(|s| s.parse().ok());
        let pgid: Option<u32> = parts.next().and_then(|s| s.parse().ok());
        if let (Some(pid), Some(ppid), Some(pgid)) = (pid, ppid, pgid) {
            pid_ppid.insert(pid, ppid);
            pid_pgid.insert(pid, pgid);
            children.entry(ppid).or_default().push(pid);
        }
    }

    // BFS descendants of root_pid via ppid tree.
    let mut owned: std::collections::HashSet<u32> = std::collections::HashSet::new();
    owned.insert(root_pid);
    let mut queue: Vec<u32> = vec![root_pid];
    while let Some(p) = queue.pop() {
        if let Some(kids) = children.get(&p) {
            for k in kids {
                if owned.insert(*k) {
                    queue.push(*k);
                }
            }
        }
    }

    // Union with pgid==root_pid (catches double-forked daemons).
    for (pid, pgid) in pid_pgid.iter() {
        if *pgid == root_pid {
            owned.insert(*pid);
        }
    }

    // Resolve root_pid's cwd via lsof. If we get one, also include any
    // listening process whose cwd points at the same directory — this
    // is how we follow Gradle/Maven daemon JVMs that get reparented to
    // launchd. `-a` AND-combines `-p`/`-d` so we only get the cwd row.
    if let Some(root_cwd) = lsof_cwd(root_pid) {
        let listening_pids: Vec<u32> =
            ports.iter().map(|p| p.pid).collect();
        let cwds = lsof_cwds(&listening_pids);
        for (pid, cwd) in cwds {
            if cwd == root_cwd {
                owned.insert(pid);
            }
        }
    }

    let mut matched: Vec<PortInfo> = ports
        .into_iter()
        .filter(|p| owned.contains(&p.pid))
        .collect();
    matched.sort_by_key(|p| p.port);
    Ok(matched)
}

/// Return the current working directory of `pid`, or None if lsof fails.
fn lsof_cwd(pid: u32) -> Option<String> {
    let out = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-F", "n"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix('n') {
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    None
}

/// Batch-resolve cwd for many pids in a single lsof call.
fn lsof_cwds(pids: &[u32]) -> HashMap<u32, String> {
    let mut out_map = HashMap::new();
    if pids.is_empty() {
        return out_map;
    }
    // lsof -p accepts comma-separated pids.
    let pid_list = pids
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let out = match Command::new("lsof")
        .args(["-a", "-p", &pid_list, "-d", "cwd", "-F", "pn"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return out_map,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut cur_pid: Option<u32> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            cur_pid = rest.parse().ok();
        } else if let Some(rest) = line.strip_prefix('n') {
            if let Some(pid) = cur_pid {
                if !rest.is_empty() {
                    out_map.insert(pid, rest.to_string());
                }
            }
        }
    }
    out_map
}

/// Get all port aliases.
#[tauri::command]
pub async fn get_port_aliases(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
) -> Result<std::collections::HashMap<u16, String>, String> {
    let guard = state.config.lock().await;
    Ok(guard.settings.port_aliases.clone())
}

/// Set alias for a port. Empty alias removes it.
#[tauri::command]
pub async fn set_port_alias(
    port: u16,
    alias: String,
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
) -> Result<(), String> {
    state
        .mutate(|cfg| {
            if alias.trim().is_empty() {
                cfg.settings.port_aliases.remove(&port);
            } else {
                cfg.settings.port_aliases.insert(port, alias.trim().to_string());
            }
        })
        .await
        .map_err(|e| e.to_string())
}

// Thin wrapper over libc::kill to avoid pulling nix for 2 signals.
unsafe extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

// ----------------------------------------------------------------------
// S1: Declared port status + conflict detection + tunnel-oriented lookup
// ----------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortState {
    /// Nothing listening. Script is not running, or hasn't bound yet.
    Free,
    /// Listening, and holder is in this script's pid tree / pgid / cwd.
    ListeningManaged,
    /// Listening, but holder is an unrelated process. (Conflict if script
    /// is about to start; "stolen" if script is already running.)
    TakenByOther,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeclaredPortStatus {
    pub spec: PortSpec,
    pub state: PortState,
    pub holder_pid: Option<u32>,
    pub holder_command: Option<String>,
    pub owned_by_script: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictSeverity {
    Blocking,
    Warning,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortConflict {
    pub spec: PortSpec,
    pub holder_pid: u32,
    pub holder_command: String,
    pub severity: ConflictSeverity,
}

/// Resolve (project_id, script_id) → Script clone from shared config.
async fn lookup_script(
    state: &AppState,
    script_id: &str,
) -> Option<(String, crate::types::Script)> {
    let guard = state.config.lock().await;
    for project in &guard.projects {
        for script in &project.scripts {
            if script.id == script_id {
                return Some((project.id.clone(), script.clone()));
            }
        }
    }
    None
}

/// Compute the set of ports listed on the wire and classify each declared
/// spec. Managed-ness is determined via the existing descendant scanner
/// (`list_ports_for_script_pid`) keyed by the currently running wrapper pid,
/// if any. When the script isn't running we can still surface Free vs
/// TakenByOther, which is what the Dashboard needs.
#[tauri::command]
pub async fn port_status_for_script(
    script_id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Vec<DeclaredPortStatus>, String> {
    let (_proj_id, script) = lookup_script(&state, &script_id)
        .await
        .ok_or_else(|| format!("script not found: {}", script_id))?;

    if script.ports.is_empty() {
        return Ok(Vec::new());
    }

    let listening = list_ports().await?;
    // If running, fetch the set of pids considered "ours" for managed vs other.
    let managed_pids: std::collections::HashSet<u32> = match pm
        .list()
        .into_iter()
        .find(|s| s.id == script_id)
    {
        Some(snap) => list_ports_for_script_pid(snap.pid)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.pid)
            .collect(),
        None => std::collections::HashSet::new(),
    };

    Ok(build_declared_status(&script.ports, &listening, &managed_pids))
}

/// Called by FE / start_process right before spawning. Returns a list of
/// conflicts (empty = safe to start). `optional: true` specs still appear
/// in the result but carry `severity: warning` so the UI can offer a skip
/// checkbox instead of a hard block.
#[tauri::command]
pub async fn check_port_conflicts(
    script_id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<PortConflict>, String> {
    let (_proj_id, script) = lookup_script(&state, &script_id)
        .await
        .ok_or_else(|| format!("script not found: {}", script_id))?;
    if script.ports.is_empty() {
        return Ok(Vec::new());
    }
    let listening = list_ports().await?;
    Ok(build_conflicts(&script.ports, &listening))
}

/// Return every listening port associated with this script, via the union
/// of (declared ∪ descendant) as chosen in S1 Q4. Declared ports come
/// first (stable order by declaration), descendants follow. Entries are
/// deduped by port number, preferring the declared record.
#[tauri::command]
pub async fn list_ports_for_script(
    script_id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Vec<PortInfo>, String> {
    let (_proj_id, script) = lookup_script(&state, &script_id)
        .await
        .ok_or_else(|| format!("script not found: {}", script_id))?;

    let all = list_ports().await?;
    let by_port: HashMap<u16, PortInfo> =
        all.iter().map(|p| (p.port, p.clone())).collect();

    let mut seen: std::collections::HashSet<u16> = std::collections::HashSet::new();
    let mut out: Vec<PortInfo> = Vec::new();

    // Declared first, in declaration order.
    for spec in &script.ports {
        if let Some(info) = by_port.get(&spec.number) {
            if seen.insert(spec.number) {
                out.push(info.clone());
            }
        }
    }

    // Append descendants from the existing heuristic, if running.
    if let Some(snap) = pm.list().into_iter().find(|s| s.id == script_id) {
        match list_ports_for_script_pid(snap.pid).await {
            Ok(v) => {
                for info in v {
                    if seen.insert(info.port) {
                        out.push(info);
                    }
                }
            }
            Err(_) => {}
        }
    }

    Ok(out)
}


/// S1: Pure helper used by unit tests and `check_port_conflicts`.
/// Compares a set of declared PortSpecs against a listing snapshot and
/// builds the resulting PortConflict vector. Kept pure so the test
/// harness doesn't need a live `lsof` or Tauri state.
pub(crate) fn build_conflicts(specs: &[PortSpec], listening: &[PortInfo]) -> Vec<PortConflict> {
    let lookup: HashMap<u16, &PortInfo> =
        listening.iter().map(|p| (p.port, p)).collect();
    let mut out = Vec::new();
    for spec in specs {
        if let Some(info) = lookup.get(&spec.number) {
            out.push(PortConflict {
                spec: spec.clone(),
                holder_pid: info.pid,
                holder_command: info.command.clone(),
                severity: if spec.optional {
                    ConflictSeverity::Warning
                } else {
                    ConflictSeverity::Blocking
                },
            });
        }
    }
    out
}

/// S1: Pure helper for `port_status_for_script`. `managed_pids` is the
/// set of pids that the caller considers "ours" (derived from the
/// descendant scanner when the script is running, empty otherwise).
pub(crate) fn build_declared_status(
    specs: &[PortSpec],
    listening: &[PortInfo],
    managed_pids: &std::collections::HashSet<u32>,
) -> Vec<DeclaredPortStatus> {
    let lookup: HashMap<u16, &PortInfo> =
        listening.iter().map(|p| (p.port, p)).collect();
    specs
        .iter()
        .map(|spec| {
            let pi = lookup.get(&spec.number);
            let (state_tag, holder_pid, holder_cmd, owned) = match pi {
                None => (PortState::Free, None, None, false),
                Some(info) => {
                    if managed_pids.contains(&info.pid) {
                        (
                            PortState::ListeningManaged,
                            Some(info.pid),
                            Some(info.command.clone()),
                            true,
                        )
                    } else {
                        (
                            PortState::TakenByOther,
                            Some(info.pid),
                            Some(info.command.clone()),
                            false,
                        )
                    }
                }
            };
            DeclaredPortStatus {
                spec: spec.clone(),
                state: state_tag,
                holder_pid,
                holder_command: holder_cmd,
                owned_by_script: owned,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PortProto;

    fn spec(name: &str, number: u16, optional: bool) -> PortSpec {
        PortSpec {
            name: name.into(),
            number,
            bind: "127.0.0.1".into(),
            proto: PortProto::Tcp,
            optional,
            note: None,
        }
    }

    fn info(port: u16, pid: u32, cmd: &str) -> PortInfo {
        PortInfo {
            port,
            pid,
            process_name: cmd.into(),
            command: cmd.into(),
        }
    }

    #[test]
    fn build_conflicts_flags_blocking_and_warning() {
        let specs = vec![
            spec("http", 8080, false),
            spec("debug", 5005, false),
            spec("metrics", 9010, true),
        ];
        let listing = vec![
            info(8080, 111, "python -m http.server"),
            info(9010, 222, "prom-exporter"),
            // 5005 free
        ];
        let c = build_conflicts(&specs, &listing);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].spec.name, "http");
        assert_eq!(c[0].severity, ConflictSeverity::Blocking);
        assert_eq!(c[1].spec.name, "metrics");
        assert_eq!(c[1].severity, ConflictSeverity::Warning);
    }

    #[test]
    fn build_conflicts_empty_when_all_free() {
        let specs = vec![spec("http", 8080, false)];
        let listing: Vec<PortInfo> = Vec::new();
        assert!(build_conflicts(&specs, &listing).is_empty());
    }

    #[test]
    fn build_status_free_when_not_listening() {
        let specs = vec![spec("http", 8080, false)];
        let listing: Vec<PortInfo> = Vec::new();
        let mp = std::collections::HashSet::new();
        let out = build_declared_status(&specs, &listing, &mp);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].state, PortState::Free);
        assert!(!out[0].owned_by_script);
    }

    #[test]
    fn build_status_managed_when_pid_in_set() {
        let specs = vec![spec("http", 8080, false)];
        let listing = vec![info(8080, 42, "node server.js")];
        let mut mp = std::collections::HashSet::new();
        mp.insert(42);
        let out = build_declared_status(&specs, &listing, &mp);
        assert_eq!(out[0].state, PortState::ListeningManaged);
        assert!(out[0].owned_by_script);
        assert_eq!(out[0].holder_pid, Some(42));
    }

    #[test]
    fn build_status_taken_by_other_when_unrelated_pid() {
        let specs = vec![spec("http", 8080, false)];
        let listing = vec![info(8080, 999, "squatter")];
        let mp = std::collections::HashSet::new();
        let out = build_declared_status(&specs, &listing, &mp);
        assert_eq!(out[0].state, PortState::TakenByOther);
        assert!(!out[0].owned_by_script);
    }

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
