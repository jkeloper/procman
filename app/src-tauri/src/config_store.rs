// ConfigStore — atomic YAML read/write for AppConfig.
//
// LEARN (Rust error handling + file atomicity):
//   - `thiserror` derives std::error::Error for enum variants with source()
//     chaining. Each variant wraps an upstream error (std::io::Error, etc.)
//     via `#[from]`, giving a single ergonomic `Result<T, ConfigError>`.
//   - Atomic write pattern: write to a sibling temp file in the SAME directory,
//     fsync it, then `rename(temp, target)`. POSIX guarantees rename is atomic
//     on the same filesystem, so a reader never sees a half-written file.
//   - `dirs::config_dir()` returns the platform config root
//     (~/Library/Application Support on macOS, ~/.config on Linux, etc.).

use crate::types::AppConfig;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("yaml parse: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("no config directory for this platform")]
    NoConfigDir,
}

/// Default config path: `~/Library/Application Support/procman/config.yaml` on macOS.
pub fn default_config_path() -> Result<PathBuf, ConfigError> {
    let base = dirs::config_dir().ok_or(ConfigError::NoConfigDir)?;
    Ok(base.join("procman").join("config.yaml"))
}

pub struct ConfigStore;

impl ConfigStore {
    /// Load config from `path`. If the file doesn't exist, returns
    /// `AppConfig::default()` without creating anything on disk.
    pub fn load(path: &Path) -> Result<AppConfig, ConfigError> {
        if !path.exists() {
            return Ok(AppConfig::default());
        }
        let bytes = fs::read(path)?;
        let cfg: AppConfig = serde_yaml::from_slice(&bytes)?;
        Ok(cfg)
    }

    /// Atomically write config to `path`. Creates parent directories if needed.
    pub fn save(cfg: &AppConfig, path: &Path) -> Result<(), ConfigError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let yaml = serde_yaml::to_string(cfg)?;

        // Temp file in the same directory → rename is atomic on same FS.
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        tmp.write_all(yaml.as_bytes())?;
        tmp.as_file().sync_all()?;
        tmp.persist(path)
            .map_err(|e| ConfigError::Io(e.error))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Project, Script};

    #[test]
    fn load_missing_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent.yaml");
        let cfg = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg, AppConfig::default());
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.yaml");
        let cfg = AppConfig {
            version: "1".into(),
            projects: vec![Project {
                id: "p1".into(),
                name: "web".into(),
                path: "/tmp".into(),
                scripts: vec![Script {
                    id: "s1".into(),
                    name: "dev".into(),
                    command: "pnpm dev".into(),
                    expected_port: Some(3000),
                    auto_restart: false,
                }],
            }],
            ..Default::default()
        };
        ConfigStore::save(&cfg, &path).unwrap();
        assert!(path.exists());
        let back = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg, back);
    }

    #[test]
    fn save_is_atomic_no_temp_leftover() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        ConfigStore::save(&AppConfig::default(), &path).unwrap();
        // After persist, only config.yaml should exist in the dir (no .tmpXXX)
        let files: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files, vec!["config.yaml".to_string()]);
    }
}
