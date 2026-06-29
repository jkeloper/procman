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
use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

// M6: cache the listening-ports scan so bursts of `port_status_for_script`
// calls (Dashboard polls every 3s × N scripts) don't each re-shell out to
// lsof. 500ms is tight enough that a user-visible port change still lands
// within one poll cycle, loose enough to collapse the N≥5 fan-out we saw
// in health-check 08.
const LISTENING_PORTS_TTL: Duration = Duration::from_millis(500);

static LISTENING_PORTS_CACHE: std::sync::OnceLock<StdMutex<Option<(Instant, Vec<PortInfo>)>>> =
    std::sync::OnceLock::new();

fn cache_cell() -> &'static StdMutex<Option<(Instant, Vec<PortInfo>)>> {
    LISTENING_PORTS_CACHE.get_or_init(|| StdMutex::new(None))
}

// WS3: cache the per-runtime ownership snapshot (the `ps` process-tree scan
// plus the two cwd lsof calls) so a burst of read-path status/list queries
// (Dashboard polls N scripts every 3-5s) builds it at most once per TTL
// instead of once per script. Same 500ms window as the listening-ports
// cache: a freshly-bound port still surfaces within one poll cycle, but the
// O(N) fan-out of `ps`+`lsof` collapses to a single build. We store an Arc
// so the read path clones a pointer, not the whole HashMap.
const OWNERSHIP_TTL: Duration = Duration::from_millis(500);

static OWNERSHIP_CACHE: std::sync::OnceLock<StdMutex<Option<(Instant, Arc<PortOwnershipCache>)>>> =
    std::sync::OnceLock::new();

fn ownership_cache_cell() -> &'static StdMutex<Option<(Instant, Arc<PortOwnershipCache>)>> {
    OWNERSHIP_CACHE.get_or_init(|| StdMutex::new(None))
}

#[derive(Debug, Clone)]
pub(crate) struct PortOwnerRoot {
    pub root_pid: u32,
    pub project_id: String,
    pub script_id: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct PortOwnershipCache {
    pid_owner: HashMap<u32, (String, String)>,
}

impl PortOwnershipCache {
    /// Build a per-runtime-scan ownership cache with one process-tree scan
    /// and batched cwd lookups. This replaces N calls to
    /// `list_ports_for_script_pid` when the runtime snapshot/delta needs to
    /// classify every listening port.
    pub(crate) fn build(ports: &[PortInfo], roots: &[PortOwnerRoot]) -> Self {
        let mut pid_owner = HashMap::new();
        if ports.is_empty() || roots.is_empty() {
            return Self { pid_owner };
        }

        let ps_out = match Command::new("ps")
            .args(["-ax", "-o", "pid=,ppid=,pgid="])
            .output()
        {
            Ok(out) => out,
            Err(_) => return Self { pid_owner },
        };
        let text = String::from_utf8_lossy(&ps_out.stdout);
        let (pid_pgid, children) = process_ownership_maps(&text);

        for root in roots {
            for pid in collect_owned_pids(root.root_pid, &pid_pgid, &children) {
                pid_owner
                    .entry(pid)
                    .or_insert_with(|| (root.project_id.clone(), root.script_id.clone()));
            }
        }

        // Cwd matching catches detached daemons. Batch both sides so the
        // runtime snapshot pays at most two lsof calls for cwd ownership.
        let root_pids = unique_pids(roots.iter().map(|root| root.root_pid));
        let listening_pids = unique_pids(ports.iter().map(|port| port.pid));
        let root_cwds = lsof_cwds(&root_pids);
        if !root_cwds.is_empty() {
            let listening_cwds = lsof_cwds(&listening_pids);
            for root in roots {
                let Some(root_cwd) = root_cwds.get(&root.root_pid) else {
                    continue;
                };
                for (pid, cwd) in &listening_cwds {
                    if cwd == root_cwd {
                        pid_owner
                            .entry(*pid)
                            .or_insert_with(|| (root.project_id.clone(), root.script_id.clone()));
                    }
                }
            }
        }

        Self { pid_owner }
    }

    pub(crate) fn owner_for(&self, pid: u32) -> Option<&(String, String)> {
        self.pid_owner.get(&pid)
    }

