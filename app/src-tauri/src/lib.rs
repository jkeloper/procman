// procman Tauri backend entry point.
//
// LEARN (Tauri app structure):
//   - `tauri::Builder::default()` creates the app builder.
//   - `.manage(state)` registers type-indexed shared state; commands access
//     it via `tauri::State<T>`.
//   - `.invoke_handler(generate_handler![...])` lists every #[tauri::command]
//     the frontend can call. Missing entries = "command not found" errors.
//   - `.setup(|app| …)` runs once at startup for initialization.

mod commands;
mod config_store;
mod state;
mod types;

// Spike modules retained as reference for Sprint 2-3.
#[allow(dead_code)]
mod stress;
#[allow(dead_code)]
mod pty;

use state::AppState;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_path = config_store::default_config_path()
        .expect("could not determine config directory");
    let app_state = Arc::new(
        AppState::new(config_path.clone())
            .expect("failed to load or initialize config"),
    );

    tauri::Builder::default()
        .manage(app_state)
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            log::info!("procman started, config at {:?}", config_path);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Projects
            commands::list_projects,
            commands::create_project,
            commands::update_project,
            commands::delete_project,
            // Scripts
            commands::list_scripts,
            commands::create_script,
            commands::update_script,
            commands::delete_script,
            // Processes (stubs)
            commands::spawn_process,
            commands::kill_process,
            commands::get_logs,
            // Ports (stubs)
            commands::list_ports,
            commands::kill_port,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
