// Tauri invoke commands — IPC surface exposed to the frontend.
//
// LEARN (Tauri commands):
//   - `#[tauri::command]` annotated functions are callable from JS via
//     `invoke('name', args)`. Tauri handles JSON (de)serialization.
//   - Async commands run on the Tokio executor — `.await` freely inside.
//   - Args arrive as camelCase from JS, automatically converted to
//     snake_case Rust params.
//   - Return `Result<T, String>` so the JS side can `.catch(e => …)`.

pub mod autostart;
pub mod docker;
pub mod group;
pub mod logs;
pub mod port;
pub mod ports;
pub mod process;
pub mod project;
pub mod remote;
pub mod scan;
pub mod script;
pub mod session;
pub mod settings;
pub mod tunnel;

pub use autostart::*;
pub use docker::*;
pub use group::*;
pub use logs::*;
pub use port::*;
pub use ports::*;
pub use process::*;
pub use project::*;
pub use remote::*;
pub use scan::*;
pub use script::*;
pub use session::*;
pub use settings::*;
pub use tunnel::*;
