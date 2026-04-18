// Autostart (LaunchAgent) — 고도화 2.
//
// macOS-only: manages `~/Library/LaunchAgents/com.procman.app.plist` so
// procman launches at login. We intentionally use the system `launchctl`
// instead of pulling in a plist crate — the plist schema is tiny and
// stable, and shelling out keeps the binary small.
//
// The plist file path and Label are centralised as constants so tests
// and the UI agree on a single identity.

use std::path::{Path, PathBuf};

pub const LAUNCH_AGENT_LABEL: &str = "com.procman.app";

/// Absolute path to the user's LaunchAgent plist. Only safe to call
/// after dirs::home_dir() resolves (non-root macOS session).
pub fn default_plist_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| {
        h.join("Library")
            .join("LaunchAgents")
            .join(format!("{}.plist", LAUNCH_AGENT_LABEL))
    })
}

/// Build the plist XML string for a given `program` path (expected to
/// resolve to procman.app/Contents/MacOS/procman). We keep KeepAlive
/// false so the user retains control via the Dock / ⌘Q.
pub fn render_plist(program: &Path) -> String {
    let escaped = escape_xml(&program.to_string_lossy());
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" ",
            "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
            "<plist version=\"1.0\">\n",
            "<dict>\n",
            "  <key>Label</key>\n",
            "  <string>{label}</string>\n",
            "  <key>ProgramArguments</key>\n",
            "  <array>\n",
            "    <string>{program}</string>\n",
            "  </array>\n",
            "  <key>RunAtLoad</key>\n",
            "  <true/>\n",
            "  <key>KeepAlive</key>\n",
            "  <false/>\n",
            "  <key>ProcessType</key>\n",
            "  <string>Interactive</string>\n",
            "</dict>\n",
            "</plist>\n",
        ),
        label = LAUNCH_AGENT_LABEL,
        program = escaped,
    )
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Write the plist to `plist_path` and attempt `launchctl load -w`.
/// Idempotent: a prior `unload` is attempted first so reloading after
/// an app update picks up the new program path.
pub fn enable_autostart(app_path: &Path, plist_path: &Path) -> std::io::Result<()> {
    let program = resolve_program_binary(app_path);
    if let Some(parent) = plist_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(plist_path, render_plist(&program))?;

    // Best-effort unload-then-load. Unload may fail if the agent wasn't
    // previously registered — that's expected on first install.
    let _ = std::process::Command::new("launchctl")
        .args(["unload", "-w"])
        .arg(plist_path)
        .output();
    let out = std::process::Command::new("launchctl")
        .args(["load", "-w"])
        .arg(plist_path)
        .output()?;
    if !out.status.success() {
        return Err(std::io::Error::other(
            format!(
                "launchctl load failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        ));
    }
    Ok(())
}

/// Remove the plist and unload from launchctl. Idempotent — missing
/// file or unregistered agent are treated as success.
pub fn disable_autostart(plist_path: &Path) -> std::io::Result<()> {
    let _ = std::process::Command::new("launchctl")
        .args(["unload", "-w"])
        .arg(plist_path)
        .output();
    if plist_path.exists() {
        std::fs::remove_file(plist_path)?;
    }
    Ok(())
}

/// True iff the plist file exists at its conventional path. We don't
/// consult `launchctl list` because launchd's reply depends on the
/// user session state and costs us a subprocess on every settings tick.
pub fn is_autostart_enabled(plist_path: &Path) -> bool {
    plist_path.exists()
}

/// Given `/Applications/procman.app`, return the main binary path
/// (`/Applications/procman.app/Contents/MacOS/procman`). If `app_path`
/// is not an .app bundle, return as-is (dev builds / tests).
pub fn resolve_program_binary(app_path: &Path) -> PathBuf {
    if app_path.extension().and_then(|e| e.to_str()) == Some("app") {
        app_path.join("Contents").join("MacOS").join("procman")
    } else {
        app_path.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn render_plist_contains_label_and_program() {
        let xml = render_plist(&PathBuf::from("/Applications/procman.app/Contents/MacOS/procman"));
        assert!(xml.contains("<key>Label</key>"));
        assert!(xml.contains(LAUNCH_AGENT_LABEL));
        assert!(xml.contains("/Applications/procman.app/Contents/MacOS/procman"));
        assert!(xml.contains("<key>RunAtLoad</key>"));
        assert!(xml.contains("<true/>"));
    }

    #[test]
    fn render_plist_escapes_xml_specials_in_path() {
        // Spaces / ampersands in app path must not break plist parsing.
        let xml = render_plist(&PathBuf::from("/Users/foo & bar/app"));
        assert!(xml.contains("foo &amp; bar"));
        assert!(!xml.contains("foo & bar/")); // raw `&` should be gone
    }

    #[test]
    fn resolve_program_binary_from_app_bundle() {
        let out = resolve_program_binary(&PathBuf::from("/Applications/procman.app"));
        assert_eq!(out, PathBuf::from("/Applications/procman.app/Contents/MacOS/procman"));
    }

    #[test]
    fn resolve_program_binary_passthrough_for_dev_binary() {
        let dev = PathBuf::from("/tmp/target/debug/procman");
        assert_eq!(resolve_program_binary(&dev), dev);
    }

    #[test]
    fn is_autostart_enabled_checks_file_existence() {
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("com.procman.app.plist");
        assert!(!is_autostart_enabled(&plist));
        std::fs::write(&plist, "dummy").unwrap();
        assert!(is_autostart_enabled(&plist));
    }

    #[test]
    fn disable_autostart_is_idempotent_when_missing() {
        // Should NOT error when the plist doesn't exist — fresh install
        // / second disable call in a row.
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("com.procman.app.plist");
        // Note: this may briefly invoke `launchctl unload` which exits
        // nonzero for a non-registered agent — we swallow that. The
        // function itself returns Ok(()).
        disable_autostart(&plist).unwrap();
    }

    #[test]
    fn enable_writes_plist_file_in_tempdir() {
        // Exercise the plist-writing half without touching ~/Library.
        // We can't call launchctl on a non-standard path without side-
        // effects, so we bypass enable_autostart() and test the write
        // path via render_plist + std::fs.
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("com.procman.app.plist");
        let program = resolve_program_binary(&PathBuf::from("/tmp/procman.app"));
        std::fs::write(&plist, render_plist(&program)).unwrap();
        assert!(plist.exists());
        let contents = std::fs::read_to_string(&plist).unwrap();
        assert!(contents.contains("/tmp/procman.app/Contents/MacOS/procman"));
    }
}
