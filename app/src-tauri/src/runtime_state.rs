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

    pub async fn set_remote_token(
        self: &Arc<Self>,
        token: String,
    ) -> Result<(), ConfigError> {
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
        if self
            .pending
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
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
            .map_err(|e| ConfigError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        std::io::Write::write_all(&mut tmp, json.as_bytes())?;
        tmp.as_file().sync_all()?;
        tmp.persist(&self.path).map_err(|e| ConfigError::Io(e.error))?;
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
        assert_eq!(reloaded.snapshot().await.last_running, vec!["s2".to_string()]);
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
}
