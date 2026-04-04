// Process lifecycle + log retrieval stubs — real impl in T11-T17 (Sprint 2).
//
// LEARN (state sharing across commands):
//   - Commands are stateless functions. To share state (e.g. a HashMap of
//     running processes), you wrap state in `tauri::State<Arc<Mutex<T>>>`
//     and add `.manage(...)` in lib.rs builder.
//   - The spike's stress.rs + pty.rs already demonstrate this pattern
//     (StressState, PtyState). T11 will copy that approach for ProcessManager.

use crate::types::{LogLine, ProcessHandle};

#[tauri::command]
pub async fn spawn_process(
    _project_id: String,
    _script_id: String,
) -> Result<ProcessHandle, String> {
    // T11-T13: spawn via tokio::process::Command with login-shell wrapper
    //          (`zsh -l -c <cmd>`), register in ProcessManager state.
    unimplemented!("T11: process spawn")
}

#[tauri::command]
pub async fn kill_process(_process_id: String) -> Result<(), String> {
    // T13: SIGTERM then SIGKILL after 5s, applied to the process group id
    //      (pgid) so children die too. Zero-zombie guarantee.
    unimplemented!("T13: process kill")
}

#[tauri::command]
pub async fn get_logs(_process_id: String, _limit: usize) -> Result<Vec<LogLine>, String> {
    // T15-T16: pull the last N lines from the per-process ring buffer
    //          (capacity 5000). Real-time streaming uses `log://{id}` events.
    unimplemented!("T15: log buffer retrieval")
}
