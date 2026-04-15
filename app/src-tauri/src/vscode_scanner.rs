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

use crate::types::{PortProto, PortSpec, Script};
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
    let text = strip_trailing_commas(&text);
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
    let tasks = parse_tasks(project_dir);
    let mut out = Vec::new();
    for cfg in &configs {
        out.push(translate_config_with_tasks(cfg, &workspace, &tasks));
    }

    // Also translate compounds — each compound becomes a single candidate
    // that runs all member configurations concurrently, waiting for any
    // to finish. Members are looked up by name in the configurations list.
    if let Some(compounds) = json.get("compounds").and_then(|v| v.as_array()) {
        for compound in compounds {
            let c_name = compound
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("unnamed compound")
                .to_string();
            let member_names: Vec<String> = compound
                .get("configurations")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();

            // Resolve each member name to its translated command.
            let mut member_cmds: Vec<String> = Vec::new();
            let mut missing: Vec<String> = Vec::new();
            for m in &member_names {
                let member_cfg = configs.iter().find(|c| {
                    c.get("name").and_then(|v| v.as_str()) == Some(m.as_str())
                });
                if let Some(mc) = member_cfg {
                    let translated = translate_config_with_tasks(mc, &workspace, &tasks);
                    if let Some(script) = &translated.script {
                        member_cmds.push(script.command.clone());
                    } else {
                        missing.push(m.clone());
                    }
                } else {
                    missing.push(m.clone());
                }
            }

            // Apply compound's own preLaunchTask if present
            let compound_pre = compound
                .get("preLaunchTask")
                .and_then(|v| v.as_str())
                .and_then(|name| tasks.get(name))
                .cloned();

            let raw = serde_json::to_string_pretty(compound).unwrap_or_default();
            if !missing.is_empty() {
                out.push(skip(
                    c_name.clone(),
                    "compound".to_string(),
                    &format!("compound members missing/unsupported: {}", missing.join(", ")),
                    raw,
                ));
                continue;
            }

            // Run members in parallel, wait for all, kill siblings on any exit.
            // Use `( ... & ) ... ; wait` with a trap to propagate termination.
            let parallel = member_cmds
                .iter()
                .map(|c| format!("( {} ) &", c))
                .collect::<Vec<_>>()
                .join(" ");
            let body = if let Some(pre) = compound_pre {
                format!("{} && {} wait", pre, parallel)
            } else {
                format!("{} wait", parallel)
            };
            let command_line = format!("trap 'kill 0' EXIT; {}", body);

            let script = Script {
                id: Uuid::new_v4().to_string(),
                name: c_name.clone(),
                command: command_line.clone(),
                expected_port: None,
                ports: Vec::new(),
                auto_restart: false,
                env_file: None,
                depends_on: Vec::new(),
            };
            out.push(LaunchConfigCandidate {
                name: c_name,
                command: command_line,
                cwd: Some(workspace.clone()),
                kind: "compound".to_string(),
                skipped_reason: None,
                script: Some(script),
                raw_json: raw,
            });
        }
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
    // pwa-* are the modern JS debug types. Treat them as their base type
    // (pwa-node = node, pwa-chrome = chrome-skip, etc.).
    let base_kind: String = if let Some(stripped) = kind.strip_prefix("pwa-") {
        stripped.to_string()
    } else {
        kind.clone()
    };
    // Reject browser-only debuggers — procman runs server processes.
    if matches!(base_kind.as_str(), "chrome" | "msedge" | "firefox" | "safari" | "webkit") {
        return skip(name, kind, "browser debuggers unsupported", raw_json);
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
        .map(|s| subst_vars(s, workspace, &env_map))
        // Auto-fallback: if launch.json doesn't specify envFile but the
        // project has a `.env` at its root, source it. This lets things
        // like `${env:CLOUDFLARE_TUNNEL_TOKEN}` resolve from .env without
        // requiring the user to wire it up manually.
        .or_else(|| {
            let dotenv = Path::new(workspace).join(".env");
            if dotenv.exists() {
                Some(dotenv.to_string_lossy().into_owned())
            } else {
                None
            }
        });

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
    // SEC-06: validate env keys to prevent injection via env key names
    let env_prefix = env_map
        .iter()
        .filter(|(k, _)| is_safe_env_key(k))
        .map(|(k, v)| {
            let val = substitute(v);
            // If the substituted value contains shell variable references
            // ($VAR from ${env:VAR}), use double quotes so they expand.
            // Single quotes would suppress expansion entirely.
            let quoted = if val.contains('$') {
                shell_quote_double(&val)
            } else {
                shell_quote(&val)
            };
            format!("{}={}", k, quoted)
        })
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

    let command = match base_kind.as_str() {
        "node-terminal" => {
            // VSCode's "run a shell command in a terminal" launch type.
            // Takes the `command` field verbatim and runs it as a shell
            // command. This is how Spring Boot / Vite / tunnel entries are
            // usually expressed in launch.json.
            let raw_cmd = cfg
                .get("command")
                .and_then(|v| v.as_str())
                .map(|s| substitute(s))
                .unwrap_or_default();
            if raw_cmd.is_empty() {
                return skip(name, kind, "node-terminal needs a `command` field", raw_json);
            }
            prefix_envfile(&env_file, &prefix_env(&env_prefix, &raw_cmd))
        }
        "node" => {
            // runtimeArgs: applied BEFORE program. This is how VSCode
            // handles configs like `npm run dev`:
            //   runtimeExecutable: "npm"
            //   runtimeArgs: ["run", "dev"]
            //   (no program)
            // Without honoring runtimeArgs we'd emit `npm index.js`
            // which is invalid npm syntax.
            let runtime_args: Vec<String> = cfg
                .get("runtimeArgs")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| substitute(s)))
                        .collect()
                })
                .unwrap_or_default();
            let quoted_runtime_args = runtime_args
                .iter()
                .map(|a| shell_quote(a))
                .collect::<Vec<_>>()
                .join(" ");

            let interp = runtime_exec.clone().unwrap_or_else(|| "node".to_string());
            // Heuristic: if the runtime is a package manager (npm/pnpm/
            // yarn/bun) and runtimeArgs are present, treat runtimeArgs
            // as the actual command and do not append `program`.
            let is_pm = matches!(
                interp.as_str(),
                "npm" | "pnpm" | "yarn" | "bun" | "deno",
            );
            let base = if is_pm && !runtime_args.is_empty() {
                // `npm run dev`, `pnpm dev`, `yarn start`, etc.
                let extra_args = if quoted_args.is_empty() {
                    String::new()
                } else {
                    format!(" {}", quoted_args)
                };
                format!("{} {}{}", interp, quoted_runtime_args, extra_args)
            } else if let Some(prog) = program.clone() {
                // node <program> [args]
                let prefix = if quoted_runtime_args.is_empty() {
                    String::new()
                } else {
                    format!("{} ", quoted_runtime_args)
                };
                format!(
                    "{} {}{} {}",
                    interp,
                    prefix,
                    shell_quote(&prog),
                    quoted_args
                )
            } else if !runtime_args.is_empty() {
                // No program but runtimeArgs given — fire and hope.
                let extra_args = if quoted_args.is_empty() {
                    String::new()
                } else {
                    format!(" {}", quoted_args)
                };
                format!("{} {}{}", interp, quoted_runtime_args, extra_args)
            } else {
                // Absolute last resort: assume `node index.js`.
                format!("{} index.js {}", interp, quoted_args)
            };
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
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
        "java" | "kotlin" => {
            // Java / Kotlin (JVM) — Maven or Gradle preferred, plain java fallback.
            let main_class = cfg
                .get("mainClass")
                .and_then(|v| v.as_str())
                .map(|s| substitute(s));
            let vm_args = cfg
                .get("vmArgs")
                .and_then(|v| v.as_str())
                .map(|s| substitute(s))
                .unwrap_or_default();

            let has_mvnw = Path::new(workspace).join("mvnw").exists();
            let has_gradlew = Path::new(workspace).join("gradlew").exists();
            let has_pom = Path::new(workspace).join("pom.xml").exists();
            let has_gradle = Path::new(workspace).join("build.gradle").exists()
                || Path::new(workspace).join("build.gradle.kts").exists();

            if has_mvnw || has_pom {
                let runner = if has_mvnw { "./mvnw" } else { "mvn" };
                let mut base = format!("{} spring-boot:run", runner);
                if !vm_args.is_empty() {
                    base.push_str(&format!(
                        " -Dspring-boot.run.jvmArguments={}",
                        shell_quote(&vm_args)
                    ));
                }
                if !quoted_args.is_empty() {
                    base.push_str(&format!(
                        " -Dspring-boot.run.arguments={}",
                        shell_quote(&args_vec.join(" "))
                    ));
                }
                prefix_envfile(&env_file, &prefix_env(&env_prefix, &base))
            } else if has_gradlew || has_gradle {
                let runner = if has_gradlew { "./gradlew" } else { "gradle" };
                let mut base = format!("{} bootRun", runner);
                let mut extras: Vec<String> = Vec::new();
                if !vm_args.is_empty() {
                    extras.push(format!("-Dorg.gradle.jvmargs={}", shell_quote(&vm_args)));
                }
                if !quoted_args.is_empty() {
                    extras.push(format!("--args={}", shell_quote(&args_vec.join(" "))));
                }
                if !extras.is_empty() {
                    base.push(' ');
                    base.push_str(&extras.join(" "));
                }
                prefix_envfile(&env_file, &prefix_env(&env_prefix, &base))
            } else if let Some(mc) = main_class {
                let interp = if base_kind == "kotlin" { "kotlin" } else { "java" };
                let base = format!("{} {} -cp . {} {}", interp, vm_args, shell_quote(&mc), quoted_args);
                prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
            } else {
                return skip(name, kind, "java/kotlin launch needs mainClass or Maven/Gradle project", raw_json);
            }
        }
        "coreclr" | "clr" | "dotnet" => {
            // .NET / C# / F# — prefer `dotnet run` when a csproj exists.
            let has_csproj = std::fs::read_dir(workspace)
                .ok()
                .map(|rd| {
                    rd.flatten().any(|e| {
                        let name = e.file_name().into_string().unwrap_or_default();
                        name.ends_with(".csproj") || name.ends_with(".fsproj") || name.ends_with(".sln")
                    })
                })
                .unwrap_or(false);
            if has_csproj {
                let base = if quoted_args.is_empty() {
                    "dotnet run".to_string()
                } else {
                    format!("dotnet run -- {}", quoted_args)
                };
                prefix_envfile(&env_file, &prefix_env(&env_prefix, &base))
            } else if let Some(prog) = program.clone() {
                // Pre-built .dll
                let base = format!("dotnet {} {}", shell_quote(&prog), quoted_args);
                prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
            } else {
                return skip(name, kind, "dotnet launch needs program or *.csproj", raw_json);
            }
        }
        "php" => {
            let prog = program.clone().unwrap_or_else(|| "index.php".to_string());
            let runtime = runtime_exec.unwrap_or_else(|| "php".to_string());
            let base = format!("{} {} {}", runtime, shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "ruby" | "rdbg" | "ruby_lsp" => {
            let prog = program.clone().unwrap_or_else(|| "main.rb".to_string());
            let has_gemfile = Path::new(workspace).join("Gemfile").exists();
            let base = if has_gemfile {
                format!("bundle exec ruby {} {}", shell_quote(&prog), quoted_args)
            } else {
                format!("ruby {} {}", shell_quote(&prog), quoted_args)
            };
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "dart" | "flutter" => {
            let has_pubspec = Path::new(workspace).join("pubspec.yaml").exists();
            let is_flutter = base_kind == "flutter"
                || std::fs::read_to_string(Path::new(workspace).join("pubspec.yaml"))
                    .ok()
                    .map(|s| s.contains("flutter:"))
                    .unwrap_or(false);
            let base = if is_flutter {
                format!("flutter run {}", quoted_args)
            } else if has_pubspec {
                format!("dart run {}", quoted_args)
            } else if let Some(prog) = program.clone() {
                format!("dart {} {}", shell_quote(&prog), quoted_args)
            } else {
                return skip(name, kind, "dart launch needs program or pubspec.yaml", raw_json);
            };
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "swift" => {
            let has_pkg = Path::new(workspace).join("Package.swift").exists();
            let base = if has_pkg {
                format!("swift run {}", quoted_args)
            } else if let Some(prog) = program.clone() {
                format!("swift {} {}", shell_quote(&prog), quoted_args)
            } else {
                return skip(name, kind, "swift launch needs program or Package.swift", raw_json);
            };
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "lua" => {
            let prog = program.clone().unwrap_or_else(|| "main.lua".to_string());
            let base = format!("lua {} {}", shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "perl" => {
            let prog = program.clone().unwrap_or_else(|| "main.pl".to_string());
            let base = format!("perl {} {}", shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "powershell" | "PowerShell" => {
            let prog = program.clone().unwrap_or_else(|| "script.ps1".to_string());
            // pwsh is cross-platform PowerShell 7; fall back to powershell
            let base = format!("pwsh -File {} {}", shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "deno" => {
            let prog = program.clone().unwrap_or_else(|| "main.ts".to_string());
            let base = format!("deno run --allow-all {} {}", shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "bun" => {
            let prog = program.clone().unwrap_or_else(|| "index.ts".to_string());
            let base = format!("bun run {} {}", shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "elixir" | "mix" | "phoenix" => {
            let has_mix = Path::new(workspace).join("mix.exs").exists();
            let is_phoenix = has_mix
                && std::fs::read_to_string(Path::new(workspace).join("mix.exs"))
                    .ok()
                    .map(|s| s.contains("phoenix"))
                    .unwrap_or(false);
            let base = if is_phoenix {
                format!("mix phx.server {}", quoted_args)
            } else if has_mix {
                format!("mix run --no-halt {}", quoted_args)
            } else if let Some(prog) = program.clone() {
                format!("elixir {} {}", shell_quote(&prog), quoted_args)
            } else {
                return skip(name, kind, "elixir launch needs program or mix.exs", raw_json);
            };
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "clojure" => {
            let has_lein = Path::new(workspace).join("project.clj").exists();
            let has_deps = Path::new(workspace).join("deps.edn").exists();
            let base = if has_lein {
                format!("lein run {}", quoted_args)
            } else if has_deps {
                let main_class = cfg.get("main").and_then(|v| v.as_str()).unwrap_or("");
                if main_class.is_empty() {
                    format!("clojure -M {}", quoted_args)
                } else {
                    format!("clojure -M -m {} {}", shell_quote(main_class), quoted_args)
                }
            } else if let Some(prog) = program.clone() {
                format!("clojure {} {}", shell_quote(&prog), quoted_args)
            } else {
                return skip(name, kind, "clojure launch needs program or project.clj/deps.edn", raw_json);
            };
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "R" | "r" => {
            let prog = program.clone().unwrap_or_else(|| "main.R".to_string());
            let base = format!("Rscript {} {}", shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        "julia" => {
            let prog = program.clone().unwrap_or_else(|| "main.jl".to_string());
            let base = format!("julia {} {}", shell_quote(&prog), quoted_args);
            prefix_envfile(&env_file, &prefix_env(&env_prefix, base.trim()))
        }
        _ => return skip(name, kind, "unsupported launch type", raw_json),
    };

    // If the launch entry has a cwd other than the project root, wrap the
    // command with `cd <sub> && <cmd>` so procman runs it from the correct
    // working directory. This lets a monorepo root run `frontend/npm dev`
    // or `backend/./gradlew bootRun` entries without moving them out of
    // the root project.
    let final_cwd = cwd.clone().unwrap_or_else(|| workspace.to_string());
    let needs_cd = final_cwd.trim_end_matches('/') != workspace.trim_end_matches('/');
    let command = if needs_cd {
        format!("cd {} && {}", shell_quote(&final_cwd), command.trim())
    } else {
        command.trim().to_string()
    };

    // S1: best-effort port extraction from launch.json args / env / runtimeArgs.
    let extracted_ports = extract_ports_from_launch(cfg);
    let expected_from_ports = extracted_ports.first().map(|p| p.number);

    let script = Script {
        id: Uuid::new_v4().to_string(),
        name: name.clone(),
        command: command.clone(),
        expected_port: expected_from_ports,
        ports: extracted_ports,
        auto_restart: false,
        env_file: None,
        depends_on: Vec::new(),
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

/// Intermediate representation of a single task entry.
#[derive(Debug, Clone)]
struct RawTask {
    command: Option<String>,
    is_background: bool,
    depends_on: Vec<String>,
    /// true = parallel, false = sequence (VS Code default)
    parallel: bool,
}

/// Parse `.vscode/tasks.json` and return a map of task label → shell command.
/// Supports `shell`/`process` types, args, options.cwd, isBackground, and
/// composite tasks via `dependsOn` (sequence + parallel orderings).
fn parse_tasks(project_dir: &Path) -> HashMap<String, String> {
    let path = project_dir.join(".vscode").join("tasks.json");
    if !path.exists() {
        return HashMap::new();
    }
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(),
    };
    let text = strip_jsonc_comments(std::str::from_utf8(&bytes).unwrap_or(""));
    let text = strip_trailing_commas(&text);
    let json: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let workspace = project_dir.to_string_lossy().into_owned();
    let env_map: HashMap<String, String> = HashMap::new();

    let raw_tasks = match json.get("tasks").and_then(|v| v.as_array()) {
        Some(t) => t,
        None => return HashMap::new(),
    };

    // Pass 1 — collect all task definitions into RawTask records.
    let mut raw: HashMap<String, RawTask> = HashMap::new();
    for task in raw_tasks {
        let label = match task.get("label").and_then(|v| v.as_str()) {
            Some(l) => l.to_string(),
            None => continue,
        };

        // Build leaf command (if any).
        let command = task.get("command").and_then(|v| v.as_str()).map(|c| {
            let cmd = subst_vars(c, &workspace, &env_map);
            let args: Vec<String> = task
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| {
                            v.as_str()
                                .map(|s| subst_vars(s, &workspace, &env_map))
                                .or_else(|| {
                                    v.get("value")
                                        .and_then(|x| x.as_str())
                                        .map(|s| subst_vars(s, &workspace, &env_map))
                                })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let joined_args = args
                .iter()
                .map(|a| shell_quote(a))
                .collect::<Vec<_>>()
                .join(" ");
            let task_cwd = task
                .get("options")
                .and_then(|o| o.get("cwd"))
                .and_then(|v| v.as_str())
                .map(|s| subst_vars(s, &workspace, &env_map));
            let base = if joined_args.is_empty() {
                cmd
            } else {
                format!("{} {}", cmd, joined_args)
            };
            match task_cwd {
                Some(c) if c.trim_end_matches('/') != workspace.trim_end_matches('/') => {
                    format!("cd {} && {}", shell_quote(&c), base)
                }
                _ => base,
            }
        });

        // dependsOn — accept either a string or an array.
        let depends_on: Vec<String> = match task.get("dependsOn") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            _ => Vec::new(),
        };
        let parallel = task
            .get("dependsOrder")
            .and_then(|v| v.as_str())
            .map(|s| s == "parallel")
            .unwrap_or(false);
        let is_background = task
            .get("isBackground")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        raw.insert(
            label,
            RawTask {
                command,
                is_background,
                depends_on,
                parallel,
            },
        );
    }

    // Pass 2 — resolve every task into a final shell command, expanding
    // dependsOn recursively. Background dependencies in a parallel block
    // are launched with `&` (no wait), so the build step can finish and
    // hand control back to the caller while the dev server keeps running.
    let mut resolved: HashMap<String, String> = HashMap::new();
    for label in raw.keys().cloned().collect::<Vec<_>>() {
        let mut visiting: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        if let Some(cmd) = resolve_task(&label, &raw, &mut visiting, 0) {
            resolved.insert(label, cmd);
        }
    }
    resolved
}

fn resolve_task(
    label: &str,
    raw: &HashMap<String, RawTask>,
    visiting: &mut std::collections::HashSet<String>,
    depth: usize,
) -> Option<String> {
    if depth > 8 || visiting.contains(label) {
        return None;
    }
    let task = raw.get(label)?;
    if task.depends_on.is_empty() {
        return task.command.clone();
    }
    visiting.insert(label.to_string());
    let mut bg_cmds: Vec<String> = Vec::new();
    let mut fg_cmds: Vec<String> = Vec::new();
    let mut seq_cmds: Vec<String> = Vec::new();
    for dep in &task.depends_on {
        let cmd = match resolve_task(dep, raw, visiting, depth + 1) {
            Some(c) => c,
            None => continue,
        };
        let dep_bg = raw.get(dep).map(|t| t.is_background).unwrap_or(false);
        if task.parallel {
            if dep_bg {
                bg_cmds.push(cmd);
            } else {
                fg_cmds.push(cmd);
            }
        } else {
            seq_cmds.push(cmd);
        }
    }
    visiting.remove(label);

    if task.parallel {
        let bg_part = bg_cmds
            .iter()
            .map(|c| format!("( {} ) &", c))
            .collect::<Vec<_>>()
            .join(" ");
        let fg_part = fg_cmds.join(" && ");
        let composed = if !bg_part.is_empty() && !fg_part.is_empty() {
            format!("{} {}", bg_part, fg_part)
        } else if !bg_part.is_empty() {
            // No fg deps to anchor on — wait for the background ones.
            format!("{} wait", bg_part)
        } else {
            fg_part
        };
        // If the composite task itself has its own command, append it
        // after the dependencies (matches VS Code's task ordering).
        if let Some(own) = &task.command {
            if composed.is_empty() {
                Some(own.clone())
            } else {
                Some(format!("{} && {}", composed, own))
            }
        } else {
            Some(composed)
        }
    } else {
        let mut all = seq_cmds;
        if let Some(own) = &task.command {
            all.push(own.clone());
        }
        Some(all.join(" && "))
    }
}

/// Wraps `translate_config` to also honor a config's `preLaunchTask` field
/// by prepending the matching task command with `&&`. This mirrors VS Code's
/// behavior where the build task runs before the launch.
fn translate_config_with_tasks(
    cfg: &Value,
    workspace: &str,
    tasks: &HashMap<String, String>,
) -> LaunchConfigCandidate {
    let mut candidate = translate_config(cfg, workspace);
    if candidate.script.is_none() {
        return candidate;
    }
    let pre = cfg
        .get("preLaunchTask")
        .and_then(|v| v.as_str())
        .and_then(|name| tasks.get(name));
    if let Some(pre_cmd) = pre {
        let new_command = format!("{} && {}", pre_cmd, candidate.command);
        candidate.command = new_command.clone();
        if let Some(s) = candidate.script.as_mut() {
            s.command = new_command;
        }
    }
    candidate
}

/// S1: Best-effort extractor for declared ports out of a `launch.json`
/// configuration block. Only pulls from sources the user explicitly set
/// — no guessing based on tech stack. Missing / unparseable inputs
/// yield an empty vec. Name collisions are suffixed numerically.
///
/// Recognised shapes:
///   1. `args: ["--port", "3000"]` / `["--port=3000"]` / `["-p", "3000"]`
///   2. `env: { PORT: "3000" }` / `SERVER_PORT` / `HTTP_PORT`
///   3. `runtimeArgs` containing `--inspect=host:9229` or `--inspect=9229`
///   4. `program` strings containing `--inspect=host:9229`
pub fn extract_ports_from_launch(cfg: &Value) -> Vec<PortSpec> {
    let mut specs: Vec<PortSpec> = Vec::new();
    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    let push = |specs: &mut Vec<PortSpec>,
                used_names: &mut std::collections::HashSet<String>,
                name_hint: &str,
                number: u16,
                note: Option<String>| {
        // Avoid exact-duplicate numbers.
        if specs.iter().any(|s| s.number == number) {
            return;
        }
        let mut name = name_hint.to_string();
        if used_names.contains(&name) {
            let mut i = 2;
            loop {
                let cand = format!("{}{}", name_hint, i);
                if !used_names.contains(&cand) {
                    name = cand;
                    break;
                }
                i += 1;
            }
        }
        used_names.insert(name.clone());
        specs.push(PortSpec {
            name,
            number,
            bind: "127.0.0.1".to_string(),
            proto: PortProto::Tcp,
            optional: false,
            note,
        });
    };

    // 1. args array: look for "--port", "-p" (followed by N) or "--port=N".
    if let Some(args) = cfg.get("args").and_then(|v| v.as_array()) {
        let strs: Vec<String> = args
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        let mut i = 0;
        while i < strs.len() {
            let a = &strs[i];
            if let Some(eq) = a.strip_prefix("--port=") {
                if let Ok(n) = eq.parse::<u16>() {
                    push(&mut specs, &mut used_names, "default", n, None);
                }
            } else if a == "--port" || a == "-p" {
                if let Some(next) = strs.get(i + 1) {
                    if let Ok(n) = next.parse::<u16>() {
                        push(&mut specs, &mut used_names, "default", n, None);
                        i += 1;
                    }
                }
            }
            i += 1;
        }
    }

    // 2. env object: PORT / SERVER_PORT / HTTP_PORT.
    if let Some(env_obj) = cfg.get("env").and_then(|v| v.as_object()) {
        for key in ["PORT", "SERVER_PORT", "HTTP_PORT"] {
            if let Some(val) = env_obj.get(key).and_then(|v| v.as_str()) {
                if let Ok(n) = val.parse::<u16>() {
                    push(&mut specs, &mut used_names, "default", n, None);
                }
            }
        }
    }

    // 3. runtimeArgs: node --inspect / --inspect-brk.
    if let Some(rt) = cfg.get("runtimeArgs").and_then(|v| v.as_array()) {
        for v in rt {
            if let Some(s) = v.as_str() {
                if let Some(n) = parse_inspect_flag(s) {
                    push(
                        &mut specs,
                        &mut used_names,
                        "debug",
                        n,
                        Some("node --inspect".into()),
                    );
                }
            }
        }
    }

    // 4. program: occasionally carries an inspect flag appended.
    if let Some(prog) = cfg.get("program").and_then(|v| v.as_str()) {
        if let Some(n) = parse_inspect_flag(prog) {
            push(
                &mut specs,
                &mut used_names,
                "debug",
                n,
                Some("program --inspect".into()),
            );
        }
    }

    specs
}

/// Parses `--inspect`, `--inspect=PORT`, `--inspect=HOST:PORT`,
/// `--inspect-brk=...`, `--inspect-brk`. Returns Some(port) only if a
/// numeric port is present; a bare `--inspect` is skipped (default 9229
/// would be a guess, which v2 avoids).
fn parse_inspect_flag(s: &str) -> Option<u16> {
    let prefix = if let Some(rest) = s.strip_prefix("--inspect-brk") {
        rest
    } else if let Some(rest) = s.strip_prefix("--inspect") {
        rest
    } else {
        return None;
    };
    // Accept "=9229", "=127.0.0.1:9229"
    let body = prefix.strip_prefix('=')?;
    let port_str = body.rsplit_once(':').map(|(_, p)| p).unwrap_or(body);
    port_str.parse::<u16>().ok()
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

/// SEC-06: env key must be a valid shell variable name.
fn is_safe_env_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 200
        && key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn shell_quote(s: &str) -> String {
    // Single-quote the string, escaping inner single quotes as '\''
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "_-./=:".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Double-quote a string so `$VAR` references expand.
/// Escapes `"`, `` ` ``, `\`, and `!` to prevent injection.
fn shell_quote_double(s: &str) -> String {
    let escaped: String = s
        .chars()
        .map(|c| match c {
            '"' | '`' | '\\' | '!' => {
                let mut r = String::with_capacity(2);
                r.push('\\');
                r.push(c);
                r
            }
            _ => c.to_string(),
        })
        .collect();
    format!("\"{}\"", escaped)
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
                // Inline env block from launch.json wins — but only if
                // the value is concrete (no nested ${} references). A
                // self-referential value like PATH="...:${env:PATH}"
                // would produce unexpanded ${env:...} in the output
                // because subst_vars only does a single pass. In that
                // case fall through to emit `$VAR` for the shell.
                if let Some(v) = env_map.get(rest) {
                    if !v.contains("${") {
                        return v.clone();
                    }
                }
                // Otherwise EMIT a literal shell variable so the login
                // shell expands it at spawn time. This lets values from
                // ~/.zshrc / .zprofile / a sourced .env file flow into
                // the running command, instead of being baked-in as the
                // empty string at scan time.
                return format!("${}", rest);
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

/// Remove trailing commas before `]` or `}` (JSONC allows them, serde_json does not).
fn strip_trailing_commas(input: &str) -> String {
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
        if c == ',' {
            // Look ahead past whitespace for ] or }
            let mut ws = String::new();
            while let Some(&next) = chars.peek() {
                if next.is_whitespace() {
                    ws.push(next);
                    chars.next();
                } else {
                    break;
                }
            }
            if let Some(&next) = chars.peek() {
                if next == ']' || next == '}' {
                    // Trailing comma — skip it, keep whitespace
                    out.push_str(&ws);
                    continue;
                }
            }
            out.push(',');
            out.push_str(&ws);
            continue;
        }
        out.push(c);
    }
    out
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
    fn env_var_left_for_shell_when_not_in_launch_block() {
        // ${env:CLOUDFLARE_TUNNEL_TOKEN} → $CLOUDFLARE_TUNNEL_TOKEN so the
        // user's login shell expands it at spawn time, not at scan time
        // (which would have baked in an empty string).
        let env: HashMap<String, String> = HashMap::new();
        let out = subst_vars(
            "cloudflared tunnel run --token ${env:CLOUDFLARE_TUNNEL_TOKEN}",
            "/tmp",
            &env,
        );
        assert_eq!(
            out,
            "cloudflared tunnel run --token $CLOUDFLARE_TUNNEL_TOKEN"
        );
    }

    #[test]
    fn env_block_value_wins_over_shell() {
        // If launch.json declares the value inline, that wins over the
        // shell's environment.
        let mut env = HashMap::new();
        env.insert("CLOUDFLARE_TUNNEL_TOKEN".into(), "abc123".into());
        let out = subst_vars(
            "cloudflared tunnel run --token ${env:CLOUDFLARE_TUNNEL_TOKEN}",
            "/tmp",
            &env,
        );
        assert_eq!(out, "cloudflared tunnel run --token abc123");
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

    #[test]
    fn strips_trailing_commas() {
        let input = r#"{"a": [1, 2, 3,], "b": {"x": 1,},}"#;
        let out = strip_trailing_commas(input);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["a"][2], 3);
    }

    #[test]
    fn trailing_comma_in_string_preserved() {
        let input = r#"{"a": "hello,",}"#;
        let out = strip_trailing_commas(input);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["a"], "hello,");
    }

    #[test]
    fn translate_java_plain_mainclass() {
        let cfg = serde_json::json!({
            "name": "Arch Planner (Debug)",
            "type": "java",
            "request": "launch",
            "mainClass": "com.archplanner.ArchPlannerApplication",
            "vmArgs": "-Dspring.profiles.active=default -Dserver.port=4242"
        });
        let c = translate_config(&cfg, "/tmp/no-maven-or-gradle");
        assert!(c.skipped_reason.is_none(), "should translate: {:?}", c.skipped_reason);
        let cmd = c.script.unwrap().command;
        assert!(cmd.contains("java"));
        assert!(cmd.contains("com.archplanner.ArchPlannerApplication"));
        assert!(cmd.contains("-Dserver.port=4242"));
    }

    #[test]
    fn java_without_mainclass_skipped() {
        let cfg = serde_json::json!({
            "name": "broken",
            "type": "java",
            "request": "launch"
        });
        let c = translate_config(&cfg, "/tmp/empty");
        assert!(c.skipped_reason.is_some());
    }

    #[test]
    fn translate_node_terminal() {
        let cfg = serde_json::json!({
            "name": "Backend",
            "type": "node-terminal",
            "request": "launch",
            "command": "./gradlew bootRun --args='--spring.profiles.active=local'",
            "cwd": "${workspaceFolder}"
        });
        let c = translate_config(&cfg, "/tmp/proj");
        assert!(c.skipped_reason.is_none(), "{:?}", c.skipped_reason);
        let cmd = c.script.unwrap().command;
        assert!(cmd.contains("gradlew bootRun"));
        assert!(cmd.contains("spring.profiles.active=local"));
    }

    #[test]
    fn scan_with_compound() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("procman-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join(".vscode")).unwrap();
        let launch_json = r#"{
          "version": "0.2.0",
          "configurations": [
            {
              "name": "Backend",
              "type": "node-terminal",
              "request": "launch",
              "command": "./gradlew bootRun"
            },
            {
              "name": "Frontend",
              "type": "node-terminal",
              "request": "launch",
              "command": "npm run dev"
            }
          ],
          "compounds": [
            {
              "name": "All",
              "configurations": ["Backend", "Frontend"],
              "stopAll": true
            }
          ]
        }"#;
        fs::write(tmp.join(".vscode/launch.json"), launch_json).unwrap();
        let result = scan_launch_json(&tmp).unwrap();
        assert_eq!(result.len(), 3, "expected 2 configs + 1 compound");
        let compound = &result[2];
        assert_eq!(compound.name, "All");
        assert!(compound.skipped_reason.is_none(), "{:?}", compound.skipped_reason);
        let cmd = &compound.script.as_ref().unwrap().command;
        assert!(cmd.contains("gradlew bootRun"));
        assert!(cmd.contains("npm run dev"));
        assert!(cmd.contains("wait"));
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn pre_launch_task_prepended() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("procman-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join(".vscode")).unwrap();
        let launch_json = r#"{
          "version": "0.2.0",
          "configurations": [
            {
              "name": "Backend: Debug",
              "type": "node",
              "request": "launch",
              "program": "${workspaceFolder}/dist/server.js",
              "preLaunchTask": "Build Backend"
            }
          ]
        }"#;
        let tasks_json = r#"{
          "version": "2.0.0",
          "tasks": [
            {
              "label": "Build Backend",
              "type": "shell",
              "command": "npm run build:backend"
            }
          ]
        }"#;
        fs::write(tmp.join(".vscode/launch.json"), launch_json).unwrap();
        fs::write(tmp.join(".vscode/tasks.json"), tasks_json).unwrap();
        let result = scan_launch_json(&tmp).unwrap();
        assert_eq!(result.len(), 1);
        let cfg = &result[0];
        assert!(cfg.skipped_reason.is_none(), "{:?}", cfg.skipped_reason);
        let cmd = &cfg.script.as_ref().unwrap().command;
        assert!(
            cmd.starts_with("npm run build:backend &&"),
            "expected preLaunchTask prefix, got: {}",
            cmd
        );
        assert!(cmd.contains("dist/server.js"));
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn depends_on_parallel_with_background() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("procman-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join(".vscode")).unwrap();
        fs::write(
            tmp.join(".vscode/tasks.json"),
            r#"{
              "tasks": [
                { "label": "Build Backend", "type": "shell", "command": "npm run build:backend" },
                {
                  "label": "Start Frontend Dev Server",
                  "type": "shell",
                  "command": "npx webpack serve",
                  "isBackground": true
                },
                {
                  "label": "Full Stack: Prepare",
                  "dependsOn": ["Build Backend", "Start Frontend Dev Server"],
                  "dependsOrder": "parallel"
                }
              ]
            }"#,
        )
        .unwrap();
        let tasks = parse_tasks(&tmp);
        let prepare = tasks.get("Full Stack: Prepare").expect("Prepare missing");
        // Background dep should be `( ... ) &`, fg dep should anchor.
        assert!(prepare.contains("npx webpack serve"));
        assert!(prepare.contains("npm run build:backend"));
        assert!(
            prepare.contains("( npx webpack serve ) &"),
            "background not in `( ... ) &` form: {}",
            prepare
        );
        assert!(
            prepare.ends_with("npm run build:backend"),
            "fg should come last so we wait on it: {}",
            prepare
        );
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn depends_on_sequence() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("procman-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join(".vscode")).unwrap();
        fs::write(
            tmp.join(".vscode/tasks.json"),
            r#"{
              "tasks": [
                { "label": "A", "type": "shell", "command": "echo a" },
                { "label": "B", "type": "shell", "command": "echo b" },
                { "label": "Both", "dependsOn": ["A", "B"] }
              ]
            }"#,
        )
        .unwrap();
        let tasks = parse_tasks(&tmp);
        assert_eq!(tasks.get("Both").unwrap(), "echo a && echo b");
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn task_with_args_and_cwd() {
        use std::fs;
        let tmp = std::env::temp_dir().join(format!("procman-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join(".vscode")).unwrap();
        fs::write(
            tmp.join(".vscode/tasks.json"),
            r#"{
              "tasks": [
                {
                  "label": "Build",
                  "type": "shell",
                  "command": "npm",
                  "args": ["run", "build"],
                  "options": { "cwd": "${workspaceFolder}/backend" }
                }
              ]
            }"#,
        )
        .unwrap();
        let tasks = parse_tasks(&tmp);
        let cmd = tasks.get("Build").expect("Build task missing");
        assert!(cmd.contains("cd "));
        assert!(cmd.contains("backend"));
        assert!(cmd.contains("npm run build"));
        fs::remove_dir_all(&tmp).unwrap();
    }

    // ------------------------------------------------------------
    // S1: extract_ports_from_launch — 6 cases (--port / -p / env /
    // --inspect / program inspect / empty fallback).
    // ------------------------------------------------------------

    fn parse_json(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn extract_port_double_dash_port_separate() {
        let cfg = parse_json(r#"{"type":"node","args":["--port","3000"]}"#);
        let ports = extract_ports_from_launch(&cfg);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].number, 3000);
        assert_eq!(ports[0].name, "default");
    }

    #[test]
    fn extract_port_equals_form() {
        let cfg = parse_json(r#"{"type":"node","args":["--port=4200"]}"#);
        let ports = extract_ports_from_launch(&cfg);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].number, 4200);
    }

    #[test]
    fn extract_port_short_flag_p() {
        let cfg = parse_json(r#"{"type":"node","args":["-p","8080"]}"#);
        let ports = extract_ports_from_launch(&cfg);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].number, 8080);
    }

    #[test]
    fn extract_port_from_env_vars() {
        let cfg = parse_json(r#"{"type":"node","env":{"PORT":"5000","SERVER_PORT":"5001"}}"#);
        let ports = extract_ports_from_launch(&cfg);
        assert_eq!(ports.len(), 2);
        let nums: Vec<u16> = ports.iter().map(|p| p.number).collect();
        assert!(nums.contains(&5000));
        assert!(nums.contains(&5001));
    }

    #[test]
    fn extract_inspect_flag_with_host_port() {
        let cfg = parse_json(
            r#"{"type":"node","runtimeArgs":["--inspect=127.0.0.1:9229"]}"#,
        );
        let ports = extract_ports_from_launch(&cfg);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].number, 9229);
        assert_eq!(ports[0].name, "debug");
        assert!(ports[0].note.is_some());
    }

    #[test]
    fn extract_port_and_inspect_combined() {
        let cfg = parse_json(
            r#"{"type":"node","args":["--port","3000"],"runtimeArgs":["--inspect-brk=9230"]}"#,
        );
        let ports = extract_ports_from_launch(&cfg);
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].number, 3000);
        assert_eq!(ports[0].name, "default");
        assert_eq!(ports[1].number, 9230);
        assert_eq!(ports[1].name, "debug");
    }

    #[test]
    fn extract_empty_when_no_port_hints() {
        let cfg = parse_json(r#"{"type":"node","program":"index.js","args":["--verbose"]}"#);
        let ports = extract_ports_from_launch(&cfg);
        assert!(ports.is_empty());
    }
}
