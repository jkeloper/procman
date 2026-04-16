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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
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

            // Tunnel recovery: re-map running cloudflared processes to
            // scripts so the UI shows them without the user re-creating.
            {
                let tunnel_state = app.state::<Arc<commands::tunnel::TunnelState>>().inner().clone();
                let cfg_state = app.state::<Arc<AppState>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let running = match cloudflared::detect_running_cloudflared().await {
                        Ok(r) => r,
                        Err(_) => return,
                    };
                    if running.is_empty() { return; }
                    let cfg = cfg_state.config.lock().await;
                    let mut script_ports: Vec<(String, u16)> = Vec::new();
                    for project in &cfg.projects {
                        for script in &project.scripts {
                            for spec in &script.ports {
                                script_ports.push((script.id.clone(), spec.number));
                            }
                            if script.ports.is_empty() {
                                if let Some(port) = script.expected_port {
                                    script_ports.push((script.id.clone(), port));
                                }
                            }
                        }
                    }
                    drop(cfg);
                    tunnel_state.recover_from_running(&running, &script_ports).await;
                    log::info!("tunnel recovery: scanned {} cloudflared processes", running.len());
                });
            }

            // Orphan cleanup: if procman was force-killed last time,
            // child processes may still hold ports. For each script
            // that was running in the previous session, kill anything
            // occupying its expected_port so the user can restart
            // cleanly without manual port cleanup.
            {
                let rs = app.state::<Arc<RuntimeStore>>().inner().clone();
                let cfg_state = app.state::<Arc<AppState>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let snap = rs.snapshot().await;
                    if snap.last_running.is_empty() {
                        return;
                    }
                    let cfg = cfg_state.config.lock().await;
                    let mut ports_to_clean: Vec<u16> = Vec::new();
                    for project in &cfg.projects {
                        for script in &project.scripts {
                            if snap.last_running.contains(&script.id) {
                                // S1: prefer declared ports list, fall back to legacy expected_port.
                                if !script.ports.is_empty() {
                                    for spec in &script.ports {
                                        ports_to_clean.push(spec.number);
                                    }
                                } else if let Some(port) = script.expected_port {
                                    ports_to_clean.push(port as u16);
                                }
                            }
                        }
                    }
                    drop(cfg);
                    for port in ports_to_clean {
                        match commands::port::kill_port(port).await {
                            Ok(()) => log::info!("orphan cleanup: freed port {}", port),
                            Err(_) => {} // port wasn't in use — fine
                        }
                    }
                    let _ = rs.clear_last_running().await;
                });
            }

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
            commands::reorder_scripts,
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
            commands::search_log,
            commands::clear_log,
            commands::force_quit,
            // Ports
            commands::list_ports,
            commands::kill_port,
            commands::resolve_pid_to_script,
            commands::get_port_aliases,
            commands::set_port_alias,
            commands::list_ports_for_script_pid,
            commands::list_descendant_pids,
            // S1: declared-port APIs
            commands::port_status_for_script,
            commands::check_port_conflicts,
            commands::list_ports_for_script,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill every managed process when procman itself is
            // shutting down — whether via ⌘Q, Dock quit, OS logout,
            // or Activity Monitor TERM. Without this children get
            // reparented to launchd and keep holding their ports.
            // We do this on Exit (fires after ExitRequested is
            // approved) so the quit guard still has a chance to
            // interrupt via prevent_exit.
            if let tauri::RunEvent::Exit = event {
                if let Some(pm) = app_handle.try_state::<ProcessManager>() {
                    let snaps = pm.list();
                    if !snaps.is_empty() {
                        log::info!("procman exiting — killing {} child process group(s)", snaps.len());

                        // Collect all descendant PIDs holding ports before
                        // killing groups. This catches detached processes
                        // (Gradle daemon, etc.) that escape killpg.
                        let all_pids: Vec<u32> = snaps.iter().map(|s| s.pid).collect();
                        let mut extra_pids: Vec<u32> = Vec::new();
                        // Sync lsof scan — acceptable at shutdown.
                        let output = std::process::Command::new("lsof")
                            .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcnT"])
                            .output();
                        if let Ok(out) = output {
                            let text = String::from_utf8_lossy(&out.stdout);
                            let ports = commands::port::parse_lsof_for_api(&text);
                            // Collect descendant PIDs via ppid/pgid scan
                            if let Ok(ps_out) = std::process::Command::new("ps")
                                .args(["-ax", "-o", "pid=,ppid=,pgid="])
                                .output()
                            {
                                let ps_text = String::from_utf8_lossy(&ps_out.stdout);
                                let mut child_set: std::collections::HashSet<u32> = all_pids.iter().copied().collect();
                                // BFS: find all descendants of managed PIDs
                                let mut changed = true;
                                while changed {
                                    changed = false;
                                    for line in ps_text.lines() {
                                        let parts: Vec<&str> = line.split_whitespace().collect();
                                        if parts.len() < 3 { continue; }
                                        let pid: u32 = parts[0].parse().unwrap_or(0);
                                        let ppid: u32 = parts[1].parse().unwrap_or(0);
                                        let pgid: u32 = parts[2].parse().unwrap_or(0);
                                        if pid == 0 { continue; }
                                        if !child_set.contains(&pid) &&
                                           (child_set.contains(&ppid) || child_set.contains(&pgid)) {
                                            child_set.insert(pid);
                                            changed = true;
                                        }
                                    }
                                }
                                for p in &ports {
                                    if child_set.contains(&p.pid) && !all_pids.contains(&p.pid) {
                                        extra_pids.push(p.pid);
                                    }
                                }
                            }
                        }

                        // Kill process groups
                        for snap in &snaps {
                            unsafe {
                                libc::killpg(snap.pid as i32, libc::SIGKILL);
                            }
                        }
                        // Kill orphan descendants that escaped the group
                        for pid in &extra_pids {
                            unsafe {
                                if libc::kill(*pid as i32, 0) == 0 {
                                    log::info!("exit: killing orphan descendant pid {}", pid);
                                    libc::kill(*pid as i32, libc::SIGKILL);
                                }
                            }
                        }
                    }
                }
            }
        });
}
