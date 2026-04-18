// Autostart Tauri commands — 고도화 2.
//
// Thin wrappers over `crate::autostart`. The FE toggles `start_at_login`
// in AppSettings and separately invokes `set_autostart(enabled)` —
// splitting settings persistence from the filesystem mutation keeps
// the two concerns independently failing (e.g. launchctl refused but
// the user preference still saved).

use crate::autostart;
use std::path::PathBuf;

/// Resolve procman's own binary/app-bundle path so we can install the
/// plist. In dev we fall back to the current executable; in a signed
/// .app we walk up to the .app bundle root.
fn resolve_app_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // /Applications/procman.app/Contents/MacOS/procman → procman.app
    let mut cur = exe.as_path();
    for _ in 0..3 {
        if cur.extension().and_then(|e| e.to_str()) == Some("app") {
            return Some(cur.to_path_buf());
        }
        cur = cur.parent()?;
    }
    // Dev build — use the binary itself.
    Some(exe)
}

#[tauri::command]
pub async fn get_autostart_status() -> Result<bool, String> {
    let plist = autostart::default_plist_path()
        .ok_or_else(|| "no home directory".to_string())?;
    Ok(autostart::is_autostart_enabled(&plist))
}

#[tauri::command]
pub async fn set_autostart(enabled: bool) -> Result<(), String> {
    let plist = autostart::default_plist_path()
        .ok_or_else(|| "no home directory".to_string())?;
    if enabled {
        let app = resolve_app_path().ok_or_else(|| "cannot resolve app path".to_string())?;
        autostart::enable_autostart(&app, &plist).map_err(|e| e.to_string())
    } else {
        autostart::disable_autostart(&plist).map_err(|e| e.to_string())
    }
}
