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

    // Decision tree:
    //   1. If the scan root itself looks like a project (has a manifest
    //      or .vscode/launch.json), treat it AS the project. Sub-folders
    //      like `frontend/` or `backend/` are part of it, not separate
    //      projects. This matches the intent of "I picked my project
    //      folder, not a parent container".
    //   2. Otherwise scan direct children and return each child that
    //      registers as a project. This is the "I picked a folder of
    //      projects" case.
    if is_project_root(root) {
        if let Some(c) = detect_project(root) {
            return Ok(vec![c]);
        }
    }

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

    // Stable order: by directory name
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(candidates)
}

/// A directory "is a project root" if it contains any top-level
/// project marker: a manifest, a .vscode/launch.json, or a Docker
/// compose file. This is how we decide whether the user scanned the
/// project itself vs a parent folder of projects.
fn is_project_root(dir: &Path) -> bool {
    let markers = [
        "package.json",
        "Cargo.toml",
        "go.mod",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "pyproject.toml",
        "requirements.txt",
        "setup.py",
        "pubspec.yaml",
        "Package.swift",
        "mix.exs",
        "Gemfile",
        "composer.json",
        "deno.json",
        "bun.lockb",
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
    ];
    if markers.iter().any(|m| dir.join(m).exists()) {
        return true;
    }
    dir.join(".vscode").join("launch.json").exists()
}

fn detect_project(dir: &Path) -> Option<ProjectCandidate> {
    // Prefer manifest-declared name over the directory name so projects
    // read natively (e.g. "arch-planner" from pom.xml instead of a cwd
    // folder that happens to be named "backend").
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unnamed")
        .to_string();
    let name = manifest_name(dir).unwrap_or_else(|| dir_name.clone());

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
            ports: Vec::new(),
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            depends_on: Vec::new(),
        });
        scripts.push(Script {
            id: Uuid::new_v4().to_string(),
            name: "cargo test".into(),
            command: "cargo test".into(),
            expected_port: None,
            ports: Vec::new(),
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            depends_on: Vec::new(),
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
            ports: Vec::new(),
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            depends_on: Vec::new(),
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
                ports: Vec::new(),
                auto_restart: false,
                auto_restart_policy: None,
                env_file: None,
                depends_on: Vec::new(),
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
            ports: Vec::new(),
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            depends_on: Vec::new(),
        });
        scripts.push(Script {
            id: Uuid::new_v4().to_string(),
            name: "compose down".into(),
            command: "docker compose down".into(),
            expected_port: None,
            ports: Vec::new(),
            auto_restart: false,
            auto_restart_policy: None,
            env_file: None,
            depends_on: Vec::new(),
        });
    }

    if stacks.is_empty() {
        return None;
    }

    // Dedup scripts that share the same command or the same name.
    // A project may declare the same action in both package.json and
    // .vscode/launch.json (e.g. `npm run dev` twice). createScript
    // rejects duplicates on the backend with an error, which surfaced
    // as scary-looking import errors even though the duplicate was
    // harmless. Drop dups here so the first occurrence wins silently.
    //
    // The first occurrence preference matches our detection order:
    //   package.json scripts → launch.json → docker
    // package.json scripts usually have shorter, friendlier names
    // (`dev`, `start`), so keeping them avoids long verbose names
    // like "Next.js: dev server" for the same underlying command.
    let mut seen_cmds: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let scripts: Vec<Script> = scripts
        .into_iter()
        .filter(|s| {
            if seen_cmds.contains(&s.command) || seen_names.contains(&s.name) {
                return false;
            }
            seen_cmds.insert(s.command.clone());
            seen_names.insert(s.name.clone());
            true
        })
        .collect();

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

/// Try to read a human-readable project name from common manifest files.
/// Checked in priority order — first hit wins.
fn manifest_name(dir: &Path) -> Option<String> {
    // 1. package.json "name"
    if let Ok(bytes) = std::fs::read(dir.join("package.json")) {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(n) = v.get("name").and_then(|x| x.as_str()) {
                let n = n.trim();
                if !n.is_empty() {
                    // Strip scope if present: "@org/pkg" → "pkg"
                    let short = n.rsplit_once('/').map(|(_, r)| r).unwrap_or(n);
                    return Some(short.to_string());
                }
            }
        }
    }

    // 2. Cargo.toml  [package] name = "..."
    if let Some(n) = read_toml_package_name(&dir.join("Cargo.toml")) {
        return Some(n);
    }

    // 3. pyproject.toml  [project] name = "..."   or [tool.poetry] name = "..."
    if let Some(n) = read_toml_project_name(&dir.join("pyproject.toml")) {
        return Some(n);
    }

    // 4. pom.xml  <artifactId> or <name>
    if let Ok(text) = std::fs::read_to_string(dir.join("pom.xml")) {
        if let Some(n) = xml_tag(&text, "name").or_else(|| xml_tag(&text, "artifactId")) {
            return Some(n);
        }
    }

    // 5. settings.gradle / settings.gradle.kts  rootProject.name = "..."
    for f in ["settings.gradle", "settings.gradle.kts"] {
        if let Ok(text) = std::fs::read_to_string(dir.join(f)) {
            if let Some(n) = extract_kv(&text, "rootProject.name") {
                return Some(n);
            }
        }
    }

    // 6. go.mod  module <path>
    if let Ok(text) = std::fs::read_to_string(dir.join("go.mod")) {
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("module ") {
                let path = rest.trim().trim_matches('"');
                let short = path.rsplit('/').next().unwrap_or(path);
                if !short.is_empty() {
                    return Some(short.to_string());
                }
            }
        }
    }

    // 7. pubspec.yaml  name: ...
    if let Ok(text) = std::fs::read_to_string(dir.join("pubspec.yaml")) {
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("name:") {
                let v = rest.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }

    // 8. mix.exs  app: :name
    if let Ok(text) = std::fs::read_to_string(dir.join("mix.exs")) {
        if let Some(start) = text.find("app:") {
            let after = &text[start + 4..];
            let after = after.trim_start();
            if let Some(rest) = after.strip_prefix(':') {
                let end = rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .unwrap_or(rest.len());
                let n = &rest[..end];
                if !n.is_empty() {
                    return Some(n.to_string());
                }
            }
        }
    }

    None
}

