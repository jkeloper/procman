// procman domain types — shared between Rust backend and TS frontend.
//
// LEARN (Rust serde basics):
//   - `#[derive(Serialize, Deserialize)]` generates JSON/YAML conversion at
//     compile time. Without it, nothing crosses the IPC boundary.
//   - `#[serde(rename_all = "...")]` controls JSON field casing. We keep
//     snake_case on the wire (matches Rust idiom) and mirror on the TS side.
//   - `Option<T>` serializes to T or null. Prefer Option over sentinel values.
//   - `#[serde(default)]` on a field makes it optional when deserializing.
//   - Enum variant order matters for serde_yaml tag disambiguation.

use serde::{Deserialize, Serialize};

/// Top-level config file persisted to ~/Library/Application Support/procman/config.yaml
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppConfig {
    pub version: String,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub settings: AppSettings,
    /// Worker J: docker compose stacks registered by absolute path. Optional;
    /// pre-existing config.yaml files without this key remain valid.
    #[serde(default)]
    pub compose_projects: Vec<ComposeProject>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: "3".to_string(),
            projects: Vec::new(),
            groups: Vec::new(),
            settings: AppSettings::default(),
            compose_projects: Vec::new(),
        }
    }
}

/// A registered project folder. Scripts are stored inline to keep YAML
/// human-editable with less id-hopping.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Absolute filesystem path to the project directory.
    pub path: String,
    #[serde(default)]
    pub scripts: Vec<Script>,
}

/// A runnable script within a project (e.g. `pnpm dev`, `docker compose up`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Script {
    pub id: String,
    pub name: String,
    /// Shell command string — wrapped with `zsh -l -c` at spawn time (T12).
    pub command: String,
    /// DEPRECATED — S1 (port management v2): kept for v1 backward compatibility.
    /// Migration populates `ports[0]` from this field; save-time hook syncs
    /// `ports[0]` back into this field (double-write). Will be removed in v3.
    #[serde(default)]
    pub expected_port: Option<u16>,
    /// S1: Declared TCP ports. May be empty. Treated as the authoritative
    /// source for port conflict detection / tunnel target picking once any
    /// entry is present.
    #[serde(default)]
    pub ports: Vec<PortSpec>,
    #[serde(default)]
    pub auto_restart: bool,
    /// v3: Structured auto-restart policy (max_retries / backoff_ms / jitter_ms).
    /// When present AND `enabled`, supersedes the legacy `auto_restart` bool.
    /// When `None`, falls back to `auto_restart` (exponential backoff).
    #[serde(default)]
    pub auto_restart_policy: Option<AutoRestartPolicy>,
    /// M5: Optional path to a .env file. Variables are exported before running.
    #[serde(default)]
    pub env_file: Option<String>,
    /// S4: IDs of other scripts (within the same config) that must be
    /// running + reachable before this one spawns. Circular deps are
    /// detected at spawn time and fail fast. Empty = no dependencies.
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// S1: Per-script declared port. A PortSpec is purely a *declaration* — it
/// records what the script is expected to bind. Runtime ownership and
/// liveness are computed separately (see v3 for owner-proof + health probes).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortSpec {
    /// Short logical name ("web", "debug", "metrics"). Used in UI labels
    /// and as a lookup key for tunnel target selection. Must be unique
    /// within a single Script (enforced at save time).
    pub name: String,
    /// TCP port number. 1..=65535. 0 is reserved for v3 "dynamic".
    pub number: u16,
    /// Bind address. Default "127.0.0.1". Displayed only — we never
    /// actually bind. Used as a hint for conflict messaging.
    #[serde(default = "default_bind")]
    pub bind: String,
    /// Protocol. v2 only accepts "tcp". Enum exists so YAML files don't
    /// need rewriting when UDP support lands.
    #[serde(default = "default_proto")]
    pub proto: PortProto,
    /// If true, start proceeds even if this port is in conflict (UI still
    /// surfaces a warning and requires an explicit skip). Default false.
    #[serde(default)]
    pub optional: bool,
    /// Free-form human note ("Vite HMR websocket", "JDWP debug").
    #[serde(default)]
    pub note: Option<String>,
}

fn default_bind() -> String {
    "127.0.0.1".to_string()
}
fn default_proto() -> PortProto {
    PortProto::Tcp
}

/// v3: Auto-restart policy. When `enabled`, the watcher restarts a crashed
/// script after `backoff_ms + rand(0..jitter_ms)` up to `max_retries` times.
/// `max_retries = 0` means unlimited (matches the legacy `auto_restart: true`
/// behaviour with no ceiling).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutoRestartPolicy {
    pub enabled: bool,
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
    #[serde(default = "default_backoff_ms")]
    pub backoff_ms: u32,
    #[serde(default = "default_jitter_ms")]
    pub jitter_ms: u32,
}

