//! Dictée vocale du champ de saisie des agents.

use tauri::AppHandle;

use crate::error::AppResult;

/// Bloquante (démarrage du micro) : exécutée hors du fil principal.
#[tauri::command(async)]
pub fn speech_start(app: AppHandle) -> AppResult<()> {
    crate::speech::start(app)
}

#[tauri::command(async)]
pub fn speech_stop() {
    crate::speech::stop();
}
