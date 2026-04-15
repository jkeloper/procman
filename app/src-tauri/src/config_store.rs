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

use crate::types::{AppConfig, PortProto, PortSpec};
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
        let mut cfg: AppConfig = serde_yaml::from_slice(&bytes)?;
        // E5: Schema migration — bump version + apply changes
        cfg = Self::migrate(cfg);
        Ok(cfg)
    }

    /// Apply schema migrations sequentially.
    pub(crate) fn migrate(mut cfg: AppConfig) -> AppConfig {
        if cfg.version.is_empty() {
            cfg.version = "1".to_string();
        }

        // v1 → v2 (S1 port management v2): promote `expected_port` into
        // `ports[0]` as a synthetic PortSpec named "default". If `ports`
        // is already populated (user hand-edited a v1 file to look like
        // v2), trust it and do nothing. Idempotent: re-running on a v2
        // config is a no-op because ports is non-empty or expected_port
        // is None.
        if cfg.version == "1" {
            for project in &mut cfg.projects {
                for script in &mut project.scripts {
                    if script.ports.is_empty() {
                        if let Some(p) = script.expected_port {
                            script.ports.push(PortSpec {
                                name: "default".to_string(),
                                number: p,
                                bind: "127.0.0.1".to_string(),
                                proto: PortProto::Tcp,
                                optional: false,
                                note: None,
                            });
                        }
                    }
                }
            }
            cfg.version = "2".to_string();
        }

        cfg
    }

    /// S1: Sync `expected_port` with `ports[0]` on every save. This keeps
    /// the legacy field meaningful for any v1-era tooling (including the
    /// existing orphan cleanup loop in lib.rs) until v3 drops it.
    pub(crate) fn sync_expected_port(cfg: &mut AppConfig) {
        for project in &mut cfg.projects {
            for script in &mut project.scripts {
                script.expected_port = script.ports.first().map(|p| p.number);
            }
        }
    }

    /// Atomically write config to `path`. Creates parent directories if needed.
    pub fn save(cfg: &AppConfig, path: &Path) -> Result<(), ConfigError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Double-write expected_port for v1 compatibility (see sync doc).
        let mut out = cfg.clone();
        Self::sync_expected_port(&mut out);
        let yaml = serde_yaml::to_string(&out)?;

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
    use crate::types::{PortProto, PortSpec, Project, Script};

    fn mk_script_v1(id: &str, port: Option<u16>) -> Script {
        Script {
            id: id.into(),
            name: id.into(),
            command: "pnpm dev".into(),
            expected_port: port,
            ports: Vec::new(),
            auto_restart: false,
            env_file: None,
            depends_on: Vec::new(),
        }
    }

    #[test]
    fn load_missing_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent.yaml");
        let cfg = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg, AppConfig::default());
    }

    #[test]
    fn save_then_load_roundtrip_v2() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.yaml");
        let cfg = AppConfig {
            version: "2".into(),
            projects: vec![Project {
                id: "p1".into(),
                name: "web".into(),
                path: "/tmp".into(),
                scripts: vec![Script {
                    id: "s1".into(),
                    name: "dev".into(),
                    command: "pnpm dev".into(),
                    expected_port: Some(3000),
                    ports: vec![PortSpec {
                        name: "default".into(),
                        number: 3000,
                        bind: "127.0.0.1".into(),
                        proto: PortProto::Tcp,
                        optional: false,
                        note: None,
                    }],
                    auto_restart: false,
                    env_file: None,
                    depends_on: Vec::new(),
                }],
            }],
            ..Default::default()
        };
        ConfigStore::save(&cfg, &path).unwrap();
        assert!(path.exists());
        let back = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg, back);
    }

    // --- S1 migration tests (4 cases) ---

    #[test]
    fn migrate_v1_with_expected_port_promotes_to_ports() {
        let cfg = AppConfig {
            version: "1".into(),
            projects: vec![Project {
                id: "p".into(),
                name: "p".into(),
                path: "/tmp".into(),
                scripts: vec![mk_script_v1("s", Some(3000))],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "2");
        let s = &out.projects[0].scripts[0];
        assert_eq!(s.ports.len(), 1);
        assert_eq!(s.ports[0].name, "default");
        assert_eq!(s.ports[0].number, 3000);
        assert_eq!(s.ports[0].bind, "127.0.0.1");
        assert_eq!(s.ports[0].proto, PortProto::Tcp);
    }

    #[test]
    fn migrate_v1_without_expected_port_yields_empty_ports() {
        let cfg = AppConfig {
            version: "1".into(),
            projects: vec![Project {
                id: "p".into(),
                name: "p".into(),
                path: "/tmp".into(),
                scripts: vec![mk_script_v1("s", None)],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "2");
        assert!(out.projects[0].scripts[0].ports.is_empty());
    }

    #[test]
    fn migrate_v2_already_has_ports_is_noop() {
        // User hand-edited: expected_port mismatches ports[0].number.
        // migrate() must NOT rewrite ports.
        let cfg = AppConfig {
            version: "2".into(),
            projects: vec![Project {
                id: "p".into(),
                name: "p".into(),
                path: "/tmp".into(),
                scripts: vec![Script {
                    id: "s".into(),
                    name: "s".into(),
                    command: "cmd".into(),
                    expected_port: Some(9999), // stale
                    ports: vec![PortSpec {
                        name: "http".into(),
                        number: 8080,
                        bind: "0.0.0.0".into(),
                        proto: PortProto::Tcp,
                        optional: false,
                        note: None,
                    }],
                    auto_restart: false,
                    env_file: None,
                    depends_on: Vec::new(),
                }],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg.clone());
        assert_eq!(out, cfg);
    }

    #[test]
    fn migrate_preserves_depends_on_when_already_v2() {
        // S4 invariant: v1→v2 migrate must not touch depends_on (it's
        // a v2-era field and shouldn't get reset).
        let cfg = AppConfig {
            version: "1".into(),
            projects: vec![Project {
                id: "p".into(),
                name: "p".into(),
                path: "/tmp".into(),
                scripts: vec![Script {
                    id: "s".into(),
                    name: "s".into(),
                    command: "cmd".into(),
                    expected_port: Some(3000),
                    ports: Vec::new(),
                    auto_restart: false,
                    env_file: None,
                    depends_on: vec!["dep1".into(), "dep2".into()],
                }],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "2");
        assert_eq!(
            out.projects[0].scripts[0].depends_on,
            vec!["dep1".to_string(), "dep2".to_string()]
        );
        // ports[0] was synthesized from expected_port
        assert_eq!(out.projects[0].scripts[0].ports.len(), 1);
    }

    #[test]
    fn migrate_is_idempotent_on_v2() {
        let cfg = AppConfig {
            version: "2".into(),
            projects: vec![Project {
                id: "p".into(),
                name: "p".into(),
                path: "/tmp".into(),
                scripts: vec![mk_script_v1("s", Some(3000))],
            }],
            ..Default::default()
        };
        // v2 with expected_port=3000 and empty ports — migrate skipped
        // (we only populate ports in the v1 branch).
        let out = ConfigStore::migrate(cfg.clone());
        assert_eq!(out.version, "2");
        assert!(out.projects[0].scripts[0].ports.is_empty());
        // Re-running is a no-op.
        let out2 = ConfigStore::migrate(out);
        assert_eq!(out2.version, "2");
        assert!(out2.projects[0].scripts[0].ports.is_empty());
    }

    #[test]
    fn save_hook_syncs_expected_port_from_first_port() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let cfg = AppConfig {
            version: "2".into(),
            projects: vec![Project {
                id: "p".into(),
                name: "p".into(),
                path: "/tmp".into(),
                scripts: vec![Script {
                    id: "s".into(),
                    name: "s".into(),
                    command: "cmd".into(),
                    expected_port: None, // will be overwritten at save time
                    ports: vec![PortSpec {
                        name: "http".into(),
                        number: 8080,
                        bind: "0.0.0.0".into(),
                        proto: PortProto::Tcp,
                        optional: false,
                        note: None,
                    }],
                    auto_restart: false,
                    env_file: None,
                    depends_on: Vec::new(),
                }],
            }],
            ..Default::default()
        };
        ConfigStore::save(&cfg, &path).unwrap();
        let back = ConfigStore::load(&path).unwrap();
        assert_eq!(back.projects[0].scripts[0].expected_port, Some(8080));
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
