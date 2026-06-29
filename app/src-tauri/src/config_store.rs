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

use crate::types::{AppConfig, AutoRestartPolicy, PortSpec};
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
        // WS7-2: `Script.expected_port` was removed from the struct, but
        // pre-v4 config.yaml files still carry it as a top-level scalar with
        // an empty/absent `ports[]`. serde would silently drop the unknown
        // key on deserialize, losing the port (and its conflict detection).
        // So we promote it into `ports[]` at the raw-YAML level FIRST, then
        // deserialize. This is the v3→v4 port migration.
        let mut value: serde_yaml::Value = serde_yaml::from_slice(&bytes)?;
        Self::promote_expected_port_in_value(&mut value);
        let mut cfg: AppConfig = serde_yaml::from_value(value)?;
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

    /// WS7-2 (v3 → v4 port migration, applied at the raw-YAML level in
    /// `load()` BEFORE struct deserialization). The legacy
    /// `Script.expected_port` scalar was removed from the struct, so we must
    /// rescue it here: for every script whose `ports` is empty/absent but
    /// which carries an `expected_port: <n>`, synthesize `ports[0]` from it.
    /// The scalar is then dropped (serde ignores the unknown key).
    ///
    /// This is what preserves conflict detection for hand-edited configs that
    /// only ever set `expected_port`: the value lands in `ports[]`, which is
    /// the single authoritative source the conflict checker reads.
    ///
    /// Idempotent: a config with no `expected_port` keys (already v4, or
    /// hand-edited to use `ports`) passes through untouched. If both
    /// `expected_port` and a non-empty `ports` are present (user hand-edited
    /// a richer file), `ports` wins and `expected_port` is dropped.
    fn promote_expected_port_in_value(value: &mut serde_yaml::Value) {
        use serde_yaml::Value;
        let Some(projects) = value.get_mut("projects").and_then(Value::as_sequence_mut) else {
            return;
        };
        for project in projects.iter_mut() {
            let Some(scripts) = project.get_mut("scripts").and_then(Value::as_sequence_mut) else {
                continue;
            };
            for script in scripts.iter_mut() {
                let Some(map) = script.as_mapping_mut() else {
                    continue;
                };
                // Pull and remove the legacy scalar regardless of outcome.
                let legacy = map
                    .remove(Value::from("expected_port"))
                    .and_then(|v| v.as_u64())
                    .and_then(|n| u16::try_from(n).ok());
                let ports_empty = match map.get(Value::from("ports")) {
                    Some(Value::Sequence(seq)) => seq.is_empty(),
                    Some(Value::Null) | None => true,
                    _ => false,
                };
                if ports_empty {
                    if let Some(p) = legacy {
                        let spec = PortSpec {
                            name: "default".to_string(),
                            number: p,
                            bind: "127.0.0.1".to_string(),
                            optional: false,
                            note: None,
                        };
                        let spec_val =
                            serde_yaml::to_value(vec![spec]).unwrap_or(Value::Sequence(Vec::new()));
                        map.insert(Value::from("ports"), spec_val);
                    }
                }
            }
        }
    }

    /// Apply schema migrations sequentially (version-bump only — the
    /// port-promotion side of the v3→v4 migration runs at the raw-YAML level
    /// in `load()` via `promote_expected_port_in_value`).
    pub(crate) fn migrate(mut cfg: AppConfig) -> AppConfig {
        if cfg.version.is_empty() {
            cfg.version = "1".to_string();
        }

        // v1 → v2 (S1 port management v2). Port promotion was historically
        // done here from `expected_port`; that now happens at the raw-YAML
        // level for every pre-v4 config (see promote_expected_port_in_value),
        // so this step is just a version bump.
        if cfg.version == "1" {
            cfg.version = "2".to_string();
        }

        if cfg.version == "2" {
            cfg = Self::migrate_v2_to_v3(cfg);
        }

        if cfg.version == "3" {
            cfg = Self::migrate_v3_to_v4(cfg);
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

    /// v3 → v4 (WS7-2): version bump. The data side of this migration —
    /// promoting the legacy `expected_port` scalar into `ports[]` and
    /// dropping it — runs at the raw-YAML level in `load()` before the struct
    /// is parsed. By the time we reach here, every script already has its port
    /// in `ports[]`, so this is purely a ceiling bump. Idempotent.
    pub(crate) fn migrate_v3_to_v4(mut cfg: AppConfig) -> AppConfig {
        cfg.version = "4".to_string();
        cfg
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
        let yaml = serde_yaml::to_string(cfg)?;

        // Temp file in the same directory → rename is atomic on same FS.
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        tmp.write_all(yaml.as_bytes())?;
        tmp.as_file().sync_all()?;
        tmp.persist(path).map_err(|e| ConfigError::Io(e.error))?;
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
    use crate::types::{PortSpec, Project, Script};

    /// Build a script whose declared port is already promoted (post-v4 shape).
    /// `port = Some(n)` puts a single PortSpec in `ports`; `None` = portless.
    fn mk_script(id: &str, port: Option<u16>) -> Script {
        Script {
            id: id.into(),
            name: id.into(),
            command: "pnpm dev".into(),
            ports: port
                .map(|p| {
                    vec![PortSpec {
                        name: "default".into(),
                        number: p,
                        bind: "127.0.0.1".into(),
                        optional: false,
                        note: None,
                    }]
                })
                .unwrap_or_default(),
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            schedule: None,
            depends_on: Vec::new(),
        }
    }

    /// Write a raw YAML string to a temp config file and return its path's dir.
    fn write_config(dir: &std::path::Path, yaml: &str) -> std::path::PathBuf {
        let path = dir.join("config.yaml");
        std::fs::write(&path, yaml).unwrap();
        path
    }

    #[test]
    fn load_missing_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent.yaml");
        let cfg = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg, AppConfig::default());
    }

    #[test]
    fn save_then_load_roundtrip_v4() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.yaml");
        let cfg = AppConfig {
            version: "4".into(),
            projects: vec![Project {
                id: "p1".into(),
                name: "web".into(),
                path: "/tmp".into(),
                scripts: vec![Script {
                    id: "s1".into(),
                    name: "dev".into(),
                    command: "pnpm dev".into(),
                    ports: vec![PortSpec {
                        name: "default".into(),
                        number: 3000,
                        bind: "127.0.0.1".into(),
                        optional: false,
                        note: None,
                    }],
                    auto_restart: false,
                    auto_restart_policy: None,
                    env_file: None,
                    schedule: None,
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

    // --- WS7-2 v3 → v4 port migration (raw-YAML promotion) ---

    #[test]
    fn load_v3_with_expected_port_promotes_to_ports() {
        // A pre-v4 config carrying the legacy `expected_port` scalar and an
        // empty ports list. load() must rescue it into ports[0] (so conflict
        // detection keeps working) and bump the version to "4".
        let dir = tempfile::tempdir().unwrap();
        let yaml = r"version: '3'
projects:
  - id: p
    name: p
    path: /tmp
    scripts:
      - id: s
        name: dev
        command: pnpm dev
        expected_port: 3000
        ports: []
";
        let path = write_config(dir.path(), yaml);
        let cfg = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg.version, "4");
        let s = &cfg.projects[0].scripts[0];
        assert_eq!(s.ports.len(), 1);
        assert_eq!(s.ports[0].name, "default");
        assert_eq!(s.ports[0].number, 3000);
        assert_eq!(s.ports[0].bind, "127.0.0.1");
    }

    #[test]
    fn load_v1_with_expected_port_and_no_ports_key_promotes() {
        // Oldest shape: no `ports` key at all, only `expected_port`. Must
        // still promote and chain v1 → … → v4.
        let dir = tempfile::tempdir().unwrap();
        let yaml = r"version: '1'
projects:
  - id: p
    name: p
    path: /tmp
    scripts:
      - id: s
        name: dev
        command: pnpm dev
        expected_port: 5173
";
        let path = write_config(dir.path(), yaml);
        let cfg = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg.version, "4");
        assert_eq!(cfg.projects[0].scripts[0].ports.len(), 1);
        assert_eq!(cfg.projects[0].scripts[0].ports[0].number, 5173);
    }

    #[test]
    fn load_v2_with_expected_port_promotes_to_ports() {
        // A v2 config carrying the legacy `expected_port` scalar (no ports key)
        // must promote into ports[0] and chain v2 → v3 → v4, exactly like the
        // v1/v3 paths. Locks the version-agnostic raw-YAML promotion.
        let dir = tempfile::tempdir().unwrap();
        let yaml = r"version: '2'
projects:
  - id: p
    name: p
    path: /tmp
    scripts:
      - id: s
        name: dev
        command: pnpm dev
        expected_port: 4321
";
        let path = write_config(dir.path(), yaml);
        let cfg = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg.version, "4");
        let s = &cfg.projects[0].scripts[0];
        assert_eq!(s.ports.len(), 1);
        assert_eq!(s.ports[0].number, 4321);
        assert_eq!(s.ports[0].bind, "127.0.0.1");
    }

    #[test]
    fn load_without_expected_port_yields_empty_ports() {
        let dir = tempfile::tempdir().unwrap();
        let yaml = r"version: '3'
projects:
  - id: p
    name: p
    path: /tmp
    scripts:
      - id: s
        name: dev
        command: pnpm dev
";
        let path = write_config(dir.path(), yaml);
        let cfg = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg.version, "4");
        assert!(cfg.projects[0].scripts[0].ports.is_empty());
    }

    #[test]
    fn load_with_existing_ports_drops_stale_expected_port() {
        // Hand-edited file: expected_port (stale) AND a real ports list.
        // ports[] wins; the scalar is dropped. This is the conflict-
        // detection preservation invariant — the authoritative ports[]
        // is never overwritten by the legacy scalar.
        let dir = tempfile::tempdir().unwrap();
        let yaml = r"version: '3'
projects:
  - id: p
    name: p
    path: /tmp
    scripts:
      - id: s
        name: s
        command: cmd
        expected_port: 9999
        ports:
          - name: http
            number: 8080
            bind: 0.0.0.0
            optional: false
            note: null
";
        let path = write_config(dir.path(), yaml);
        let cfg = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg.version, "4");
        let ports = &cfg.projects[0].scripts[0].ports;
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].number, 8080);
        assert_eq!(ports[0].bind, "0.0.0.0");
    }

    #[test]
    fn load_with_legacy_proto_field_still_parses() {
        // Pre-WS7-2 file: PortSpec carries `proto: tcp`. The field was
        // removed; serde must ignore the unknown key (no deny_unknown_fields).
        let dir = tempfile::tempdir().unwrap();
        let yaml = r"version: '3'
projects:
  - id: p
    name: p
    path: /tmp
    scripts:
      - id: s
        name: s
        command: cmd
        ports:
          - name: http
            number: 8080
            bind: 127.0.0.1
            proto: tcp
            optional: false
            note: null
";
        let path = write_config(dir.path(), yaml);
        let cfg = ConfigStore::load(&path).unwrap();
        assert_eq!(cfg.version, "4");
        assert_eq!(cfg.projects[0].scripts[0].ports[0].number, 8080);
    }

    #[test]
    fn load_is_idempotent_on_v4() {
        // Save a v4 config, load it twice — second load is a no-op (the
        // scalar is already gone, version stays "4").
        let dir = tempfile::tempdir().unwrap();
        let cfg = AppConfig {
            version: "4".into(),
            projects: vec![Project {
                id: "p".into(),
                name: "p".into(),
                path: "/tmp".into(),
                scripts: vec![mk_script("s", Some(3000))],
            }],
            ..Default::default()
        };
        let path = dir.path().join("config.yaml");
        ConfigStore::save(&cfg, &path).unwrap();
        let first = ConfigStore::load(&path).unwrap();
        ConfigStore::save(&first, &path).unwrap();
        let second = ConfigStore::load(&path).unwrap();
        assert_eq!(first, second);
        assert_eq!(second.version, "4");
    }

    #[test]
    fn migrate_preserves_depends_on() {
        // S4 invariant: migration must not touch depends_on. Chains to "4".
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
                    ports: Vec::new(),
                    auto_restart: false,
                    auto_restart_policy: None,
                    env_file: None,
                    schedule: None,
                    depends_on: vec!["dep1".into(), "dep2".into()],
                }],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "4");
        assert_eq!(
            out.projects[0].scripts[0].depends_on,
            vec!["dep1".to_string(), "dep2".to_string()]
        );
    }

    #[test]
    fn migrate_is_idempotent_on_v4() {
        let cfg = AppConfig {
            version: "1".into(),
            projects: vec![Project {
                id: "p".into(),
                name: "p".into(),
                path: "/tmp".into(),
                scripts: vec![mk_script("s", Some(3000))],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "4");
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
                    ports: Vec::new(),
                    auto_restart: true,
                    auto_restart_policy: None,
                    env_file: None,
                    schedule: None,
                    depends_on: Vec::new(),
                }],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "4");
        let pol = out.projects[0].scripts[0]
            .auto_restart_policy
            .as_ref()
            .unwrap();
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
                scripts: vec![mk_script("s", Some(3000))],
            }],
            ..Default::default()
        };
        let out = ConfigStore::migrate(cfg);
        assert_eq!(out.version, "4");
        assert!(out.projects[0].scripts[0].auto_restart_policy.is_none());
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
