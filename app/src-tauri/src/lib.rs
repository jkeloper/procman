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
mod log_buffer;
mod process;
mod runtime_state;
mod state;
mod types;
mod watcher;

// Spike modules retained as reference for Sprint 2-3.
#[allow(dead_code)]
mod stress;
#[allow(dead_code)]
mod pty;

use process::ProcessManager;
use runtime_state::RuntimeStore;
use state::AppState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_path = config_store::default_config_path()
        .expect("could not determine config directory");
    let app_state = Arc::new(
        AppState::new(config_path.clone())
            .expect("failed to load or initialize config"),
    );
    let runtime_path = runtime_state::default_runtime_path()
        .expect("could not determine runtime state directory");
    let runtime_store = RuntimeStore::load(runtime_path)
        .expect("failed to load runtime state");

    // Apply user settings to process manager log capacity.
    let log_cap = {
        let _ = config_path; // avoid unused-warn in debug build (used below)
        // We'll read it synchronously here via try_lock since no contention at startup.
        tokio::runtime::Handle::try_current()
            .ok()
            .and_then(|_| None::<usize>)
            .unwrap_or(5000)
    };
    let _ = log_cap;

    let watch_state = Arc::clone(&app_state);
    let watch_path = config_path.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .manage(runtime_store)
        .setup(move |app| {
            let pm = ProcessManager::new(app.handle().clone());
            // Apply log capacity from settings (best-effort, non-blocking).
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                if let Ok(cfg) = state.config.try_lock() {
                    pm.set_log_capacity(cfg.settings.log_buffer_size);
                }
            }
            app.manage(pm);
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            log::info!("procman started, config at {:?}", config_path);
            watcher::spawn_config_watcher(app.handle().clone(), watch_state, watch_path);
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
            // Scan
            commands::scan_directory,
            // Groups
            commands::list_groups,
            commands::create_group,
            commands::update_group,
            commands::delete_group,
            commands::run_group,
            // Session
            commands::get_last_running,
            commands::clear_last_running,
            commands::mark_last_running,
            // Processes
            commands::spawn_process,
            commands::kill_process,
            commands::restart_process,
            commands::list_processes,
            commands::log_snapshot,
            // Ports (stubs)
            commands::list_ports,
            commands::kill_port,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
