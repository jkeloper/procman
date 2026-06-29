// Group CRUD + batch-run (T19).
//
// LEARN (ordered, readiness-gated launches — WS5):
//   - Group members start in `depends_on` topological order (via the shared
//     `resolve_dep_order` engine), and each member with declared deps is
//     readiness-gated through `wait_for_dependencies` before its spawn. This
//     replaced the old blind 400ms inter-launch sleep: the gate *is* the
//     readiness signal, so independent members start immediately.
//   - Launch errors DON'T abort the group — we return a list of (member,
//     result) tuples so the UI can show partial success.

use crate::process::ProcessManager;
use crate::state::AppState;
use crate::types::{Group, GroupMember};
use serde::Serialize;
use std::sync::Arc;
use uuid::Uuid;

#[tauri::command]
pub async fn list_groups(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<Group>, String> {
    let guard = state.config.lock().await;
    Ok(guard.groups.clone())
}

#[tauri::command]
pub async fn create_group(
    name: String,
    members: Vec<GroupMember>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Group, String> {
    if name.trim().is_empty() {
        return Err("name cannot be empty".into());
    }
    let group = Group {
        id: Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        members,
    };
    let to_return = group.clone();
    state
        .mutate(|cfg| cfg.groups.push(group))
        .await
        .map_err(|e| e.to_string())?;
    Ok(to_return)
}

#[tauri::command]
pub async fn update_group(
    id: String,
    name: Option<String>,
    members: Option<Vec<GroupMember>>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Group, String> {
    let result = state
        .mutate(|cfg| {
            let g = cfg.groups.iter_mut().find(|g| g.id == id)?;
            if let Some(n) = name {
                g.name = n.trim().to_string();
            }
            if let Some(m) = members {
                g.members = m;
            }
            Some(g.clone())
        })
        .await
        .map_err(|e| e.to_string())?;
    result.ok_or_else(|| format!("group not found: {}", id))
}

#[tauri::command]
pub async fn delete_group(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let removed = state
        .mutate(|cfg| {
            let before = cfg.groups.len();
            cfg.groups.retain(|g| g.id != id);
            before != cfg.groups.len()
        })
        .await
        .map_err(|e| e.to_string())?;
    if !removed {
        return Err(format!("group not found: {}", id));
    }
    Ok(())
}

/// WS5: decide the start order for a group's members. Topologically sorts by
/// `depends_on` via the shared `resolve_dep_order` engine; on a cycle inside
/// the group it falls back to the snapshot (config) order so the group still
/// makes forward progress (each member's readiness gate then sorts out timing).
pub(crate) fn group_launch_order(member_scripts: &[crate::types::Script]) -> Vec<String> {
    crate::commands::session::resolve_dep_order(member_scripts)
        .unwrap_or_else(|_| member_scripts.iter().map(|s| s.id.clone()).collect())
}

#[derive(Serialize)]
pub struct GroupRunResult {
    pub project_id: String,
    pub script_id: String,
    pub ok: bool,
    pub error: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Serialize)]
pub struct GroupStopResult {
    pub project_id: String,
    pub script_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn run_group(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Vec<GroupRunResult>, String> {
    run_group_core(&id, &state, &pm).await
}

/// WS8: the group batch-run algorithm, decoupled from the Tauri command
/// wrapper so the remote server route (`POST /api/groups/:id/run`) can reuse
/// the exact same ordering / readiness-gating / partial-success behaviour as
/// the desktop. Both callers funnel through here, so the desktop and the
/// phone always launch a group identically.
pub(crate) async fn run_group_core(
    id: &str,
    state: &AppState,
    pm: &ProcessManager,
) -> Result<Vec<GroupRunResult>, String> {
    // Snapshot members + their scripts/cwd first to avoid holding the lock.
    let members: Vec<(String, String, crate::types::Script, String)> = {
        let guard = state.config.lock().await;
        let Some(g) = guard.groups.iter().find(|g| g.id == id) else {
            return Err(format!("group not found: {}", id));
        };
        g.members
            .iter()
            .filter_map(|m| {
                let proj = guard.projects.iter().find(|p| p.id == m.project_id)?;
                let script = proj.scripts.iter().find(|s| s.id == m.script_id)?.clone();
                Some((
                    m.project_id.clone(),
                    m.script_id.clone(),
                    script,
                    proj.path.clone(),
                ))
            })
            .collect()
    };

    // WS5: order members by their depends_on graph (single ordering engine,
    // shared with the session-restore path) instead of the old blind 400ms
    // inter-launch sleep. A cycle inside the group is non-fatal: we fall back
    // to the snapshot order and let each member's readiness gate sort it out
    // (each spawn is independently correct).
    let member_scripts: Vec<crate::types::Script> =
        members.iter().map(|(_, _, s, _)| s.clone()).collect();
    // WS5 hardening: only gate a member on deps that are *also in this group*.
    // `resolve_dep_order` already scopes ordering to group members, so the
    // readiness gate must scope the same way — otherwise a member that
    // depends on a script OUTSIDE the group would make the sequential loop
    // wait up to 30s for that external dep, stalling every later member
    // (a regression vs. the old fixed 400ms sleep). External deps are the
    // user's concern, not the group launch's.
    let group_member_ids: std::collections::HashSet<String> =
        member_scripts.iter().map(|s| s.id.clone()).collect();
    let ordered_ids = group_launch_order(&member_scripts);
    // Index members by script_id so we can iterate in topological order.
    let mut by_id: std::collections::HashMap<
        String,
        (String, String, crate::types::Script, String),
    > = members.into_iter().map(|m| (m.1.clone(), m)).collect();

    let mut out = Vec::new();
    for sid in ordered_ids {
        let Some((project_id, script_id, script, cwd)) = by_id.remove(&sid) else {
            continue;
        };
        let res = match crate::commands::port::blocking_conflicts_for_script(
            &script.id,
            &script.ports,
            state,
            pm,
        )
        .await
        {
            Ok(conflicts) => match conflicts.first() {
                Some(conflict) => Err(crate::commands::port::describe_port_conflict(conflict)),
                None => {
                    // WS5: readiness-gate on this member's *in-group* deps
                    // before spawning (replaces the blind sleep). Deps outside
                    // the group are intentionally NOT waited on here so one
                    // external dependency can't stall the whole sequential
                    // launch for 30s. Independent members fall straight
                    // through with no wait.
                    let intra_group_deps: Vec<String> = script
                        .depends_on
                        .iter()
                        .filter(|d| group_member_ids.contains(*d))
                        .cloned()
                        .collect();
                    let gate = if intra_group_deps.is_empty() {
                        Ok(())
                    } else {
                        crate::commands::process::wait_for_dependencies(
                            state,
                            pm,
                            &intra_group_deps,
                        )
                        .await
                    };
                    match gate {
                        Ok(()) => pm.spawn(&script, Some(cwd)).await,
                        Err(e) => Err(e),
                    }
                }
            },
            Err(e) => Err(e),
        };
        out.push(match res {
            Ok(pid) => GroupRunResult {
                project_id,
                script_id,
                ok: true,
                error: None,
                pid: Some(pid),
            },
            Err(e) => GroupRunResult {
                project_id,
                script_id,
                ok: false,
                error: Some(e),
                pid: None,
            },
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn stop_group(
    id: String,
    state: tauri::State<'_, Arc<AppState>>,
    pm: tauri::State<'_, ProcessManager>,
    runtime: tauri::State<'_, Arc<crate::runtime_state::RuntimeStore>>,
) -> Result<Vec<GroupStopResult>, String> {
    let (timeout_ms, mut members): (u64, Vec<(String, String)>) = {
        let guard = state.config.lock().await;
        let Some(g) = guard.groups.iter().find(|g| g.id == id) else {
            return Err(format!("group not found: {}", id));
        };
        let members = g
            .members
            .iter()
            .filter_map(|m| {
                let project = guard.projects.iter().find(|p| p.id == m.project_id)?;
                let script = project.scripts.iter().find(|s| s.id == m.script_id)?;
                Some((m.project_id.clone(), script.id.clone()))
            })
            .collect();
        (
            crate::types::clamp_shutdown_timeout_ms(guard.settings.shutdown_timeout_ms),
            members,
        )
    };

    // Stop in reverse launch order so dependency-style groups unwind cleanly.
    members.reverse();
    let mut out = Vec::with_capacity(members.len());
    for (project_id, script_id) in members {
        let result = pm.kill_with_timeout(&script_id, timeout_ms).await;
        // WS5: user-explicit group stop — drop each member from the
        // session-restore set (kill() leaves last_running untouched on purpose).
        runtime.mark_running(&script_id, false).await;
        out.push(match result {
            Ok(()) => GroupStopResult {
                project_id,
                script_id,
                ok: true,
                error: None,
            },
            Err(e) => GroupStopResult {
                project_id,
                script_id,
                ok: false,
                error: Some(e),
            },
        });
    }
    Ok(out)
}

#[cfg(test)]
mod group_order_tests {
    use super::group_launch_order;
    use crate::types::{PortSpec, Script};

    fn mk_script(id: &str, depends_on: &[&str]) -> Script {
        Script {
            id: id.to_string(),
            name: id.to_string(),
            command: format!("echo {}", id),
            ports: vec![PortSpec {
                name: "http".into(),
                number: 9000,
                bind: "127.0.0.1".into(),
                optional: false,
                note: None,
            }],
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            schedule: None,
            depends_on: depends_on.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn group_order_starts_deps_first() {
        // Config order is [api, db] but api depends on db → db must launch first.
        let scripts = vec![mk_script("api", &["db"]), mk_script("db", &[])];
        let order = group_launch_order(&scripts);
        let pos = |id: &str| order.iter().position(|x| x == id).unwrap();
        assert!(
            pos("db") < pos("api"),
            "db must start before api: {:?}",
            order
        );
    }

    #[test]
    fn group_order_cycle_falls_back_to_config_order() {
        // A cycle inside the group must NOT drop members — fall back to the
        // input (config) order so every member is still launched.
        let scripts = vec![mk_script("a", &["b"]), mk_script("b", &["a"])];
        let order = group_launch_order(&scripts);
        assert_eq!(order.len(), 2, "no member may be dropped on a cycle");
        assert_eq!(order, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn group_order_external_dep_is_ignored() {
        // A member depending on a script outside the group (here "infra",
        // not a group member) must not be dropped or blocked from ordering —
        // resolve_dep_order ignores unknown ids (readiness is gated at spawn).
        let scripts = vec![mk_script("web", &["infra"])];
        let order = group_launch_order(&scripts);
        assert_eq!(order, vec!["web".to_string()]);
    }

    #[test]
    fn group_order_preserves_all_members() {
        let scripts = vec![
            mk_script("c", &["b"]),
            mk_script("b", &["a"]),
            mk_script("a", &[]),
            mk_script("indep", &[]),
        ];
        let order = group_launch_order(&scripts);
        assert_eq!(order.len(), 4);
        let pos = |id: &str| order.iter().position(|x| x == id).unwrap();
        assert!(pos("a") < pos("b"));
        assert!(pos("b") < pos("c"));
    }
}