    fn owned_by_script(&self, pid: u32, script_id: &str) -> bool {
        self.owner_for(pid)
            .map(|(_, owner_script_id)| owner_script_id == script_id)
            .unwrap_or(false)
    }
}

pub(crate) async fn build_port_ownership_cache(
    state: &AppState,
    pm: &ProcessManager,
    ports: &[PortInfo],
) -> PortOwnershipCache {
    let script_projects = script_project_index(state).await;
    let roots: Vec<PortOwnerRoot> = pm
        .list()
        .into_iter()
        // WS2 hardening: only Running processes are valid ownership roots.
        // A retained Crashed entry holds a dead pid the OS may have reused;
        // using it as a root could mis-attribute an unrelated process tree
        // (and its cwd-matched listeners) to the crashed script.
        .filter(|process| process.status == crate::process::RuntimeStatus::Running)
        .filter_map(|process| {
            let project_id = script_projects.get(&process.id)?;
            Some(PortOwnerRoot {
                root_pid: process.pid,
                project_id: project_id.clone(),
                script_id: process.id,
            })
        })
        .collect();
    PortOwnershipCache::build(ports, &roots)
}

/// WS3: read-path ownership snapshot with a 500ms TTL cache.
///
/// Status/list queries (`port_status_for_script`, `port_status_all`,
/// `list_ports_for_script`) tolerate a half-second-stale ownership view —
/// the listening-ports list itself is already cached on the same window.
/// Conflict checks DO NOT use this (they run right before a spawn and must
/// be fresh); they keep calling `build_port_ownership_cache` directly.
///
/// `ports` only matters on a cache miss (it feeds the cwd-matching pass). On
/// a hit we return the cached snapshot regardless, which is correct because
/// the cached snapshot was itself built from the same TTL-fresh listening
/// list.
pub(crate) async fn build_port_ownership_cache_cached(
    state: &AppState,
    pm: &ProcessManager,
    ports: &[PortInfo],
) -> Arc<PortOwnershipCache> {
    {
        if let Ok(guard) = ownership_cache_cell().lock() {
            if let Some((ts, ref cache)) = *guard {
                if ts.elapsed() < OWNERSHIP_TTL {
                    return cache.clone();
                }
            }
        }
    }
    let fresh = Arc::new(build_port_ownership_cache(state, pm, ports).await);
    if let Ok(mut guard) = ownership_cache_cell().lock() {
        *guard = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

pub(crate) async fn blocking_conflicts_for_script(
    script_id: &str,
    specs: &[PortSpec],
    state: &AppState,
    pm: &ProcessManager,
) -> Result<Vec<PortConflict>, String> {
    if specs.is_empty() {
        return Ok(Vec::new());
    }
    let listening = list_ports().await?;
    let ownership = build_port_ownership_cache(state, pm, &listening).await;
    Ok(
        build_conflicts_with_ownership(script_id, specs, &listening, &ownership)
            .into_iter()
            .filter(|conflict| conflict.severity == ConflictSeverity::Blocking)
            .collect(),
    )
}

pub(crate) fn describe_port_conflict(conflict: &PortConflict) -> String {
    format!(
        "port :{} is already used by pid {} ({})",
        conflict.spec.number, conflict.holder_pid, conflict.holder_command
    )
}

async fn script_project_index(state: &AppState) -> HashMap<String, String> {
    let guard = state.config.lock().await;
    let mut out = HashMap::new();
    for project in &guard.projects {
        for script in &project.scripts {
            out.insert(script.id.clone(), project.id.clone());
        }
    }
    out
}

#[cfg(test)]
fn clear_listening_ports_cache() {
    if let Ok(mut g) = cache_cell().lock() {
        *g = None;
    }
}

#[cfg(test)]
fn clear_ownership_cache() {
    if let Ok(mut g) = ownership_cache_cell().lock() {
        *g = None;
    }
}

#[tauri::command]
pub async fn list_ports() -> Result<Vec<PortInfo>, String> {
    // Fast path: fresh cache.
    {
        if let Ok(guard) = cache_cell().lock() {
            if let Some((ts, ref data)) = *guard {
                if ts.elapsed() < LISTENING_PORTS_TTL {
                    return Ok(data.clone());
                }
            }
        }
    }
    // -F field output: p<pid>, c<command>, n<host:port>, T<state>
    let output = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcnT"])
        .output()
        .map_err(|e| format!("lsof spawn: {}", e))?;

    if !output.status.success() {
        // lsof returns 1 when no results — treat empty stdout as empty list
        if output.stdout.is_empty() {
            if let Ok(mut g) = cache_cell().lock() {
                *g = Some((Instant::now(), Vec::new()));
            }
            return Ok(vec![]);
        }
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_lsof(&text);
    if let Ok(mut g) = cache_cell().lock() {
        *g = Some((Instant::now(), parsed.clone()));
    }
    Ok(parsed)
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
        let Some((prefix, rest)) = line.split_at_checked(1) else {
            continue;
        };
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
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    // SIGKILL only the ORIGINAL targets — never re-scan the port,
    // because a different process may have bound to it in the meantime.
    for &pid in &targets {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL); // no-op if already exited
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

    let (pid_pgid, children) = process_ownership_maps(&text);
    let mut owned = collect_owned_pids(root_pid, &pid_pgid, &children);

    // Resolve root_pid's cwd via lsof. If we get one, also include any
    // listening process whose cwd points at the same directory — this
    // is how we follow Gradle/Maven daemon JVMs that get reparented to
    // launchd. `-a` AND-combines `-p`/`-d` so we only get the cwd row.
    if let Some(root_cwd) = lsof_cwd(root_pid) {
        let listening_pids: Vec<u32> = ports.iter().map(|p| p.pid).collect();
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

fn process_ownership_maps(text: &str) -> (HashMap<u32, u32>, HashMap<u32, Vec<u32>>) {
    let mut pid_pgid: HashMap<u32, u32> = HashMap::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let pid: Option<u32> = parts.next().and_then(|s| s.parse().ok());
        let ppid: Option<u32> = parts.next().and_then(|s| s.parse().ok());
        let pgid: Option<u32> = parts.next().and_then(|s| s.parse().ok());
        if let (Some(pid), Some(ppid), Some(pgid)) = (pid, ppid, pgid) {
            pid_pgid.insert(pid, pgid);
            children.entry(ppid).or_default().push(pid);
        }
    }
    (pid_pgid, children)
}

fn collect_owned_pids(
    root_pid: u32,
    pid_pgid: &HashMap<u32, u32>,
    children: &HashMap<u32, Vec<u32>>,
) -> HashSet<u32> {
    // BFS descendants of root_pid via ppid tree.
    let mut owned: HashSet<u32> = HashSet::new();
    owned.insert(root_pid);
    let mut queue: Vec<u32> = vec![root_pid];
    while let Some(pid) = queue.pop() {
        if let Some(kids) = children.get(&pid) {
            for child in kids {
                if owned.insert(*child) {
                    queue.push(*child);
                }
            }
        }
    }

    // Union with pgid==root_pid (catches double-forked daemons).
    for (pid, pgid) in pid_pgid {
        if *pgid == root_pid {
            owned.insert(*pid);
        }
    }

    owned
}

fn unique_pids<I>(pids: I) -> Vec<u32>
where
    I: IntoIterator<Item = u32>,
{
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for pid in pids {
        if seen.insert(pid) {
            out.push(pid);
        }
    }
    out
}

/// Return the current working directory of `pid`, or None if lsof fails.
pub(crate) fn lsof_cwd(pid: u32) -> Option<String> {
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
                cfg.settings
                    .port_aliases
                    .insert(port, alias.trim().to_string());
            }
        })
        .await
        .map_err(|e| e.to_string())
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
    /// S2: TCP liveness probe result. `Some(true)` = connect succeeded,
    /// `Some(false)` = connect refused/timeout, `None` = probe skipped.
    /// Probe uses the spec's bind address (127.0.0.1 / 0.0.0.0 → 127.0.0.1 /
    /// ::1) so the answer reflects what a local client would actually see.
    pub reachable: Option<bool>,
}

/// S2: TCP probe — attempt a non-blocking connect to the declared port
/// on its bind address with a short timeout. Returns true iff the TCP
/// handshake completes. Anything else (refused, timeout, unreachable) is
/// reported as false. This is cheap (~ms on localhost) and doesn't leak
/// state: the socket is closed as soon as we know the answer.
pub async fn tcp_probe(bind: &str, port: u16, timeout_ms: u64) -> bool {
    // "0.0.0.0" listeners bind to every interface — probe loopback.
    let host: &str = match bind {
        "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        other => other,
    };
    let addr = if host.contains(':') && !host.starts_with('[') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    };
    let fut = tokio::net::TcpStream::connect(&addr);
    matches!(
        tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), fut).await,
        Ok(Ok(_))
    )
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
    // WS3: read path → cached ownership snapshot (TTL-deduped across scripts).
    let ownership = build_port_ownership_cache_cached(&state, &pm, &listening).await;
    Ok(declared_status_with_probe(&script_id, &script.ports, &listening, &ownership).await)
}

