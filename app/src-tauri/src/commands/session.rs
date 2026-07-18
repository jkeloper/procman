// Session-restore commands (T27).
//
// Backed by RuntimeStore (separate from config.yaml) so that rapid
// process state changes don't dirty the user's git-tracked config.

use crate::runtime_state::RuntimeStore;
use crate::state::AppState;
use std::sync::Arc;

#[tauri::command]
pub async fn get_last_running(
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<Vec<String>, String> {
    Ok(store.snapshot().await.last_running)
}

/// WS6: dependency-ordered session restore.
///
/// Returns the `last_running` script ids resolved into `depends_on`
/// topological order so the FE can fire them in parallel (or sequence)
/// without a per-spawn 30s readiness stall on the wrong order. Only ids
/// that still exist in the current config are kept (stale ids are dropped,
/// mirroring `RestorePrompt`'s own resolve-then-filter); the dep graph is
/// scoped to that surviving subset, so a dep that wasn't itself running is
/// simply skipped (`resolve_dep_order` ignores unknown ids). On a cycle we
/// fall back to the raw `last_running` push order rather than erroring —
/// restore should never be blocked by a malformed graph.
#[tauri::command]
pub async fn last_running_ordered(
    store: tauri::State<'_, Arc<RuntimeStore>>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let last_running = store.snapshot().await.last_running;
    if last_running.is_empty() {
        return Ok(Vec::new());
    }
    let guard = state.config.lock().await;
    // Collect the Script records for the ids still present in config, keyed
    // for stable lookup. Drop ids that no longer resolve to a script.
    let mut surviving: Vec<Script> = Vec::new();
    for id in &last_running {
        for p in &guard.projects {
            if let Some(s) = p.scripts.iter().find(|s| &s.id == id) {
                surviving.push(s.clone());
                break;
            }
        }
    }
    drop(guard);
    if surviving.is_empty() {
        return Ok(Vec::new());
    }
    let ordered = resolve_dep_order(&surviving)
        .unwrap_or_else(|_| surviving.iter().map(|s| s.id.clone()).collect());
    Ok(ordered)
}

#[tauri::command]
pub async fn clear_last_running(store: tauri::State<'_, Arc<RuntimeStore>>) -> Result<(), String> {
    store.clear_last_running().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_last_running(
    script_id: String,
    running: bool,
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<(), String> {
    store.mark_running(&script_id, running).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// WS5: Single dependency-ordering engine (depends_on topological sort).
//
// This is the *production* ordering primitive used by both `run_group`
// (commands::group, ordered + readiness-gated group launches) and the
// session-restore path (`last_running_ordered` above, consumed by
// RestorePrompt). It complements `commands::process::wait_for_dependencies`
// (the async readiness gate): `resolve_dep_order` decides the *order*,
// `wait_for_dependencies` enforces *readiness* before each spawn.
// ---------------------------------------------------------------------------

use crate::types::Script;
use std::collections::{HashMap, HashSet};

/// Topologically sort `scripts` so every script's `depends_on` entries come
/// before it. Returns the start order, or `Err` describing the cycle if the
/// graph is not a DAG. Stable w.r.t. input order (BFS on the ready set).
///
/// Unknown dependency ids (a `depends_on` that names no script in the slice)
/// are ignored rather than treated as a cycle — this matches
/// `wait_for_dependencies`, which rejects unknown ids upfront, and lets a
/// group member depend on a script that lives outside the group.
pub(crate) fn resolve_dep_order(scripts: &[Script]) -> Result<Vec<String>, String> {
    let by_id: HashMap<String, &Script> = scripts.iter().map(|s| (s.id.clone(), s)).collect();
    // Stable tie-break: the input slice order is the user's intended order
    // (group member arrangement / last_running sequence). Independent scripts
    // at the same dependency level must come out in that order, not the
    // arbitrary HashMap iteration order — otherwise group launches with no
    // inter-deps fire non-deterministically.
    let order_index: HashMap<&str, usize> = scripts
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    // Dep graph: node → set of deps that must come first.
    let mut pending: HashMap<String, HashSet<String>> = scripts
        .iter()
        .map(|s| {
            let deps: HashSet<String> = s
                .depends_on
                .iter()
                .filter(|d| by_id.contains_key(*d))
                .cloned()
                .collect();
            (s.id.clone(), deps)
        })
        .collect();
    let mut out: Vec<String> = Vec::with_capacity(scripts.len());
    while !pending.is_empty() {
        let mut ready: Vec<String> = pending
            .iter()
            .filter(|(_, deps)| deps.is_empty())
            .map(|(id, _)| id.clone())
            .collect();
        if ready.is_empty() {
            let remaining: Vec<String> = pending.keys().cloned().collect();
            return Err(format!("cycle involving: {}", remaining.join(",")));
        }
        // Emit this ready batch in the original input order for determinism.
        ready.sort_by_key(|id| order_index.get(id.as_str()).copied().unwrap_or(usize::MAX));
        for id in &ready {
            pending.remove(id);
            out.push(id.clone());
        }
        for deps in pending.values_mut() {
            for id in &ready {
                deps.remove(id);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod restore_order_tests {
    use super::resolve_dep_order;
    use crate::types::{PortSpec, Script};

    /// Build a fixture Script with only the fields that matter for these
    /// ordering tests. Matches the current Script shape in types.rs.
    fn mk_script(id: &str, depends_on: &[&str]) -> Script {
        Script {
            id: id.to_string(),
            name: id.to_string(),
            command: format!("echo {id}"),
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
    fn b_starts_before_a_when_a_depends_on_b() {
        // last_running order is [A, B] but B must start first.
        let scripts = vec![mk_script("A", &["B"]), mk_script("B", &[])];
        let order = resolve_dep_order(&scripts).unwrap();
        let pos_a = order.iter().position(|x| x == "A").unwrap();
        let pos_b = order.iter().position(|x| x == "B").unwrap();
        assert!(pos_b < pos_a, "B must start before A, got {order:?}");
    }

    #[test]
    fn chain_of_three_respects_order() {
        // A → B → C (A depends on B, B depends on C)
        let scripts = vec![
            mk_script("A", &["B"]),
            mk_script("B", &["C"]),
            mk_script("C", &[]),
        ];
        let order = resolve_dep_order(&scripts).unwrap();
        let idx = |id: &str| order.iter().position(|x| x == id).unwrap();
        assert!(idx("C") < idx("B"));
        assert!(idx("B") < idx("A"));
    }

    #[test]
    fn independent_scripts_all_appear() {
        let scripts = vec![
            mk_script("A", &[]),
            mk_script("B", &[]),
            mk_script("C", &[]),
        ];
        let order = resolve_dep_order(&scripts).unwrap();
        assert_eq!(order.len(), 3);
    }

    #[test]
    fn independent_scripts_preserve_input_order() {
        // No inter-deps: the output must equal the input order, not an
        // arbitrary HashMap iteration order. Guards group-launch determinism.
        let scripts = vec![
            mk_script("zebra", &[]),
            mk_script("alpha", &[]),
            mk_script("mike", &[]),
        ];
        let order = resolve_dep_order(&scripts).unwrap();
        assert_eq!(
            order,
            vec!["zebra".to_string(), "alpha".to_string(), "mike".to_string()],
            "independent scripts must come out in input order"
        );
    }

    #[test]
    fn same_level_dependents_preserve_input_order() {
        // c and b both depend only on a → after a, they must appear in input
        // order [c, b], not HashMap order.
        let scripts = vec![
            mk_script("a", &[]),
            mk_script("c", &["a"]),
            mk_script("b", &["a"]),
        ];
        let order = resolve_dep_order(&scripts).unwrap();
        assert_eq!(
            order,
            vec!["a".to_string(), "c".to_string(), "b".to_string()],
        );
    }

    #[test]
    fn circular_dependency_is_rejected() {
        // A → B → A  (self-referential cycle through one hop)
        let scripts = vec![mk_script("A", &["B"]), mk_script("B", &["A"])];
        let res = resolve_dep_order(&scripts);
        assert!(res.is_err(), "cycle must be rejected, got {res:?}");
        let err = res.err().unwrap();
        assert!(
            err.contains("cycle"),
            "err message should mention cycle: {err}"
        );
    }

    #[test]
    fn missing_dep_is_ignored_not_treated_as_cycle() {
        // A depends on "ghost" which isn't in the script list — must not
        // block A (the real `wait_for_dependencies` rejects unknown ids
        // upfront, so skipping here matches that behaviour).
        let scripts = vec![mk_script("A", &["ghost"])];
        let order = resolve_dep_order(&scripts).unwrap();
        assert_eq!(order, vec!["A".to_string()]);
    }

    #[test]
    fn restore_subset_scopes_dep_to_running_only() {
        // WS6 `last_running_ordered` scopes the graph to the surviving
        // (still-in-config + still-running) subset. If A depends on B but
        // only A was running last session, B is absent from the slice and
        // A is simply ordered alone — restore must not block on a dep that
        // wasn't itself part of the session.
        let scripts = vec![mk_script("A", &["B"])];
        let order = resolve_dep_order(&scripts).unwrap();
        assert_eq!(order, vec!["A".to_string()]);
    }

    #[test]
    fn restore_subset_orders_both_when_both_running() {
        // Both A and B were running; B must come first because A depends on it.
        let scripts = vec![mk_script("A", &["B"]), mk_script("B", &[])];
        let order = resolve_dep_order(&scripts).unwrap();
        let idx = |id: &str| order.iter().position(|x| x == id).unwrap();
        assert!(idx("B") < idx("A"), "B before A, got {order:?}");
    }
}
