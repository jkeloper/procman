// Project auto-detection — scan a directory for project markers.
//
// LEARN (walking filesystems safely):
//   - `walkdir` traverses recursively; `min_depth(1)` skips the root itself,
//     `max_depth(2)` keeps us at one subdir level (projects/<name>/marker).
//   - We detect multiple ecosystems via well-known marker files:
//     package.json (Node), Cargo.toml (Rust), go.mod (Go),
//     pyproject.toml / requirements.txt (Python), docker-compose.yml.
//   - For each subdirectory, we collect ALL markers present and merge the
//     scripts they define — so a Rust+Docker project shows both sets.

use crate::types::Script;
use crate::vscode_scanner;
use serde::Serialize;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const NODE_MARKERS: &[&str] = &["package.json"];
const RUST_MARKERS: &[&str] = &["Cargo.toml"];
const GO_MARKERS: &[&str] = &["go.mod"];
const PY_MARKERS: &[&str] = &["pyproject.toml", "requirements.txt", "setup.py"];
const DOCKER_MARKERS: &[&str] = &["docker-compose.yml", "docker-compose.yaml", "compose.yml"];

/// A project candidate detected from a directory scan.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectCandidate {
    /// Detected project name (directory name, or from manifest if clearer).
    pub name: String,
    /// Absolute path to the project directory.
    pub path: String,
    /// Detected ecosystems: ["node", "rust", "go", "python", "docker"].
    pub stacks: Vec<String>,
    /// Scripts suggested from detected manifests.
    pub scripts: Vec<Script>,
}

#[tauri::command]
pub async fn scan_directory(path: String) -> Result<Vec<ProjectCandidate>, String> {
    let root = Path::new(&path);
    if !root.exists() || !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    // Only look at direct children of `root`. Example: if root is
    // /Users/foo/projects, we detect /Users/foo/projects/procman but NOT
    // /Users/foo/projects/procman/app.
    let mut candidates = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => return Err(format!("read_dir: {}", e)),
    };

    for entry in entries.filter_map(|e| e.ok()) {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let dir = entry.path();
        // Skip hidden dirs by name
        if let Some(name) = dir.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }

        if let Some(candidate) = detect_project(&dir) {
            candidates.push(candidate);
        }
    }

    // Fallback: if nothing was found in children, try treating `root` itself
    // as a project. This handles the case where the user picked the project
    // folder directly instead of its parent.
    if candidates.is_empty() {
        if let Some(candidate) = detect_project(root) {
            candidates.push(candidate);
        }
    }

    // Stable order: by directory name
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(candidates)
}

fn detect_project(dir: &Path) -> Option<ProjectCandidate> {
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();

    let mut stacks = Vec::new();
    let mut scripts = Vec::new();

    // Node
    if has_any(dir, NODE_MARKERS) {
        stacks.push("node".into());
        scripts.extend(scripts_from_package_json(&dir.join("package.json")));
    }
    // Rust
    if has_any(dir, RUST_MARKERS) {
        stacks.push("rust".into());
        scripts.push(Script {
            id: Uuid::new_v4().to_string(),
            name: "cargo run".into(),
            command: "cargo run".into(),
            expected_port: None,
            auto_restart: false,
        });
        scripts.push(Script {
            id: Uuid::new_v4().to_string(),
            name: "cargo test".into(),
            command: "cargo test".into(),
            expected_port: None,
            auto_restart: false,
        });
    }
    // Go
    if has_any(dir, GO_MARKERS) {
        stacks.push("go".into());
        scripts.push(Script {
            id: Uuid::new_v4().to_string(),
            name: "go run".into(),
            command: "go run .".into(),
            expected_port: None,
            auto_restart: false,
        });
    }
    // Python
    if has_any(dir, PY_MARKERS) {
        stacks.push("python".into());
        if dir.join("manage.py").exists() {
            scripts.push(Script {
                id: Uuid::new_v4().to_string(),
                name: "django runserver".into(),
                command: "python manage.py runserver".into(),
                expected_port: Some(8000),
                auto_restart: false,
            });
        }
    }
    // VSCode launch.json — detect + merge importable configs
    let vscode_launch = dir.join(".vscode").join("launch.json");
    if vscode_launch.exists() {
        stacks.push("vscode".into());
        // Parse the launch.json and pull in any importable configs.
        if let Ok(candidates) = vscode_scanner::scan_launch_json(dir) {
            for c in candidates {
                if let Some(s) = c.script {
                    scripts.push(s);
                }
            }
        }
    }

    // Docker Compose
    if has_any(dir, DOCKER_MARKERS) {
        stacks.push("docker".into());
        scripts.push(Script {
            id: Uuid::new_v4().to_string(),
            name: "compose up".into(),
            command: "docker compose up".into(),
            expected_port: None,
            auto_restart: false,
        });
        scripts.push(Script {
            id: Uuid::new_v4().to_string(),
            name: "compose down".into(),
            command: "docker compose down".into(),
            expected_port: None,
            auto_restart: false,
        });
    }

    if stacks.is_empty() {
        return None;
    }

    Some(ProjectCandidate {
        name,
        path: dir.to_string_lossy().into_owned(),
        stacks,
        scripts,
    })
}

