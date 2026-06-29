// Runtime state — transient data NOT persisted in config.yaml.
//
// LEARN (separation of concerns):
//   - config.yaml is for durable, user-editable, git-friendly data.
//   - runtime.json tracks ephemeral session state (what was running at
//     shutdown, active group runs, etc.) that shouldn't dirty the git
//     workspace every few seconds.
//   - We debounce disk writes (500ms) to avoid SSD thrash during rapid
//     process state changes.

use crate::config_store::ConfigError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuntimeState {
    /// script_ids that were running last time we wrote to disk.
    /// Consumed by RestorePrompt on next launch.
    #[serde(default)]
    pub last_running: Vec<String>,
    /// Pre-shared bearer token for remote control server. Generated on
    /// first server start, persisted here, user can rotate.
    #[serde(default)]
    pub remote_token: String,
}

pub fn default_runtime_path() -> Result<PathBuf, ConfigError> {
    let base = dirs::config_dir().ok_or(ConfigError::NoConfigDir)?;
    Ok(base.join("procman").join("runtime.json"))
}

pub struct RuntimeStore {
    path: PathBuf,
    state: Mutex<RuntimeState>,
    /// Set when a flush is pending; another set() call won't schedule a
    /// duplicate flush.
    pending: std::sync::atomic::AtomicBool,
}

impl RuntimeStore {
    pub fn load(path: PathBuf) -> Result<Arc<Self>, ConfigError> {
        let state = if path.exists() {
            let bytes = fs::read(&path)?;
            serde_json::from_slice(&bytes).unwrap_or_default()
        } else {
            RuntimeState::default()
        };
        Ok(Arc::new(Self {
            path,
            state: Mutex::new(state),
            pending: std::sync::atomic::AtomicBool::new(false),
        }))
    }

    pub async fn snapshot(&self) -> RuntimeState {
        self.state.lock().await.clone()
    }

    /// Mark a script as running (true) or stopped (false). Schedules a
    /// debounced flush rather than writing immediately.
    pub async fn mark_running(self: &Arc<Self>, script_id: &str, running: bool) {
        {
            let mut guard = self.state.lock().await;
            if running {
                if !guard.last_running.contains(&script_id.to_string()) {
                    guard.last_running.push(script_id.to_string());
                }
            } else {
                guard.last_running.retain(|id| id != script_id);
            }
        }
        self.schedule_flush();
    }

    pub async fn get_remote_token(&self) -> String {
        self.state.lock().await.remote_token.clone()
    }

    pub async fn set_remote_token(self: &Arc<Self>, token: String) -> Result<(), ConfigError> {
        {
            let mut guard = self.state.lock().await;
            guard.remote_token = token;
        }
        self.flush_now().await
    }

    pub async fn clear_last_running(self: &Arc<Self>) -> Result<(), ConfigError> {
        {
            let mut guard = self.state.lock().await;
            guard.last_running.clear();
        }
        self.flush_now().await
    }

    fn schedule_flush(self: &Arc<Self>) {
        if self.pending.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return; // Already scheduled.
        }
        let me = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            me.pending.store(false, std::sync::atomic::Ordering::SeqCst);
            if let Err(e) = me.flush_now().await {
                log::warn!("runtime state flush failed: {}", e);
            }
        });
    }

    async fn flush_now(&self) -> Result<(), ConfigError> {
        let snap = self.state.lock().await.clone();
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&snap)
            .map_err(|e| ConfigError::Io(std::io::Error::other(e)))?;
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        std::io::Write::write_all(&mut tmp, json.as_bytes())?;
        tmp.as_file().sync_all()?;
        tmp.persist(&self.path)
            .map_err(|e| ConfigError::Io(e.error))?;
        // SEC-13: restrict file permissions to owner-only (0600)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mark_and_flush_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        let store = RuntimeStore::load(path.clone()).unwrap();
        store.mark_running("s1", true).await;
        store.mark_running("s2", true).await;
        store.mark_running("s1", false).await;
        // Wait for debounced flush
        tokio::time::sleep(Duration::from_millis(700)).await;
        let snap = store.snapshot().await;
        assert_eq!(snap.last_running, vec!["s2".to_string()]);
        assert!(path.exists());
        let reloaded = RuntimeStore::load(path).unwrap();
        assert_eq!(
            reloaded.snapshot().await.last_running,
            vec!["s2".to_string()]
        );
    }

    #[tokio::test]
    async fn clear_flushes_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        let store = RuntimeStore::load(path).unwrap();
        store.mark_running("s1", true).await;
        store.clear_last_running().await.unwrap();
        assert_eq!(store.snapshot().await.last_running.len(), 0);
    }

    // WS5: concurrent flush-race regression. The backend now owns
    // `last_running` and `mark_running(true)` fires from `spawn_inner` on every
    // spawn path (manual / group / remote / auto-restart / restore). A group
    // start can mark many scripts near-simultaneously from independent tasks,
    // each of which schedules a debounced flush. This test hammers
    // `mark_running` from many concurrent tasks (with both true and a few
    // false transitions) and asserts the persisted result is exactly the set
    // we expect — no duplicates (push is dedup'd) and no lost ids (retain only
    // drops the explicit-false ones).
    #[tokio::test]
    async fn concurrent_marks_flush_without_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.json");
        let store = RuntimeStore::load(path.clone()).unwrap();

        // 50 scripts, marked running from 50 concurrent tasks. A handful are
        // also marked running a second time (idempotency) and a couple flip to
        // false to exercise the retain path under contention.
        let n = 50usize;
        let mut handles = Vec::with_capacity(n);
        for i in 0..n {
            let s = Arc::clone(&store);
            handles.push(tokio::spawn(async move {
                let id = format!("s{}", i);
                s.mark_running(&id, true).await;
                // Idempotent double-mark for even ids (must not duplicate).
                if i % 2 == 0 {
                    s.mark_running(&id, true).await;
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        // Now concurrently flip two ids to false from separate tasks while a
        // few more true-marks land — interleaving the retain + push paths.
        let f1 = {
            let s = Arc::clone(&store);
            tokio::spawn(async move { s.mark_running("s0", false).await })
        };
        let f2 = {
            let s = Arc::clone(&store);
            tokio::spawn(async move { s.mark_running("s1", false).await })
        };
        let f3 = {
            let s = Arc::clone(&store);
            tokio::spawn(async move { s.mark_running("s99", true).await })
        };
        f1.await.unwrap();
        f2.await.unwrap();
        f3.await.unwrap();

        // Wait past the debounce window so the scheduled flush has fired.
        tokio::time::sleep(Duration::from_millis(700)).await;

        // In-memory snapshot integrity.
        let snap = store.snapshot().await;
        let mut got = snap.last_running.clone();
        got.sort();
        // No duplicates.
        let mut deduped = got.clone();
        deduped.dedup();
        assert_eq!(got, deduped, "last_running must not contain duplicates");
        // Expected set: s2..s49 (s0, s1 flipped off) plus the late s99.
        let mut expected: Vec<String> = (2..n).map(|i| format!("s{}", i)).collect();
        expected.push("s99".to_string());
        expected.sort();
        assert_eq!(got, expected, "in-memory set diverged under contention");

        // On-disk integrity: reload from the flushed file and re-check.
        assert!(path.exists(), "flush must have written runtime.json");
        let reloaded = RuntimeStore::load(path).unwrap();
        let mut disk = reloaded.snapshot().await.last_running;
        disk.sort();
        assert_eq!(disk, expected, "persisted set diverged from memory");
    }
}
