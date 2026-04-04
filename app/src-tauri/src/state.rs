// AppState — shared mutable state across Tauri commands.
//
// LEARN (Rust concurrency primitives):
//   - `Arc<Mutex<T>>` is the classic "shared mutable state" pattern: Arc
//     enables cloning handles between threads; Mutex serializes access.
//   - Use `tokio::sync::Mutex` (async lock) over `std::sync::Mutex` when
//     the critical section touches .await points. Here config I/O is sync
//     fs, but we put the lock inside an async command so tokio::Mutex is
//     the safe default — holding std::sync::Mutex across .await is UB.
//   - State registered via `.manage(Arc::new(AppState::new(...)))` in
//     lib.rs is retrieved in commands as `state: tauri::State<AppState>`.

use crate::config_store::{ConfigError, ConfigStore};
use crate::types::AppConfig;
use std::path::PathBuf;
use tokio::sync::Mutex;

pub struct AppState {
    pub config_path: PathBuf,
    pub config: Mutex<AppConfig>,
}

impl AppState {
    pub fn new(config_path: PathBuf) -> Result<Self, ConfigError> {
        let config = ConfigStore::load(&config_path)?;
        Ok(Self {
            config_path,
            config: Mutex::new(config),
        })
    }

    /// Apply a mutation to the in-memory config and persist to disk atomically.
    /// On failure the on-disk file is untouched; the in-memory state IS mutated
    /// first and rolled back if save fails.
    pub async fn mutate<F, R>(&self, f: F) -> Result<R, ConfigError>
    where
        F: FnOnce(&mut AppConfig) -> R,
    {
        let mut guard = self.config.lock().await;
        let prev = guard.clone();
        let result = f(&mut guard);
        if let Err(e) = ConfigStore::save(&guard, &self.config_path) {
            *guard = prev; // rollback
            return Err(e);
        }
        Ok(result)
    }
}
