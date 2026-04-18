use crate::state::AppState;
use crate::types::AppSettings;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AppSettingsPatch {
    pub log_buffer_size: Option<usize>,
    pub port_poll_interval_ms: Option<u64>,
    pub theme: Option<String>,
    pub port_aliases: Option<HashMap<u16, String>>,
    pub lan_mode_opt_in: Option<bool>,
    pub start_at_login: Option<bool>,
    pub onboarded: Option<bool>,
}

impl AppSettingsPatch {
    fn apply(self, s: &mut AppSettings) {
        if let Some(v) = self.log_buffer_size {
            s.log_buffer_size = v;
        }
        if let Some(v) = self.port_poll_interval_ms {
            s.port_poll_interval_ms = v;
        }
        if let Some(v) = self.theme {
            s.theme = v;
        }
        if let Some(v) = self.port_aliases {
            s.port_aliases = v;
        }
        if let Some(v) = self.lan_mode_opt_in {
            s.lan_mode_opt_in = v;
        }
        if let Some(v) = self.start_at_login {
            s.start_at_login = v;
        }
        if let Some(v) = self.onboarded {
            s.onboarded = v;
        }
    }
}

#[tauri::command]
pub async fn get_settings(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<AppSettings, String> {
    let guard = state.config.lock().await;
    Ok(guard.settings.clone())
}

#[tauri::command]
pub async fn update_settings(
    patch: AppSettingsPatch,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<AppSettings, String> {
    state
        .mutate(|cfg| {
            patch.apply(&mut cfg.settings);
            cfg.settings.clone()
        })
        .await
        .map_err(|e| e.to_string())
}