/// WS3: shared status+probe builder. Classifies each declared spec against
/// the listening snapshot + ownership view, then runs the parallel TCP
/// liveness probe. Extracted so the per-script command and the batch
/// command (`port_status_all`) compute identical results — the only
/// difference between them is how many times the ownership snapshot is built
/// (once per call vs. once per batch).
pub(crate) async fn declared_status_with_probe(
    script_id: &str,
    specs: &[PortSpec],
    listening: &[PortInfo],
    ownership: &PortOwnershipCache,
) -> Vec<DeclaredPortStatus> {
    let managed_pids: HashSet<u32> = managed_pids_for_script(script_id, listening, ownership);
    let mut statuses = build_declared_status(specs, listening, &managed_pids);
    // S2: probe each declared port in parallel. Keep timeout short (400ms)
    // so a single hung port doesn't stall the whole response.
    let probes: Vec<_> = statuses
        .iter()
        .map(|st| {
            let bind = st.spec.bind.clone();
            let port = st.spec.number;
            tokio::spawn(async move { tcp_probe(&bind, port, 400).await })
        })
        .collect();
    for (i, handle) in probes.into_iter().enumerate() {
        statuses[i].reachable = handle.await.ok();
    }
    statuses
}

/// WS3: batch status for many scripts. Builds the listening snapshot and the
/// ownership view ONCE, then classifies + probes every requested script
/// against that shared snapshot. Replaces the FE/mobile fan-out of N
/// `port_status_for_script` calls (each of which re-ran `ps` + 2× `lsof`)
/// with a single ownership build. Scripts that don't exist or have no
/// declared ports yield an empty status vector (never an error) so one bad
/// id can't sink the whole batch.
#[tauri::command]
pub async fn port_status_all(
    script_ids: Vec<String>,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Vec<(String, Vec<DeclaredPortStatus>)>, String> {
    if script_ids.is_empty() {
        return Ok(Vec::new());
    }
    // Resolve specs up front so we only hold the config lock once.
    let specs_by_id = lookup_scripts(&state, &script_ids).await;

    let listening = list_ports().await?;
    let ownership = build_port_ownership_cache_cached(&state, &pm, &listening).await;

    let mut out: Vec<(String, Vec<DeclaredPortStatus>)> = Vec::with_capacity(script_ids.len());
    for id in &script_ids {
        let statuses = match specs_by_id.get(id) {
            Some(specs) if !specs.is_empty() => {
                declared_status_with_probe(id, specs, &listening, &ownership).await
            }
            _ => Vec::new(),
        };
        out.push((id.clone(), statuses));
    }
    Ok(out)
}

/// Resolve many script_ids → their declared PortSpecs in a single config
/// lock acquisition. Missing ids are simply absent from the map.
async fn lookup_scripts(state: &AppState, script_ids: &[String]) -> HashMap<String, Vec<PortSpec>> {
    let wanted: HashSet<&str> = script_ids.iter().map(|s| s.as_str()).collect();
    let guard = state.config.lock().await;
    let mut out = HashMap::new();
    for project in &guard.projects {
        for script in &project.scripts {
            if wanted.contains(script.id.as_str()) {
                out.insert(script.id.clone(), script.ports.clone());
            }
        }
    }
    out
}

/// Called by FE / start_process right before spawning. Returns a list of
/// conflicts (empty = safe to start). `optional: true` specs still appear
/// in the result but carry `severity: warning` so the UI can offer a skip
/// checkbox instead of a hard block.
#[tauri::command]
pub async fn check_port_conflicts(
    script_id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Vec<PortConflict>, String> {
    let (_proj_id, script) = lookup_script(&state, &script_id)
        .await
        .ok_or_else(|| format!("script not found: {}", script_id))?;
    if script.ports.is_empty() {
        return Ok(Vec::new());
    }
    let listening = list_ports().await?;
    let ownership = build_port_ownership_cache(&state, &pm, &listening).await;
    Ok(build_conflicts_with_ownership(
        &script_id,
        &script.ports,
        &listening,
        &ownership,
    ))
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
    // WS3: read path → cached ownership snapshot.
    let ownership = build_port_ownership_cache_cached(&state, &pm, &all).await;
    Ok(list_ports_for_script_from_snapshot(
        &script_id,
        &script.ports,
        &all,
        &ownership,
    ))
}

pub(crate) fn list_ports_for_script_from_snapshot(
    script_id: &str,
    specs: &[PortSpec],
    all: &[PortInfo],
    ownership: &PortOwnershipCache,
) -> Vec<PortInfo> {
    let by_port: HashMap<u16, PortInfo> = all.iter().map(|p| (p.port, p.clone())).collect();

    let mut seen: std::collections::HashSet<u16> = std::collections::HashSet::new();
    let mut out: Vec<PortInfo> = Vec::new();

    // Declared first, in declaration order.
    for spec in specs {
        if let Some(info) = by_port.get(&spec.number) {
            if seen.insert(spec.number) {
                out.push(info.clone());
            }
        }
    }

    // Append every live port that the shared ownership cache attributes
    // to this script, even if it was not declared.
    for info in all {
        if ownership.owned_by_script(info.pid, script_id) && seen.insert(info.port) {
            out.push(info.clone());
        }
    }

    out
}

/// S1: Pure helper used by unit tests.
/// Compares a set of declared PortSpecs against a listing snapshot and
/// builds the resulting PortConflict vector. Kept pure so the test
/// harness doesn't need a live `lsof` or Tauri state.
#[cfg(test)]
pub(crate) fn build_conflicts(specs: &[PortSpec], listening: &[PortInfo]) -> Vec<PortConflict> {
    let lookup: HashMap<u16, &PortInfo> = listening.iter().map(|p| (p.port, p)).collect();
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

pub(crate) fn build_conflicts_with_ownership(
    script_id: &str,
    specs: &[PortSpec],
    listening: &[PortInfo],
    ownership: &PortOwnershipCache,
) -> Vec<PortConflict> {
    let lookup: HashMap<u16, &PortInfo> = listening.iter().map(|p| (p.port, p)).collect();
    let mut out = Vec::new();
    for spec in specs {
        if let Some(info) = lookup.get(&spec.number) {
            if ownership.owned_by_script(info.pid, script_id) {
                continue;
            }
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

pub(crate) fn managed_pids_for_script(
    script_id: &str,
    listening: &[PortInfo],
    ownership: &PortOwnershipCache,
) -> HashSet<u32> {
    listening
        .iter()
        .filter(|info| ownership.owned_by_script(info.pid, script_id))
        .map(|info| info.pid)
        .collect()
}

/// S1: Pure helper for `port_status_for_script`. `managed_pids` is the
/// set of pids that the caller considers "ours" (derived from the
/// descendant scanner when the script is running, empty otherwise).
pub(crate) fn build_declared_status(
    specs: &[PortSpec],
    listening: &[PortInfo],
    managed_pids: &std::collections::HashSet<u32>,
) -> Vec<DeclaredPortStatus> {
    let lookup: HashMap<u16, &PortInfo> = listening.iter().map(|p| (p.port, p)).collect();
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
                reachable: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, number: u16, optional: bool) -> PortSpec {
        PortSpec {
            name: name.into(),
            number,
            bind: "127.0.0.1".into(),
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
    fn build_conflicts_with_ownership_skips_same_script_owner() {
        let specs = vec![spec("http", 8080, false)];
        let listing = vec![info(8080, 42, "node server.js")];
        let mut ownership = PortOwnershipCache::default();
        ownership.pid_owner.insert(42, ("p1".into(), "s1".into()));

        assert!(build_conflicts_with_ownership("s1", &specs, &listing, &ownership).is_empty());

        let conflicts = build_conflicts_with_ownership("s2", &specs, &listing, &ownership);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].severity, ConflictSeverity::Blocking);
    }

    #[test]
    fn list_ports_for_script_includes_owned_undeclared_ports_after_declared() {
        let specs = vec![spec("http", 8080, false)];
        let listing = vec![
            info(9000, 42, "node sidecar"),
            info(8080, 42, "node main"),
            info(7000, 99, "other"),
        ];
        let mut ownership = PortOwnershipCache::default();
        ownership.pid_owner.insert(42, ("p1".into(), "s1".into()));
        ownership.pid_owner.insert(99, ("p1".into(), "s2".into()));

        let out = list_ports_for_script_from_snapshot("s1", &specs, &listing, &ownership);
        assert_eq!(
            out.iter().map(|info| info.port).collect::<Vec<_>>(),
            vec![8080, 9000]
        );
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
    fn ownership_maps_collect_ppid_descendants_and_pgid_members() {
        let ps = "\
100   1   100
101 100   100
102 101   102
200   1   100
300   1   300
";
        let (pid_pgid, children) = process_ownership_maps(ps);
        let owned = collect_owned_pids(100, &pid_pgid, &children);
        assert!(owned.contains(&100));
        assert!(owned.contains(&101));
        assert!(owned.contains(&102));
        assert!(owned.contains(&200));
        assert!(!owned.contains(&300));
    }

    #[test]
    fn parses_lsof_output() {
        let sample =
            "p1234\ncnode\nn*:3000\nTST=LISTEN\np5678\ncpython\nn127.0.0.1:8000\nTST=LISTEN\n";
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

    // --- S2: TCP liveness probe ---

    #[tokio::test]
    async fn tcp_probe_refused_on_closed_port() {
        // Port 1 is reserved and not listening on a dev mac. Probe
        // should return false (connection refused / timeout).
        let ok = tcp_probe("127.0.0.1", 1, 200).await;
        assert!(!ok);
    }

    #[tokio::test]
    async fn tcp_probe_succeeds_on_live_listener() {
        // Bind an ephemeral listener and probe it.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let port = addr.port();
        // Keep the listener alive by spawning an accept loop that
        // ignores the incoming connection.
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        let ok = tcp_probe("127.0.0.1", port, 500).await;
        assert!(
            ok,
            "probe should succeed against a live listener on :{}",
            port
        );
    }

    #[test]
    fn build_declared_status_sets_reachable_none_initially() {
        // S2 invariant: build_declared_status never fills reachable.
        // Reachable gets populated by the command layer after probe.
        let specs = vec![spec("http", 8080, false)];
        let listing = vec![info(8080, 42, "node")];
        let mut mp = std::collections::HashSet::new();
        mp.insert(42);
        let out = build_declared_status(&specs, &listing, &mp);
        assert!(out[0].reachable.is_none());
    }

    #[tokio::test]
    async fn list_ports_uses_cache_within_ttl() {
        // M6: two back-to-back calls within TTL share the same cache row
        // — verifiable by observing the cache contents. We don't spy on
        // lsof itself (it's a real system call), but we can assert that
        // the cache slot is populated after the first call and still
        // present on the second.
        clear_listening_ports_cache();
        let _ = list_ports().await.unwrap();
        let cached_first = {
            let g = cache_cell().lock().unwrap();
            g.clone()
        };
        assert!(
            cached_first.is_some(),
            "cache should be populated after first call"
        );
        let (ts_first, _) = cached_first.unwrap();
        // Second call immediately — cache must be reused, so the
        // timestamp doesn't advance.
        let _ = list_ports().await.unwrap();
        let cached_second = {
            let g = cache_cell().lock().unwrap();
            g.clone()
        };
        let (ts_second, _) = cached_second.unwrap();
        assert_eq!(ts_first, ts_second, "TTL-fresh call must not re-scan lsof");
    }

    #[tokio::test]
    async fn tcp_probe_maps_zero_bind_to_loopback() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        // "0.0.0.0" must be rewritten to 127.0.0.1 before connect.
        let ok = tcp_probe("0.0.0.0", port, 500).await;
        assert!(ok);
    }

    // --- WS3: ownership snapshot caching ---

    #[test]
    fn ownership_cache_hit_within_ttl_returns_same_arc() {
        // Seed the cell with a known snapshot and assert a fresh read inside
        // the TTL window hands back the SAME Arc (pointer-identical), proving
        // the read path skipped the ps/lsof rebuild.
        clear_ownership_cache();
        let mut cache = PortOwnershipCache::default();
        cache.pid_owner.insert(42, ("p1".into(), "s1".into()));
        let seeded = Arc::new(cache);
        {
            let mut g = ownership_cache_cell().lock().unwrap();
            *g = Some((Instant::now(), seeded.clone()));
        }
        // Simulate the read-path's hit branch.
        let got = {
            let g = ownership_cache_cell().lock().unwrap();
            let (ts, ref c) = g.as_ref().unwrap();
            assert!(ts.elapsed() < OWNERSHIP_TTL);
            c.clone()
        };
        assert!(Arc::ptr_eq(&seeded, &got));
        assert_eq!(got.owner_for(42), Some(&("p1".into(), "s1".into())));
        clear_ownership_cache();
    }

    #[test]
    fn ownership_cache_expires_after_ttl() {
        // A snapshot stamped older than the TTL must be treated as a miss.
        clear_ownership_cache();
        let seeded = Arc::new(PortOwnershipCache::default());
        let stale_ts = Instant::now() - (OWNERSHIP_TTL + Duration::from_millis(50));
        {
            let mut g = ownership_cache_cell().lock().unwrap();
            *g = Some((stale_ts, seeded));
        }
        let fresh = {
            let g = ownership_cache_cell().lock().unwrap();
            !matches!(g.as_ref(), Some((ts, _)) if ts.elapsed() < OWNERSHIP_TTL)
        };
        assert!(fresh, "snapshot older than TTL must register as a miss");
        clear_ownership_cache();
    }

    /// WS3: the batch path and the per-script path must classify identically
    /// against the same snapshot. We exercise the shared inner builders
    /// (`build_declared_status` over `managed_pids_for_script`) that both
    /// `declared_status_with_probe` and `port_status_for_script` route
    /// through, so equivalence is structural, not a re-derivation.
    #[test]
    fn batch_and_per_script_share_classification() {
        let specs_s1 = vec![spec("http", 8080, false)];
        let specs_s2 = vec![spec("api", 9090, false)];
        let listing = vec![info(8080, 42, "node main"), info(9090, 99, "uvicorn")];
        let mut ownership = PortOwnershipCache::default();
        ownership.pid_owner.insert(42, ("p1".into(), "s1".into()));
        ownership.pid_owner.insert(99, ("p1".into(), "s2".into()));

        // Per-script derivation for s1.
        let mp_s1 = managed_pids_for_script("s1", &listing, &ownership);
        let per_s1 = build_declared_status(&specs_s1, &listing, &mp_s1);
        // Same inputs, as the batch loop would feed them.
        let mp_s1_batch = managed_pids_for_script("s1", &listing, &ownership);
        let batch_s1 = build_declared_status(&specs_s1, &listing, &mp_s1_batch);

        assert_eq!(per_s1.len(), 1);
        assert_eq!(per_s1[0].state, PortState::ListeningManaged);
        assert_eq!(per_s1[0].state, batch_s1[0].state);
        assert_eq!(per_s1[0].owned_by_script, batch_s1[0].owned_by_script);
        assert_eq!(per_s1[0].holder_pid, batch_s1[0].holder_pid);

        // s2 sees 9090 managed, 8080 owned by s1 → not present in its specs.
        let mp_s2 = managed_pids_for_script("s2", &listing, &ownership);
        let per_s2 = build_declared_status(&specs_s2, &listing, &mp_s2);
        assert_eq!(per_s2[0].state, PortState::ListeningManaged);
        assert_eq!(per_s2[0].holder_pid, Some(99));
    }
}
