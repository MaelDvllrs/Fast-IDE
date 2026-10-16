use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::{
    claude::{self, ClaudeState, StartOptions},
    error::AppResult,
};

#[tauri::command]
pub async fn claude_status() -> claude::ClaudeStatus {
    claude::status().await
}

#[tauri::command]
pub async fn claude_start(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    session_id: String,
    cwd: PathBuf,
    permission_mode: Option<String>,
    model: Option<String>,
    resume: Option<String>,
) -> AppResult<()> {
    claude::start(app, &state, session_id, StartOptions { cwd, permission_mode, model, resume }).await
}

#[tauri::command]
pub async fn claude_send(state: State<'_, ClaudeState>, session_id: String, text: String) -> AppResult<()> {
    claude::send(&state, &session_id, text).await
}

#[tauri::command]
pub async fn claude_stop(state: State<'_, ClaudeState>, session_id: String) -> AppResult<()> {
    claude::stop(&state, &session_id).await;
    Ok(())
}
