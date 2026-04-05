// VSCode launch.json scanner.
//
// Parses .vscode/launch.json at a project root and translates each
// `configuration` to a procman Script. Supports a minimal subset:
//   types: node, python, shell, go, lldb (Rust)
//   vars:  ${workspaceFolder}, ${file}, ${env:VAR}
//   fields: program, args, cwd, env, runtimeExecutable (node)
//
// Unsupported (compound, preLaunchTask, pwa-*, attach, remote) are skipped
// with a warning String per candidate.

use crate::types::Script;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct LaunchConfigCandidate {
    pub name: String,
    /// Translated shell command ready for procman execution.
    pub command: String,
    pub cwd: Option<String>,
    /// Type field from launch.json (node/python/…).
    pub kind: String,
    /// If the config was skipped, the reason. Empty when usable.
    pub skipped_reason: Option<String>,
    /// Resulting Script (only set when !skipped).
    pub script: Option<Script>,
    /// Raw launch.json configuration as pretty-printed JSON (for "view original").
    pub raw_json: String,
}

/// Sync core used by both the tauri command and scan.rs auto-detect.
pub fn scan_launch_json(project_dir: &Path) -> Result<Vec<LaunchConfigCandidate>, String> {
    let path = project_dir.join(".vscode").join("launch.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read launch.json: {}", e))?;
    let text = strip_jsonc_comments(std::str::from_utf8(&bytes).unwrap_or(""));
    let json: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return Err(format!("parse launch.json: {}", e)),
    };
    let configs = json
        .get("configurations")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let workspace = project_dir.to_string_lossy().into_owned();
    let mut out = Vec::new();
    for cfg in configs {
        out.push(translate_config(&cfg, &workspace));
    }
    Ok(out)
}

#[tauri::command]
pub async fn scan_vscode_configs(
    project_path: String,
) -> Result<Vec<LaunchConfigCandidate>, String> {
    scan_launch_json(Path::new(&project_path))
}

