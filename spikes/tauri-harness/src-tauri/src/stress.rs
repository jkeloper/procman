// S1 stress harness — spawns N line-emitter.sh processes and streams stdout
// to frontend via Tauri events. Tracks per-emitter seq for gap detection.

use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct StressState {
    running: AtomicBool,
    total_lines: AtomicU64,
    children: Mutex<Vec<tokio::process::Child>>,
}

#[derive(Clone, serde::Serialize)]
pub struct LinePayload {
    pub eid: u32,
    pub line: String,
}

#[derive(Clone, serde::Serialize)]
pub struct StressStats {
    pub total_lines: u64,
    pub running: bool,
}

#[tauri::command]
pub async fn start_stress(
    emitter_script: String,
    n_processes: u32,
    rate_per_sec: u32,
    duration_sec: u32,
    app: AppHandle,
    state: State<'_, Arc<StressState>>,
) -> Result<String, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("already running".into());
    }
    state.total_lines.store(0, Ordering::SeqCst);

    for eid in 0..n_processes {
        let mut child = Command::new(&emitter_script)
            .arg(rate_per_sec.to_string())
            .arg(duration_sec.to_string())
            .arg(eid.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn eid={}: {}", eid, e))?;

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let state_clone = Arc::clone(&state.inner());
        let app_clone = app.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                state_clone.total_lines.fetch_add(1, Ordering::Relaxed);
                let _ = app_clone.emit(
                    &format!("stress://line/{}", eid),
                    LinePayload { eid, line },
                );
            }
        });

        state.children.lock().await.push(child);
    }

    Ok(format!("started {} emitters", n_processes))
}

#[tauri::command]
pub async fn stop_stress(state: State<'_, Arc<StressState>>) -> Result<StressStats, String> {
    let mut guard = state.children.lock().await;
    for child in guard.iter_mut() {
        let _ = child.kill().await;
    }
    guard.clear();
    state.running.store(false, Ordering::SeqCst);

    Ok(StressStats {
        total_lines: state.total_lines.load(Ordering::SeqCst),
        running: false,
    })
}

#[tauri::command]
pub fn get_stats(state: State<'_, Arc<StressState>>) -> StressStats {
    StressStats {
        total_lines: state.total_lines.load(Ordering::Relaxed),
        running: state.running.load(Ordering::Relaxed),
    }
}

#[tauri::command]
pub fn save_report(filename: String, content: String) -> Result<String, String> {
    use std::fs;
    use std::path::PathBuf;
    let dir = PathBuf::from(
        "/Users/jeonghwankim/projects/procman/spikes/s1-stdout/results",
    );
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
    let path = dir.join(&filename);
    fs::write(&path, content).map_err(|e| format!("write: {}", e))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Sample RSS (KB) of the current process via mach_task_basic_info.
/// macOS-only. Returns 0 on failure.
#[tauri::command]
pub fn get_rss_kb() -> u64 {
    #[cfg(target_os = "macos")]
    unsafe {
        use std::mem;
        #[repr(C)]
        #[derive(Default)]
        struct MachTaskBasicInfo {
            virtual_size: u64,
            resident_size: u64,
            resident_size_max: u64,
            user_time: [u32; 2],
            system_time: [u32; 2],
            policy: i32,
            suspend_count: i32,
        }
        extern "C" {
            fn mach_task_self() -> u32;
            fn task_info(
                task: u32,
                flavor: u32,
                info: *mut MachTaskBasicInfo,
                count: *mut u32,
            ) -> i32;
        }
        const MACH_TASK_BASIC_INFO: u32 = 20;
        let count_init =
            (mem::size_of::<MachTaskBasicInfo>() / mem::size_of::<u32>()) as u32;
        let mut info = MachTaskBasicInfo::default();
        let mut count = count_init;
        let kr = task_info(
            mach_task_self(),
            MACH_TASK_BASIC_INFO,
            &mut info as *mut _,
            &mut count as *mut _,
        );
        if kr == 0 {
            info.resident_size / 1024
        } else {
            0
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}
