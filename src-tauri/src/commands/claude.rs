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
    effort: Option<String>,
    system_prompt: Option<String>,
) -> AppResult<()> {
    let opts = StartOptions { cwd, permission_mode, model, resume, effort, system_prompt };
    claude::start(app, &state, session_id, opts).await
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

#[tauri::command]
pub async fn claude_logout() -> crate::error::AppResult<()> {
    crate::claude::logout().await
}

/// Réponse de l'utilisateur à une demande d'autorisation d'un agent.
#[tauri::command]
pub async fn claude_permission(
    state: State<'_, ClaudeState>,
    session_id: String,
    request_id: String,
    allow: bool,
    input: serde_json::Value,
    message: Option<String>,
) -> AppResult<()> {
    claude::answer_permission(&state, &session_id, request_id, allow, input, message).await
}

/// Réponse courte d'un modèle rapide, sans outils (résumé d'une conversation).
#[tauri::command]
pub async fn claude_quick(prompt: String) -> AppResult<String> {
    claude::quick_answer(&prompt).await
}

/// Arrête le tour en cours d'un agent, sans fermer sa session.
#[tauri::command]
pub async fn claude_interrupt(state: State<'_, ClaudeState>, session_id: String) -> AppResult<()> {
    claude::interrupt(&state, &session_id).await
}