fn default_max_retries() -> u32 {
    5
}
fn default_backoff_ms() -> u32 {
    1000
}
fn default_jitter_ms() -> u32 {
    500
}

impl Default for AutoRestartPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            max_retries: default_max_retries(),
            backoff_ms: default_backoff_ms(),
            jitter_ms: default_jitter_ms(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PortProto {
    Tcp,
    // Udp — v3
}

/// A named collection of scripts that can be launched together ("Morning Stack").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Group {
    pub id: String,
    pub name: String,
    /// References to (project_id, script_id) pairs that belong to the group.
    #[serde(default)]
    pub members: Vec<GroupMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroupMember {
    pub project_id: String,
    pub script_id: String,
}

/// Application-wide settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppSettings {
    pub log_buffer_size: usize,
    pub port_poll_interval_ms: u64,
    pub theme: String,
    /// User-defined aliases for ports (e.g. 3000 → "Frontend", 5432 → "Postgres").
    #[serde(default)]
    pub port_aliases: std::collections::HashMap<u16, String>,
    /// v3: User has explicitly opted into the LAN remote server mode.
    /// Server routes use this as a gate so that discovery on a coffee-shop
    /// Wi-Fi can never surface procman without the user's intent.
    #[serde(default)]
    pub lan_mode_opt_in: bool,
    /// v3: Launch procman at login via a LaunchAgent plist.
    /// Actual plist management is handled by `autostart.rs`; this field
    /// is the user-visible source of truth that the FE toggles.
    #[serde(default)]
    pub start_at_login: bool,
    /// v3: First-run onboarding has been completed. Hides welcome / tips.
    #[serde(default)]
    pub onboarded: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            log_buffer_size: 5000,
            port_poll_interval_ms: 1000,
            theme: "system".to_string(),
            port_aliases: std::collections::HashMap::new(),
            lan_mode_opt_in: false,
            start_at_login: false,
            onboarded: false,
        }
    }
}

// --- Runtime-only types (not persisted to config.yaml) ---

/// Source of a log line. Runtime-only type; single authoritative definition.
/// See process.rs for RuntimeStatus (Running/Stopped/Crashed) and
/// log_buffer.rs for LogLine (which embeds LogStream + monotonic seq).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// Worker J: a registered `docker-compose.yml` stack. Persisted in config.yaml.
/// Execution is always "path-by-reference" — procman never copies the file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComposeProject {
    pub id: String,
    pub name: String,
    /// Absolute path to a docker-compose.yml / compose.yaml.
    pub compose_path: String,
    /// Optional `-p` project-name override. When None, docker derives it
    /// from the file's parent directory.
    #[serde(default)]
    pub project_name: Option<String>,
}

/// Worker J: runtime-only shape returned by `docker compose ps --format json`.
/// Not persisted.
#[derive(Debug, Clone, Serialize)]
pub struct ComposeService {
    pub service: String,
    pub image: Option<String>,
    /// running / exited / paused / ... (raw string from docker)
    pub state: String,
    /// Raw port strings e.g. "0.0.0.0:5432->5432/tcp". Displayed as-is.
    pub ports: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub port: u16,
    pub pid: u32,
    pub process_name: String,
    /// Full command line from `ps` (e.g. "node /Users/.../server.js --port 3000")
    #[serde(default)]
    pub command: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_empty_config() {
        let cfg = AppConfig::default();
        let yaml = serde_yaml::to_string(&cfg).unwrap();
        let back: AppConfig = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(cfg, back);
    }

    #[test]
    fn roundtrip_full_config() {
        let cfg = AppConfig {
            version: "1".into(),
            projects: vec![Project {
                id: "p1".into(),
                name: "web".into(),
                path: "/tmp/web".into(),
                scripts: vec![
                    Script {
                        id: "s1".into(),
                        name: "dev".into(),
                        command: "pnpm dev".into(),
                        expected_port: Some(5173),
                        ports: Vec::new(),
                        auto_restart: false,
                        auto_restart_policy: None,
                        env_file: None,
                        depends_on: Vec::new(),
                    },
                    Script {
                        id: "s2".into(),
                        name: "db".into(),
                        command: "docker compose up".into(),
                        expected_port: None,
                        ports: Vec::new(),
                        auto_restart: true,
                        auto_restart_policy: None,
                        env_file: None,
                        depends_on: Vec::new(),
                    },
                ],
            }],
            groups: vec![Group {
                id: "g1".into(),
                name: "morning".into(),
                members: vec![GroupMember {
                    project_id: "p1".into(),
                    script_id: "s1".into(),
                }],
            }],
            settings: AppSettings {
                log_buffer_size: 10000,
                port_poll_interval_ms: 500,
                theme: "dark".into(),
                port_aliases: std::collections::HashMap::new(),
                lan_mode_opt_in: false,
                start_at_login: false,
                onboarded: false,
            },
            compose_projects: Vec::new(),
        };
        let yaml = serde_yaml::to_string(&cfg).unwrap();
        let back: AppConfig = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(cfg, back);
    }