fn has_any(dir: &Path, markers: &[&str]) -> bool {
    markers.iter().any(|m| dir.join(m).exists())
}

fn scripts_from_package_json(path: &Path) -> Vec<Script> {
    let Ok(bytes) = std::fs::read(path) else {
        return vec![];
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return vec![];
    };
    let Some(scripts_obj) = json.get("scripts").and_then(|v| v.as_object()) else {
        return vec![];
    };
    // Detect package manager from presence of lock files
    let pm = detect_pm(path.parent().unwrap_or(Path::new(".")));
    scripts_obj
        .iter()
        .filter_map(|(k, v)| {
            let cmd_str = v.as_str()?;
            // SEC-05: validate script name — reject shell-injectable keys
            if !is_safe_script_name(k) {
                return None;
            }
            Some(Script {
                id: Uuid::new_v4().to_string(),
                name: k.clone(),
                command: format!("{} {}", pm, k),
                expected_port: infer_port(cmd_str),
                auto_restart: false,
            })
        })
        .collect()
}

fn detect_pm(dir: &Path) -> &'static str {
    if dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "bun"
    } else {
        "npm run"
    }
}

/// Heuristic: pull --port N or -p N from a command string.
/// SEC-05: Only allow alphanumeric + common npm script chars in names.
fn is_safe_script_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c))
}

fn infer_port(cmd: &str) -> Option<u16> {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    for i in 0..tokens.len().saturating_sub(1) {
        if matches!(tokens[i], "--port" | "-p" | "--PORT") {
            if let Ok(n) = tokens[i + 1].parse::<u16>() {
                return Some(n);
            }
        }
    }
    for t in &tokens {
        if let Some(rest) = t.strip_prefix("--port=") {
            if let Ok(n) = rest.parse::<u16>() {
                return Some(n);
            }
        }
    }
    None
}

#[allow(unused_imports)]
#[allow(dead_code)]
mod _ensure_path_buf_used {
    use super::PathBuf;
    #[allow(dead_code)]
    fn _never_called() -> PathBuf {
        PathBuf::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_inference() {
        assert_eq!(infer_port("vite dev --port 5173"), Some(5173));
        assert_eq!(infer_port("vite dev -p 3000"), Some(3000));
        assert_eq!(infer_port("vite --port=4000"), Some(4000));
        assert_eq!(infer_port("node server.js"), None);
    }

    #[test]
    fn detects_rust_project() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "[package]").unwrap();
        let c = detect_project(dir.path()).unwrap();
        assert!(c.stacks.contains(&"rust".to_string()));
        assert!(c.scripts.iter().any(|s| s.command == "cargo run"));
    }

    #[test]
    fn detects_multi_stack() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), "{}").unwrap();
        std::fs::write(dir.path().join("docker-compose.yml"), "version: '3'").unwrap();
        let c = detect_project(dir.path()).unwrap();
        assert!(c.stacks.contains(&"node".to_string()));
        assert!(c.stacks.contains(&"docker".to_string()));
    }

    #[test]
    fn detects_pm_from_lockfile() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(detect_pm(dir.path()), "pnpm");
    }
}
