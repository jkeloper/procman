// procman domain types — serde-serializable structures shared between
// the Rust backend and the React/TS frontend via Tauri's invoke() bridge.
//
// LEARN (Rust serde basics):
//   - `#[derive(Serialize, Deserialize)]` auto-generates JSON conversion code
//     at compile time. Without it, Tauri can't ship these over the IPC boundary.
//   - `#[serde(rename_all = "...")]` changes how enum variants appear in JSON.
//     The TS side uses lowercase tagged unions; Rust uses PascalCase idiomatically.
//   - `Option<T>` in Rust serializes to T or `null` in JSON. TS consumers see
//     `T | null`. Prefer Option over sentinel values.
//   - Field names MUST match the TS type mirror in src/api/schemas.ts.
//     A mismatch = silent IPC failure (deserialize returns Err).

use serde::{Deserialize, Serialize};

/// A registered project folder containing scripts to run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Absolute filesystem path to the project directory.
    pub path: String,
}

/// A script registered under a project (e.g. `pnpm dev`, `docker compose up`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Script {
    pub id: String,
    pub project_id: String,
    pub name: String,
    /// Shell command string — will be wrapped with `zsh -l -c` at spawn.
    pub command: String,
    pub expected_port: Option<u16>,
}

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
    /// OS process id. None when not running.
    pub pid: Option<u32>,
    /// Unix epoch ms when the process started.
    pub started_at_ms: Option<u64>,
}

/// Source stream for a log line.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// A single buffered log line from a process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub ts_ms: u64,
    pub stream: LogStream,
    pub text: String,
}

/// Information about a TCP port bound on localhost.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub port: u16,
    pub pid: u32,
    pub process_name: String,
}