    #[test]
    fn app_config_accepts_missing_compose_projects() {
        // Legacy config.yaml without the new key deserializes cleanly.
        let yaml = "version: '3'\nprojects: []\ngroups: []\n";
        let cfg: AppConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(cfg.compose_projects.is_empty());
    }

    #[test]
    fn compose_project_roundtrip() {
        let cp = ComposeProject {
            id: "u1".into(),
            name: "stack".into(),
            compose_path: "/tmp/docker-compose.yml".into(),
            project_name: Some("mystack".into()),
        };
        let yaml = serde_yaml::to_string(&cp).unwrap();
        let back: ComposeProject = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(cp, back);
    }

    #[test]
    fn deserialize_minimal_yaml() {
        let yaml = "version: '2'\n";
        let cfg: AppConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(cfg.version, "2");
        assert_eq!(cfg.projects.len(), 0);
        assert_eq!(cfg.settings.log_buffer_size, 5000); // default applied
    }

    #[test]
    fn port_spec_roundtrip_with_defaults() {
        // Minimal YAML should fill defaults: bind=127.0.0.1, proto=tcp, optional=false
        let yaml = "name: http\nnumber: 8080\n";
        let spec: PortSpec = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(spec.name, "http");
        assert_eq!(spec.number, 8080);
        assert_eq!(spec.bind, "127.0.0.1");
        assert_eq!(spec.proto, PortProto::Tcp);
        assert!(!spec.optional);
        assert!(spec.note.is_none());
    }

    #[test]
    fn script_roundtrip_with_multiple_ports() {
        let s = Script {
            id: "s".into(),
            name: "api".into(),
            command: "./gradlew bootRun".into(),
            expected_port: Some(8080),
            ports: vec![
                PortSpec {
                    name: "http".into(),
                    number: 8080,
                    bind: "0.0.0.0".into(),
                    proto: PortProto::Tcp,
                    optional: false,
                    note: None,
                },
                PortSpec {
                    name: "debug".into(),
                    number: 5005,
                    bind: "127.0.0.1".into(),
                    proto: PortProto::Tcp,
                    optional: false,
                    note: Some("JDWP".into()),
                },
                PortSpec {
                    name: "metrics".into(),
                    number: 9010,
                    bind: "127.0.0.1".into(),
                    proto: PortProto::Tcp,
                    optional: true,
                    note: None,
                },
            ],
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            depends_on: Vec::new(),
        };
        let yaml = serde_yaml::to_string(&s).unwrap();
        let back: Script = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(s, back);
        assert_eq!(back.ports.len(), 3);
    }

    #[test]
    fn auto_restart_policy_default_values() {
        let p = AutoRestartPolicy::default();
        assert!(p.enabled);
        assert_eq!(p.max_retries, 5);
        assert_eq!(p.backoff_ms, 1000);
        assert_eq!(p.jitter_ms, 500);
    }

    #[test]
    fn auto_restart_policy_yaml_partial_fills_defaults() {
        // Only `enabled` specified; serde defaults fill the rest.
        let yaml = "enabled: true\n";
        let p: AutoRestartPolicy = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(p, AutoRestartPolicy::default());
    }

    #[test]
    fn app_settings_defaults_v3_fields() {
        let s = AppSettings::default();
        assert!(!s.lan_mode_opt_in);
        assert!(!s.start_at_login);
        assert!(!s.onboarded);
    }

    #[test]
    fn roundtrip_script_with_quotes_and_parens() {
        let script = Script {
            id: "abc".into(),
            name: "Backend (Spring Boot local)".into(),
            command: "./gradlew bootRun --args='--spring.profiles.active=local'".into(),
            expected_port: None,
            ports: Vec::new(),
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            depends_on: Vec::new(),
        };
        let yaml = serde_yaml::to_string(&script).unwrap();
        eprintln!("serialized:\n{}", yaml);
        let back: Script = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(script, back);
    }
}