fn translate_config(cfg: &Value, workspace: &str) -> LaunchConfigCandidate {
    let raw_json = serde_json::to_string_pretty(cfg).unwrap_or_default();
    let name = cfg
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unnamed")
        .to_string();
    let kind = cfg
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let req = cfg.get("request").and_then(|v| v.as_str()).unwrap_or("");

    // Reject attach / remote / compound modes early.
    if req == "attach" {
        return skip(name, kind, "'attach' request not supported (launch only)", raw_json);
    }
    if kind.starts_with("pwa-") {
        return skip(name, kind, "pwa-* debuggers unsupported; use the plain type", raw_json);
    }

    let env_map: HashMap<String, String> = cfg
        .get("env")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let env_file = cfg
        .get("envFile")
        .and_then(|v| v.as_str())
        .map(|s| subst_vars(s, workspace, &env_map));

    let substitute = |s: &str| -> String { subst_vars(s, workspace, &env_map) };

    let program_raw = cfg.get("program").and_then(|v| v.as_str()).map(String::from);
    let program = program_raw.as_deref().map(substitute);

    let args_vec: Vec<String> = cfg
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| substitute(s)))
                .collect()
        })
        .unwrap_or_default();

    let cwd_raw = cfg.get("cwd").and_then(|v| v.as_str()).map(String::from);
    let cwd = cwd_raw.as_deref().map(substitute).or_else(|| Some(workspace.to_string()));

    // env prefix for shell command
    let env_prefix = env_map
        .iter()
        .map(|(k, v)| format!("{}={}", k, shell_quote(&substitute(v))))
        .collect::<Vec<_>>()
        .join(" ");

    let quoted_args = args_vec
        .iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ");

    let runtime_exec = cfg
        .get("runtimeExecutable")
        .and_then(|v| v.as_str())
        .map(|s| substitute(s));

    let command = match kind.as_str() {
        "node" => {
            let interp = runtime_exec.unwrap_or_else(|| "node".to_string());
            let prog = program
                .clone()
                .unwrap_or_else(|| "index.js".to_string());
            let base = format!("{} {} {}", interp, shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, &base))
        }
        "python" | "debugpy" => {
            // VSCode Python uses "python" field for the interpreter path,
            // not runtimeExecutable.
            let python_path = cfg
                .get("python")
                .and_then(|v| v.as_str())
                .map(|s| substitute(s));
            let interp = runtime_exec
                .or(python_path)
                .unwrap_or_else(|| "python3".to_string());
            let module = cfg
                .get("module")
                .and_then(|v| v.as_str())
                .map(|s| substitute(s));
            let target = if let Some(m) = module {
                format!("-m {}", shell_quote(&m))
            } else {
                let prog = program
                    .clone()
                    .unwrap_or_else(|| "main.py".to_string());
                shell_quote(&prog)
            };
            let base = format!("{} {} {}", interp, target, quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, &base))
        }
        "shell" | "bashdb" => {
            let prog = program
                .clone()
                .unwrap_or_else(|| "./run.sh".to_string());
            let base = format!("{} {}", shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, &base))
        }
        "go" => {
            let prog = program.clone().unwrap_or_else(|| ".".to_string());
            let base = format!("go run {} {}", shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, &base))
        }
        "lldb" | "cppdbg" | "rust" | "codelldb" => {
            let has_cargo = Path::new(workspace).join("Cargo.toml").exists();
            if has_cargo {
                let base = format!("cargo run -- {}", quoted_args);
                prefix_envfile(&env_file, prefix_env(&env_prefix, base.trim()).as_str())
            } else if let Some(prog) = program.clone() {
                let base = format!("{} {}", shell_quote(&prog), quoted_args);
                prefix_envfile(&env_file, &prefix_env(&env_prefix, &base))
            } else {
                return skip(name, kind, "binary debugger needs program or Cargo.toml", raw_json);
            }
        }
        _ => return skip(name, kind, "unsupported launch type", raw_json),
    };

    let script = Script {
        id: Uuid::new_v4().to_string(),
        name: name.clone(),
        command: command.trim().to_string(),
        expected_port: None,
        auto_restart: false,
    };

    LaunchConfigCandidate {
        name,
        command: script.command.clone(),
        cwd,
        kind,
        skipped_reason: None,
        script: Some(script),
        raw_json,
    }
}

fn skip(name: String, kind: String, reason: &str, raw_json: String) -> LaunchConfigCandidate {
    LaunchConfigCandidate {
        name,
        command: String::new(),
        cwd: None,
        kind,
        skipped_reason: Some(reason.to_string()),
        script: None,
        raw_json,
    }
}

fn prefix_env(env_prefix: &str, cmd: &str) -> String {
    if env_prefix.is_empty() {
        cmd.to_string()
    } else {
        format!("{} {}", env_prefix, cmd)
    }
}

/// Wraps a command with `set -a; source <envFile>; set +a;` to load env vars.
fn prefix_envfile(env_file: &Option<String>, cmd: &str) -> String {
    match env_file {
        Some(path) => format!("set -a; source {}; set +a; {}", shell_quote(path), cmd),
        None => cmd.to_string(),
    }
}

