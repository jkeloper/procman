// procman Tauri backend entry point.
//
// LEARN (Tauri app structure):
//   - `tauri::Builder::default()` creates the app builder.
//   - `.manage(state)` registers a type-indexed shared state accessible to all
//     commands via `tauri::State<T>`. Wrap in Arc<Mutex<>> for mutable state.
//   - `.invoke_handler(generate_handler![...])` lists every #[tauri::command]
//     that the frontend can call. Missing entries = "command not found" errors.
//   - `.run(generate_context!())` starts the event loop and blocks until exit.

mod commands;
mod types;

// Spike modules retained as reference implementations — not wired into the
// MVP invoke handlers yet. stress.rs informs T11 (ProcessManager), pty.rs
// informs T16-T17 (log streaming + PTY sessions).
#[allow(dead_code)]
mod stress;
#[allow(dead_code)]
mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::create_project,
            commands::delete_project,
            commands::spawn_process,
            commands::kill_process,
            commands::get_logs,
            commands::list_ports,
            commands::kill_port,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
