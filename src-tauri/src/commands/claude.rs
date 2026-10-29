//! Sessions d'agents. Les commandes d'envoi, d'arrêt et d'autorisation valent
//! pour Claude Code, Codex et Gemini : la session est cherchée chez Codex et
//! Gemini d'abord, sinon c'est une session Claude.

use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::{
    claude::{self, ClaudeState, StartOptions},
    codex::{self, CodexState},
    gemini::{self, GeminiState},
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
pub async fn claude_send(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    codex_state: State<'_, CodexState>,
    gemini_state: State<'_, GeminiState>,
    session_id: String,
    text: String,
) -> AppResult<()> {
    if codex::owns(&codex_state, &session_id).await {
        return codex::send(&codex_state, &session_id, text).await;
    }
    if gemini::owns(&gemini_state, &session_id).await {
        return gemini::send(app, &gemini_state, &session_id, text).await;
    }
    claude::send(&state, &session_id, text).await
}

#[tauri::command]
pub async fn claude_stop(
    state: State<'_, ClaudeState>,
    codex_state: State<'_, CodexState>,
    gemini_state: State<'_, GeminiState>,
    session_id: String,
) -> AppResult<()> {
    codex::stop(&codex_state, &session_id).await;
    gemini::stop(&gemini_state, &session_id).await;
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
    codex_state: State<'_, CodexState>,
    gemini_state: State<'_, GeminiState>,
    session_id: String,
    request_id: String,
    allow: bool,
    input: serde_json::Value,
    message: Option<String>,
) -> AppResult<()> {
    // Push d'un agent, demandé par le hook pre-push (voir scheduler/push.rs).
    if crate::scheduler::push::answer(&request_id, allow) {
        return Ok(());
    }
    if codex::owns(&codex_state, &session_id).await {
        return codex::answer_permission(&codex_state, &session_id, &request_id, allow).await;
    }
    if gemini::owns(&gemini_state, &session_id).await {
        return gemini::answer_permission(&gemini_state, &session_id, &request_id, allow).await;
    }
    claude::answer_permission(&state, &session_id, request_id, allow, input, message).await
}

/// Réponse courte d'un modèle rapide, sans outils (résumé d'une conversation).
#[tauri::command]
pub async fn claude_quick(prompt: String) -> AppResult<String> {
    claude::quick_answer(&prompt).await
}

/// Arrête le tour en cours d'un agent, sans fermer sa session.
#[tauri::command]
pub async fn claude_interrupt(
    state: State<'_, ClaudeState>,
    codex_state: State<'_, CodexState>,
    gemini_state: State<'_, GeminiState>,
    session_id: String,
) -> AppResult<()> {
    if codex::owns(&codex_state, &session_id).await {
        return codex::interrupt(&codex_state, &session_id).await;
    }
    if gemini::owns(&gemini_state, &session_id).await {
        return gemini::interrupt(&gemini_state, &session_id).await;
    }
    claude::interrupt(&state, &session_id).await
}

// --- Codex --------------------------------------------------------------------

#[tauri::command]
pub async fn codex_status() -> codex::CodexStatus {
    codex::status().await
}

#[tauri::command]
pub async fn codex_logout() -> AppResult<()> {
    codex::logout().await
}

/// Modèles Codex disponibles pour le compte (identifiant, nom, niveaux d'effort).
#[tauri::command]
pub async fn codex_models() -> AppResult<Vec<serde_json::Value>> {
    codex::models().await
}

/// Démarre une session Codex ; ses événements arrivent sur `claude://event`.
#[tauri::command]
pub async fn codex_start(
    app: AppHandle,
    state: State<'_, CodexState>,
    session_id: String,
    cwd: PathBuf,
    model: Option<String>,
    resume: Option<String>,
    effort: Option<String>,
    system_prompt: Option<String>,
) -> AppResult<()> {
    let opts = codex::StartOptions { cwd, model, effort, system_prompt, resume };
    codex::start(app, &state, session_id, opts).await
}

// --- Gemini -------------------------------------------------------------------

#[tauri::command]
pub fn gemini_status() -> gemini::GeminiStatus {
    gemini::status()
}

/// Connexion avec le compte Google (page de connexion ouverte dans le navigateur).
#[tauri::command]
pub async fn gemini_login() -> AppResult<()> {
    gemini::login().await
}

#[tauri::command]
pub fn gemini_logout() -> AppResult<()> {
    gemini::logout()
}

/// Démarre une session Gemini ; ses événements arrivent sur `claude://event`.
#[tauri::command]
pub async fn gemini_start(
    app: AppHandle,
    state: State<'_, GeminiState>,
    session_id: String,
    cwd: PathBuf,
    model: Option<String>,
    resume: Option<String>,
    system_prompt: Option<String>,
) -> AppResult<()> {
    let opts = gemini::StartOptions { cwd, model, system_prompt, resume };
    gemini::start(app, &state, session_id, opts).await
}