fn shell_quote(s: &str) -> String {
    // Single-quote the string, escaping inner single quotes as '\''
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "_-./=:".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Substitute VSCode variables. Only supports MVP subset.
fn subst_vars(input: &str, workspace: &str, env_map: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            // Find closing }
            if let Some(end) = input[i + 2..].find('}') {
                let key = &input[i + 2..i + 2 + end];
                let replacement = resolve_var(key, workspace, env_map);
                out.push_str(&replacement);
                i = i + 2 + end + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn resolve_var(key: &str, workspace: &str, env_map: &HashMap<String, String>) -> String {
    match key {
        "workspaceFolder" | "workspaceRoot" => workspace.to_string(),
        "file" | "fileBasename" | "fileDirname" | "relativeFile" => {
            // No single file context in MVP; leave placeholder visible.
            format!("${{{}}}", key)
        }
        _ => {
            if let Some(rest) = key.strip_prefix("env:") {
                return std::env::var(rest).unwrap_or_default();
            }
            if let Some(rest) = key.strip_prefix("config:") {
                // Unsupported
                return format!("${{{}}}", key);
            }
            // Inline env from launch.json env block
            if let Some(v) = env_map.get(key) {
                return v.clone();
            }
            format!("${{{}}}", key)
        }
    }
}

/// Remove // line comments and /* */ block comments. Preserves strings.
fn strip_jsonc_comments(input: &str) -> String {
    // Char-based iteration to preserve multi-byte UTF-8 (e.g. Korean).
    // We only need to recognize `//`, `/* */` at ASCII positions; string
    // bodies and other content are passed through verbatim.
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escape = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            continue;
        }
        if c == '/' {
            match chars.peek() {
                Some('/') => {
                    // consume until newline
                    chars.next();
                    for nc in chars.by_ref() {
                        if nc == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    chars.next();
                    let mut prev = '\0';
                    for nc in chars.by_ref() {
                        if prev == '*' && nc == '/' {
                            break;
                        }
                        prev = nc;
                    }
                    continue;
                }
                _ => {}
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_line_comments() {
        let input = r#"{"a":1} // trailing
// leading
{"b":2}"#;
        let out = strip_jsonc_comments(input);
        assert!(!out.contains("//"));
    }

    #[test]
    fn preserves_utf8_korean() {
        let input = r#"{"name": "전체 시작 (대시보드 + 거래)"} // 주석"#;
        let out = strip_jsonc_comments(input);
        assert!(out.contains("전체 시작 (대시보드 + 거래)"));
        assert!(!out.contains("주석"));
    }

    #[test]
    fn preserves_string_contents() {
        let input = r#"{"url": "http://x.com"}"#;
        let out = strip_jsonc_comments(input);
        assert!(out.contains("http://x.com"));
    }

    #[test]
    fn subst_workspace() {
        let env = HashMap::new();
        assert_eq!(
            subst_vars("${workspaceFolder}/src", "/tmp/proj", &env),
            "/tmp/proj/src"
        );
    }

    #[test]
    fn subst_env_from_launch() {
        let mut env = HashMap::new();
        env.insert("MY_VAR".into(), "hello".into());
        assert_eq!(subst_vars("${MY_VAR}/x", "/tmp", &env), "hello/x");
    }

    #[test]
    fn translate_node_config() {
        let cfg = serde_json::json!({
            "name": "dev",
            "type": "node",
            "request": "launch",
            "program": "${workspaceFolder}/server.js",
            "args": ["--port", "3000"],
            "env": { "NODE_ENV": "development" }
        });
        let c = translate_config(&cfg, "/tmp/proj");
        assert!(c.skipped_reason.is_none());
        let cmd = c.script.unwrap().command;
        assert!(cmd.contains("NODE_ENV=development"));
        assert!(cmd.contains("/tmp/proj/server.js"));
        assert!(cmd.contains("--port 3000"));
    }

    #[test]
    fn translate_python_module() {
        let cfg = serde_json::json!({
            "name": "api",
            "type": "python",
            "request": "launch",
            "module": "uvicorn",
            "args": ["main:app", "--reload"]
        });
        let c = translate_config(&cfg, "/tmp/proj");
        let cmd = c.script.unwrap().command;
        assert!(cmd.contains("python3 -m uvicorn"));
        assert!(cmd.contains("--reload"));
    }

    #[test]
    fn skips_attach() {
        let cfg = serde_json::json!({
            "name": "attach",
            "type": "node",
            "request": "attach"
        });
        let c = translate_config(&cfg, "/tmp");
        assert!(c.skipped_reason.is_some());
    }

    #[test]
    fn skips_pwa() {
        let cfg = serde_json::json!({
            "name": "chrome",
            "type": "pwa-chrome",
            "request": "launch"
        });
        let c = translate_config(&cfg, "/tmp");
        assert!(c.skipped_reason.is_some());
    }
}
