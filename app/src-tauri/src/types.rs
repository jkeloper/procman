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
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            projects: Vec::new(),
            groups: Vec::new(),
            settings: AppSettings::default(),
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
    #[serde(default)]
    pub expected_port: Option<u16>,
    #[serde(default)]
    pub auto_restart: bool,
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
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            log_buffer_size: 5000,
            port_poll_interval_ms: 1000,
            theme: "system".to_string(),
        }
    }
}

// --- Runtime-only types (not persisted to config.yaml) ---

/// Current status of a running (or recently-stopped) process instance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStatus {
    Running,
    Stopped,
    Error,
}

/// Runtime handle for a script invocation — one per active process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessHandle {
    pub id: String,
    pub project_id: String,
    pub script_id: String,
    pub status: ProcessStatus,
    pub pid: Option<u32>,
    pub started_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub ts_ms: u64,
    pub stream: LogStream,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub port: u16,
    pub pid: u32,
    pub process_name: String,
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
                        auto_restart: false,
                    },
                    Script {
                        id: "s2".into(),
                        name: "db".into(),
                        command: "docker compose up".into(),
                        expected_port: None,
                        auto_restart: true,
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
            },
        };
        let yaml = serde_yaml::to_string(&cfg).unwrap();
        let back: AppConfig = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(cfg, back);
    }

    #[test]
    fn deserialize_minimal_yaml() {
        let yaml = "version: '1'\n";
        let cfg: AppConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(cfg.version, "1");
        assert_eq!(cfg.projects.len(), 0);
        assert_eq!(cfg.settings.log_buffer_size, 5000); // default applied
    }
}
