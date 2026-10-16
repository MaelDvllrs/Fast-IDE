use tauri::AppHandle;

use crate::{
    error::AppResult,
    settings::{self, Settings},
};

#[tauri::command(async)]
pub fn settings_load(app: AppHandle) -> Settings {
    settings::load(&app)
}

#[tauri::command(async)]
pub fn settings_save(app: AppHandle, settings: Settings) -> AppResult<()> {
    settings::save(&app, &settings)
}