/// Read [package] name = "..." from a TOML file (tolerant to whitespace).
fn read_toml_package_name(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut in_package = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
            continue;
        }
        if in_package {
            if let Some(n) = extract_kv(trimmed, "name") {
                return Some(n);
            }
        }
    }
    None
}

/// Read a project name from pyproject.toml. Supports PEP 621 [project]
/// and Poetry's [tool.poetry].
fn read_toml_project_name(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut section: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = Some(trimmed.trim_matches(|c| c == '[' || c == ']').to_string());
            continue;
        }
        if matches!(section.as_deref(), Some("project") | Some("tool.poetry")) {
            if let Some(n) = extract_kv(trimmed, "name") {
                return Some(n);
            }
        }
    }
    None
}

/// Parse `key = "value"` or `key = 'value'` from a single line.
/// Also handles `key: value` so it works on Gradle and similar formats.
fn extract_kv(line: &str, key: &str) -> Option<String> {
    let line = line.trim();
    let rest = line.strip_prefix(key)?.trim_start();
    let rest = rest
        .strip_prefix('=')
        .or_else(|| rest.strip_prefix(':'))?
        .trim_start();
    let v = rest
        .trim_end_matches(&[',', ';'][..])
        .trim()
        .trim_matches('"')
        .trim_matches('\'');
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// Extract the first `<tag>value</tag>` from a tiny XML blob (no full parser).
fn xml_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = text.find(&open)? + open.len();
    let end_rel = text[start..].find(&close)?;
    let v = text[start..start + end_rel].trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
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
                ports: Vec::new(),
                auto_restart: false,
                auto_restart_policy: None,
                env_file: None,
                depends_on: Vec::new(),
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

    #[test]
    fn prefers_package_json_name_over_dirname() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"name": "my-awesome-app", "scripts": {"dev": "vite"}}"#,
        ).unwrap();
        let c = detect_project(dir.path()).unwrap();
        assert_eq!(c.name, "my-awesome-app");
    }

    #[test]
    fn strips_scope_from_npm_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"name": "@acme/api-server"}"#,
        ).unwrap();
        // package.json alone needs another marker to register — add Docker
        std::fs::write(dir.path().join("docker-compose.yml"), "version: '3'").unwrap();
        let c = detect_project(dir.path()).unwrap();
        assert_eq!(c.name, "api-server");
    }

    #[test]
    fn prefers_cargo_toml_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("Cargo.toml"),
            r#"[package]
name = "my-rust-crate"
version = "0.1.0"
"#,
        ).unwrap();
        let c = detect_project(dir.path()).unwrap();
        assert_eq!(c.name, "my-rust-crate");
    }

    #[test]
    fn prefers_pom_artifact_id() {
        let dir = tempfile::tempdir().unwrap();
        // maven project — create docker marker so it registers as a project
        std::fs::write(
            dir.path().join("pom.xml"),
            r#"<?xml version="1.0"?>
<project>
  <artifactId>arch-planner</artifactId>
  <name>Arch Planner Backend</name>
</project>"#,
        ).unwrap();
        std::fs::write(dir.path().join("docker-compose.yml"), "version: '3'").unwrap();
        let c = detect_project(dir.path()).unwrap();
        // <name> wins over <artifactId>
        assert_eq!(c.name, "Arch Planner Backend");
    }

    #[test]
    fn monorepo_with_node_terminal_and_compound() {
        // Covers the Arch Planner / moyeo case: a monorepo with
        // node-terminal launch configs (some in subdirectories) plus
        // a compound that runs them all. All four + docker compose
        // scripts must survive the scan.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".vscode")).unwrap();
        std::fs::write(
            dir.path().join(".vscode/launch.json"),
            r#"{
  "version": "0.2.0",
  "configurations": [
    {"name": "Backend", "type": "node-terminal", "request": "launch",
     "command": "./gradlew bootRun --args='--spring.profiles.active=local'",
     "cwd": "${workspaceFolder}"},
    {"name": "Frontend", "type": "node-terminal", "request": "launch",
     "command": "npm run dev",
     "cwd": "${workspaceFolder}/frontend"},
    {"name": "Tunnel", "type": "node-terminal", "request": "launch",
     "command": "cloudflared tunnel run",
     "cwd": "${workspaceFolder}"}
  ],
  "compounds": [
    {"name": "All", "configurations": ["Backend", "Frontend", "Tunnel"]}
  ]
}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("docker-compose.yml"),
            "version: '3'\nservices:\n  db:\n    image: postgres\n",
        )
        .unwrap();

        let p = detect_project(dir.path()).unwrap();
        let names: Vec<&str> = p.scripts.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Backend"));
        assert!(names.contains(&"Frontend"));
        assert!(names.contains(&"Tunnel"));
        assert!(names.contains(&"All"));
        assert!(names.contains(&"compose up"));
    }

    #[test]
    fn falls_back_to_dirname_when_no_manifest_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("docker-compose.yml"), "version: '3'").unwrap();
        let expected = dir.path().file_name().unwrap().to_string_lossy().into_owned();
        let c = detect_project(dir.path()).unwrap();
        assert_eq!(c.name, expected);
    }
}
