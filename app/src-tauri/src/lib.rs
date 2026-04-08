// procman Tauri backend entry point.
//
// LEARN (Tauri app structure):
//   - `tauri::Builder::default()` creates the app builder.
//   - `.manage(state)` registers type-indexed shared state; commands access
//     it via `tauri::State<T>`.
//   - `.invoke_handler(generate_handler![...])` lists every #[tauri::command]
//     the frontend can call. Missing entries = "command not found" errors.
//   - `.setup(|app| …)` runs once at startup for initialization.

mod cloudflared;
mod commands;
mod config_store;
mod log_buffer;
mod process;
mod runtime_state;
mod server;
mod state;
mod types;
mod vscode_scanner;
mod watcher;

// Spike modules retained as reference for Sprint 2-3.

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

            // Remote server state (bearer token loaded from runtime_state).
            let rs = app.state::<Arc<RuntimeStore>>().inner().clone();
            let token = tauri::async_runtime::block_on(rs.get_remote_token());
            let token = if token.is_empty() {
                let fresh = server::auth::generate_token();
                let rs_c = rs.clone();
                let t_c = fresh.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = rs_c.set_remote_token(t_c).await;
                });
                fresh
            } else {
                token
            };
            app.manage(commands::remote::RemoteServerState::new(token));
            app.manage(commands::tunnel::TunnelState::new());

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
            commands::reorder_projects,
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
            // Ports
            commands::list_ports,
            commands::kill_port,
            commands::resolve_pid_to_script,
            // VSCode scan
            vscode_scanner::scan_vscode_configs,
            // Cloudflared
            cloudflared::cloudflared_installed,
            cloudflared::list_cf_tunnels,
            cloudflared::detect_running_cloudflared,
            cloudflared::kill_cloudflared_pid,
            // Tunnel
            commands::start_tunnel,
            commands::stop_tunnel,
            commands::tunnel_status,
            // Remote server
            commands::server_status,
            commands::start_server,
            commands::stop_server,
            commands::rotate_token,
            commands::get_audit_log,
            commands::local_ip,
        ])
        .on_window_event(|window, event| {
            use tauri::Emitter;
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(pm) = window.try_state::<ProcessManager>() {
                    let running = pm.list();
                    if !running.is_empty() {
                        api.prevent_close();
                        let count = running.len();
                        let _ = window.emit("procman://confirm-quit", count);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
