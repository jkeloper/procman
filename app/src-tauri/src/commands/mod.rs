// Tauri invoke commands — the IPC surface exposed to the frontend.
//
// LEARN (Tauri commands):
//   - A function annotated with `#[tauri::command]` becomes callable from the
//     frontend via `invoke('snake_case_name', {camelCaseArgs})`. Tauri handles
//     JSON serialization automatically on both ends.
//   - Async commands return a Future; Tauri polls them on the Tokio runtime.
//     Blocking calls must go through `tokio::task::spawn_blocking`.
//   - Return `Result<T, String>` so frontend can `.catch(e => …)`. The Err
//     variant is serialized as a string in the JS promise rejection.
//   - Arguments deserialize from a JSON object. Parameter names on the Rust
//     side convert camelCase → snake_case automatically.
//
// All commands below are STUBS for Sprint 1. Real implementations land in
// Sprint 2 (process/log) and Sprint 3 (ports).

pub mod port;
pub mod process;
pub mod project;

pub use port::*;
pub use process::*;
pub use project::*;
