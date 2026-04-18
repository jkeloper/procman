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

use crate::types::{AppConfig, AutoRestartPolicy, PortProto, PortSpec};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

/// H5: Guard against FS-watcher re-entry after our own atomic write.
/// macOS FSEvents sometimes delivers multiple events (Create + Modify +
/// Rename) for a single rename(), spread over >200ms. We set this to
/// `now + SUPPRESS_MS` whenever `save()` lands, and the watcher thread
/// skips reload while the guard hasn't expired. Stored as unix-millis
/// so a plain AtomicU64 is sufficient — no Mutex contention.
static SUPPRESS_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
const SUPPRESS_MS: u64 = 2_000;

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// True while the watcher should ignore FS events for our config file
/// (we just wrote it). Called from the watcher thread.
pub fn watcher_should_suppress() -> bool {
    now_unix_ms() < SUPPRESS_UNTIL_MS.load(Ordering::Relaxed)
}

/// Arm the suppression window. Called from `ConfigStore::save()`.
fn arm_watcher_suppress() {
    SUPPRESS_UNTIL_MS.store(now_unix_ms() + SUPPRESS_MS, Ordering::Relaxed);
}

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
        // H3: ensure the on-disk file is 0600 (one-shot chmod on load).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
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

        if cfg.version == "2" {
            cfg = Self::migrate_v2_to_v3(cfg);
        }

        cfg
    }

    /// v2 → v3: synthesize `auto_restart_policy` from legacy `auto_restart`
    /// bool. Idempotent: if a script already has a policy (v3-era), skip.
    /// If a script has `auto_restart == false` and no policy, leave policy
    /// as None (nothing to preserve). New AppSettings fields are serde-
    /// defaulted by the load path — no touch needed here.
    pub(crate) fn migrate_v2_to_v3(mut cfg: AppConfig) -> AppConfig {
        for project in &mut cfg.projects {
            for script in &mut project.scripts {
                if script.auto_restart && script.auto_restart_policy.is_none() {
                    script.auto_restart_policy = Some(AutoRestartPolicy::default());
                }
            }
        }
        cfg.version = "3".to_string();
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
        // H5: Arm the watcher-suppression guard BEFORE touching disk so
        // the event callback can't race us. We re-arm again after persist
        // (FSEvents may deliver the event up to ~1s after rename).
        arm_watcher_suppress();
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
        // H3: lock down to 0600 (user-only rw). config.yaml can contain
        // env-file paths / local URLs — not secrets per se, but the
        // runtime.json next door is already 0600 so align.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        // Re-arm: FSEvents can surface the rename event a second or two
        // after persist() returns, so extend the window one more time.
        arm_watcher_suppress();
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
            auto_restart_policy: None,
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
    fn save_then_load_roundtrip_v3() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.yaml");
        let cfg = AppConfig {
            version: "3".into(),
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
                    auto_restart_policy: None,
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
        // Chained v1 → v2 → v3 lands at "3".
        assert_eq!(out.version, "3");
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
        // Chained migrations: v1 → v2 (no expected_port → no ports) → v3.
        assert_eq!(out.version, "3");
        assert!(out.projects[0].scripts[0].ports.is_empty());
    }

    #[test]
    fn migrate_v2_already_has_ports_is_noop_on_ports() {
        // User hand-edited: expected_port mismatches ports[0].number.
        // migrate() must NOT rewrite ports. Version bumps v2 → v3 but
        // everything port-related stays untouched.
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
                    auto_restart_policy: None,
                    env_file: None,
                    depends_on: Vec::new(),
                }],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg.clone());
        assert_eq!(out.version, "3");
        assert_eq!(out.projects[0].scripts[0].ports, cfg.projects[0].scripts[0].ports);
        assert_eq!(out.projects[0].scripts[0].expected_port, Some(9999));
    }

    #[test]
    fn migrate_preserves_depends_on_when_already_v2() {
        // S4 invariant: v1→v2 migrate must not touch depends_on (it's
        // a v2-era field and shouldn't get reset). After v3 lift, version
        // should be "3".
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
                    auto_restart_policy: None,
                    env_file: None,
                    depends_on: vec!["dep1".into(), "dep2".into()],
                }],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "3");
        assert_eq!(
            out.projects[0].scripts[0].depends_on,
            vec!["dep1".to_string(), "dep2".to_string()]
        );
        // ports[0] was synthesized from expected_port
        assert_eq!(out.projects[0].scripts[0].ports.len(), 1);
    }

    #[test]
    fn migrate_is_idempotent_on_v3() {
        // After one full migrate (v1 → v2 → v3), a second pass is a no-op.
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
        assert_eq!(out.version, "3");
        let out2 = ConfigStore::migrate(out.clone());
        assert_eq!(out2, out);
    }

    // --- v2 → v3 migration tests ---

    #[test]
    fn migrate_v2_to_v3_synthesizes_policy_from_auto_restart_true() {
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
                    expected_port: None,
                    ports: Vec::new(),
                    auto_restart: true,
                    auto_restart_policy: None,
                    env_file: None,
                    depends_on: Vec::new(),
                }],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "3");
        let pol = out.projects[0].scripts[0].auto_restart_policy.as_ref().unwrap();
        assert!(pol.enabled);
        assert_eq!(pol.max_retries, 5);
        assert_eq!(pol.backoff_ms, 1000);
        assert_eq!(pol.jitter_ms, 500);
    }

    #[test]
    fn migrate_v2_to_v3_leaves_policy_none_when_auto_restart_false() {
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
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "3");
        assert!(out.projects[0].scripts[0].auto_restart_policy.is_none());
    }

    #[test]
    fn save_hook_syncs_expected_port_from_first_port() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let cfg = AppConfig {
            version: "3".into(),
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
                    auto_restart_policy: None,
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

    #[cfg(unix)]
    #[test]
    fn save_sets_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        ConfigStore::save(&AppConfig::default(), &path).unwrap();
        let meta = fs::metadata(&path).unwrap();
        // Compare only the permission bits (mask 0o777).
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn load_relocks_to_0600_when_file_was_644() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        ConfigStore::save(&AppConfig::default(), &path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        let _ = ConfigStore::load(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn save_arms_watcher_suppression_window() {
        // H5: after save(), watcher_should_suppress() must be true for
        // roughly SUPPRESS_MS. We don't assert the exact deadline to
        // keep the test timing-robust, only that save flips it on and
        // that no-save leaves it off.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        // Reset explicitly: previous tests may have armed the static.
        SUPPRESS_UNTIL_MS.store(0, Ordering::Relaxed);
        assert!(!watcher_should_suppress());
        ConfigStore::save(&AppConfig::default(), &path).unwrap();
        assert!(watcher_should_suppress());
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
