// Project auto-detection — scan a directory for package.json files.
//
// LEARN (walking filesystems safely):
//   - `walkdir` traverses recursively; use `.filter_entry()` to prune
//     early (otherwise you walk into node_modules and waste seconds).
//   - Parsing JSON: serde_json::Value for loose parsing (fields may be
//     missing) vs a strict typed struct. We use Value here since
//     package.json varies wildly in the wild.
//   - max_depth keeps scans bounded — most monorepos have projects at
//     depth ≤ 4 from a workspace root.

use crate::types::Script;
use serde::Serialize;
use std::path::Path;
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

const MAX_DEPTH: usize = 5;
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".next",
    ".nuxt", "__pycache__", ".venv", "venv", ".cache",
];

/// A project candidate detected from a package.json scan.
/// Not yet persisted — frontend chooses which to import.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectCandidate {
    /// Detected project name (from package.json "name" or directory name).
    pub name: String,
    /// Absolute path to the directory containing package.json.
    pub path: String,
    /// Scripts extracted from package.json's "scripts" field.
    pub scripts: Vec<Script>,
}

fn is_skipped(e: &DirEntry) -> bool {
    e.file_name()
        .to_str()
        .map(|s| SKIP_DIRS.contains(&s))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn scan_directory(path: String) -> Result<Vec<ProjectCandidate>, String> {
    let root = Path::new(&path);
    if !root.exists() || !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    let mut candidates = Vec::new();
    let walker = WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_entry(|e| !is_skipped(e));

    for entry in walker.filter_map(|e| e.ok()) {
        if entry.file_type().is_file() && entry.file_name() == "package.json" {
            let pkg_path = entry.path();
            let parent = match pkg_path.parent() {
                Some(p) => p,
                None => continue,
            };
            let bytes = match std::fs::read(pkg_path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let json: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(_) => continue, // malformed package.json — skip silently
            };

            let name = json
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    parent
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unnamed")
                        .to_string()
                });

            let scripts = json
                .get("scripts")
                .and_then(|v| v.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| {
                            let cmd = v.as_str()?.to_string();
                            Some(Script {
                                id: Uuid::new_v4().to_string(),
                                name: k.clone(),
                                command: format!("pnpm {}", k),
                                expected_port: infer_port(&cmd),
                                auto_restart: false,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            candidates.push(ProjectCandidate {
                name,
                path: parent.to_string_lossy().into_owned(),
                scripts,
            });
        }
    }
    Ok(candidates)
}

/// Heuristic: pull --port N or -p N from a command string.
fn infer_port(cmd: &str) -> Option<u16> {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    for i in 0..tokens.len().saturating_sub(1) {
        if matches!(tokens[i], "--port" | "-p" | "--PORT") {
            if let Ok(n) = tokens[i + 1].parse::<u16>() {
                return Some(n);
            }
        }
    }
    // Also catch `--port=3000` style
    for t in &tokens {
        if let Some(rest) = t.strip_prefix("--port=") {
            if let Ok(n) = rest.parse::<u16>() {
                return Some(n);
            }
        }
    }
    None
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
}
