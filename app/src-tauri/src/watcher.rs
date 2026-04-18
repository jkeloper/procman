// FileSystem watcher for config.yaml — T09.
//
// LEARN (background file watching):
//   - `notify` crate provides a cross-platform FS event source. The
//     recommended watcher on macOS is FSEvents via `RecommendedWatcher`.
//   - Events fire on write/create/remove. We debounce them manually with a
//     short cooldown (200ms) because editors often emit rename+create when
//     saving (vim, etc.).
//   - We run the watcher on a dedicated OS thread since notify's callback
//     interface is sync. The thread emits Tauri events via the AppHandle.

use crate::config_store::ConfigStore;
use crate::state::AppState;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEBOUNCE_MS: u64 = 200;

pub fn spawn_config_watcher(
    app: AppHandle,
    state: Arc<AppState>,
    config_path: PathBuf,
) {
    thread::spawn(move || {
        let (tx, rx) = channel::<notify::Result<Event>>();
        let mut watcher: RecommendedWatcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                log::error!("notify init failed: {}", e);
                return;
            }
        };

        // Watch the parent directory — watching a non-existent file fails.
        let parent = match config_path.parent() {
            Some(p) => p.to_path_buf(),
            None => {
                log::error!("config path has no parent: {:?}", config_path);
                return;
            }
        };
        if std::fs::create_dir_all(&parent).is_err() {
            log::error!("could not create {:?}", parent);
            return;
        }
        if let Err(e) = watcher.watch(&parent, RecursiveMode::NonRecursive) {
            log::error!("watcher.watch failed: {}", e);
            return;
        }

        let mut last_handled = Instant::now() - Duration::from_secs(3600);
        for res in rx {
            let Ok(event) = res else { continue };
            // Filter to our specific file and relevant event kinds.
            let is_ours = event.paths.iter().any(|p| p == &config_path);
            if !is_ours {
                continue;
            }
            let interesting = matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            );
            if !interesting {
                continue;
            }
            // Debounce
            if last_handled.elapsed() < Duration::from_millis(DEBOUNCE_MS) {
                continue;
            }
            last_handled = Instant::now();

            // H5: Skip events produced by our own atomic write. macOS
            // FSEvents sometimes delivers a Create+Modify+Rename storm
            // after persist(); the suppression window (2s) is generous
            // enough to absorb that without swallowing user edits (an
            // external editor save lands well after the window closes).
            if crate::config_store::watcher_should_suppress() {
                log::debug!("watcher: self-write suppressed");
                continue;
            }

            // Acquire the lock FIRST, then load. If we read disk before
            // locking, a concurrent createScript on the tokio side could
            // write a newer version while we're sitting on a stale read,
            // and then we'd overwrite the in-memory state with that stale
            // copy, dropping freshly-added entries. Locking first means
            // any in-flight writes complete (their save is atomic) before
            // we read, and the read always reflects the current truth.
            let mut guard = state.config.blocking_lock();
            match ConfigStore::load(&config_path) {
                Ok(cfg) => {
                    if *guard == cfg {
                        // No actual change — skip the emit so we don't
                        // bombard the UI with redundant reload events.
                        continue;
                    }
                    *guard = cfg;
                    drop(guard);
                    if let Err(e) = app.emit("config-changed", ()) {
                        log::warn!("emit config-changed failed: {}", e);
                    } else {
                        log::info!("config reloaded from disk");
                    }
                }
                Err(e) => log::warn!("reload failed: {}", e),
            }
        }
    });
}
