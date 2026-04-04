// Port scanner + conflict resolver stubs — real impl in T21-T23 (Sprint 3).
//
// LEARN (systems calls from Rust):
//   - macOS doesn't expose a stable port→pid API. procman will shell out to
//     `lsof -nP -iTCP:<port> -sTCP:LISTEN` and parse the output.
//   - `std::process::Command` is fine for one-shot sync calls like lsof;
//     `tokio::process::Command` is needed only for streamed stdout.
//   - SIGTERM/SIGKILL sent via `kill(pid, signal)` requires `nix` or `libc`
//     crate. We'll use `nix` for ergonomic signal types.

use crate::types::PortInfo;

#[tauri::command]
pub async fn list_ports() -> Result<Vec<PortInfo>, String> {
    // T21: parse `lsof -nP -iTCP -sTCP:LISTEN` output, return PortInfo list.
    //      Called on 1s polling interval from the frontend.
    Ok(vec![])
}

#[tauri::command]
pub async fn kill_port(_port: u16) -> Result<(), String> {
    // T23 (killer feature): find pid bound to port, SIGTERM → SIGKILL after 2s.
    //      One-click conflict resolution.
    unimplemented!("T23: kill-by-port")
}
