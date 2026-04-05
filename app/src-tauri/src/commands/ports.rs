// Port → script resolver for "click port, jump to logs" UX.

use crate::process::ProcessManager;

#[tauri::command]
pub async fn resolve_pid_to_script(
    pid: u32,
    pm: tauri::State<'_, ProcessManager>,
) -> Result<Option<String>, String> {
    Ok(pm.script_id_by_pid(pid))
}
