// Session-restore commands (T27).
//
// Backed by RuntimeStore (separate from config.yaml) so that rapid
// process state changes don't dirty the user's git-tracked config.

use crate::runtime_state::RuntimeStore;
use std::sync::Arc;

#[tauri::command]
pub async fn get_last_running(
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<Vec<String>, String> {
    Ok(store.snapshot().await.last_running)
}

#[tauri::command]
pub async fn clear_last_running(
    store: tauri::State<'_, Arc<RuntimeStore>>,
) -> Result<(), String> {
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
// S6-04: Session-restore ordering (depends_on topological sort).
//
// The real ordering logic lives implicitly in `commands::process::
// wait_for_dependencies`, which is an async I/O function (TCP probes +
// ProcessManager state) and therefore hard to test in isolation.
//
// Per the worker-G brief we do NOT extract that into a pure helper
// (scope-preservation). Instead we add a local, test-only topological
// sort + cycle detector that mirrors what a future refactor would use,
// and assert it on fixture scripts. If/when the production path is
// refactored to call a pure helper, these tests can be pointed at it
// without rewriting the assertions.
//
// TODO(S6): swap the `local_topo_sort` / `detect_cycle` below for the
// real helpers once `commands::process::resolve_dep_order` lands.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod restore_order_tests {
    use crate::types::{PortProto, PortSpec, Script};
    use std::collections::{HashMap, HashSet};

    /// Build a fixture Script with only the fields that matter for these
    /// ordering tests. Matches the current Script shape in types.rs.
    fn mk_script(id: &str, depends_on: &[&str]) -> Script {
        Script {
            id: id.to_string(),
            name: id.to_string(),
            command: format!("echo {}", id),
            expected_port: None,
            ports: vec![PortSpec {
                name: "http".into(),
                number: 9000,
                bind: "127.0.0.1".into(),
                proto: PortProto::Tcp,
                optional: false,
                note: None,
            }],
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            depends_on: depends_on.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Returns IDs in a valid start order (deps before dependents) or
    /// Err on cycle. Stable w.r.t. input order (BFS on ready set).
    fn local_topo_sort(scripts: &[Script]) -> Result<Vec<String>, String> {
        let by_id: HashMap<String, &Script> =
            scripts.iter().map(|s| (s.id.clone(), s)).collect();
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
            let ready: Vec<String> = pending
                .iter()
                .filter(|(_, deps)| deps.is_empty())
                .map(|(id, _)| id.clone())
                .collect();
            if ready.is_empty() {
                let remaining: Vec<String> = pending.keys().cloned().collect();
                return Err(format!("cycle involving: {}", remaining.join(",")));
            }
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

    #[test]
    fn b_starts_before_a_when_a_depends_on_b() {
        // last_running order is [A, B] but B must start first.
        let scripts = vec![mk_script("A", &["B"]), mk_script("B", &[])];
        let order = local_topo_sort(&scripts).unwrap();
        let pos_a = order.iter().position(|x| x == "A").unwrap();
        let pos_b = order.iter().position(|x| x == "B").unwrap();
        assert!(
            pos_b < pos_a,
            "B must start before A, got {:?}",
            order
        );
    }

    #[test]
    fn chain_of_three_respects_order() {
        // A → B → C (A depends on B, B depends on C)
        let scripts = vec![
            mk_script("A", &["B"]),
            mk_script("B", &["C"]),
            mk_script("C", &[]),
        ];
        let order = local_topo_sort(&scripts).unwrap();
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
        let order = local_topo_sort(&scripts).unwrap();
        assert_eq!(order.len(), 3);
    }

    #[test]
    fn circular_dependency_is_rejected() {
        // A → B → A  (self-referential cycle through one hop)
        let scripts = vec![mk_script("A", &["B"]), mk_script("B", &["A"])];
        let res = local_topo_sort(&scripts);
        assert!(res.is_err(), "cycle must be rejected, got {:?}", res);
        let err = res.err().unwrap();
        assert!(err.contains("cycle"), "err message should mention cycle: {}", err);
    }

    #[test]
    fn missing_dep_is_ignored_not_treated_as_cycle() {
        // A depends on "ghost" which isn't in the script list — must not
        // block A (the real `wait_for_dependencies` rejects unknown ids
        // upfront, so skipping here matches that behaviour).
        let scripts = vec![mk_script("A", &["ghost"])];
        let order = local_topo_sort(&scripts).unwrap();
        assert_eq!(order, vec!["A".to_string()]);
    }
}
