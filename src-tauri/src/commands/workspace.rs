use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};

/// Ouvre le sélecteur de dossier natif. `None` si l'utilisateur annule.
#[tauri::command]
pub async fn workspace_pick_folder(app: AppHandle) -> AppResult<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });

    let folder = rx.await.map_err(|_| AppError::msg("folder picker was interrupted"))?;
    Ok(folder
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Sélecteur de fichiers natif (plusieurs fichiers), ouvert dans `start_dir` si fourni.
#[tauri::command]
pub async fn workspace_pick_files(app: AppHandle, start_dir: Option<String>) -> AppResult<Vec<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file();
    if let Some(dir) = start_dir {
        dialog = dialog.set_directory(dir);
    }
    dialog.pick_files(move |files| {
        let _ = tx.send(files);
    });

    let files = rx.await.map_err(|_| AppError::msg("file picker was interrupted"))?;
    Ok(files
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

/// Prépare l'espace de travail d'un agent (worktree isolé à partir du 2e agent).
#[tauri::command]
pub async fn agent_workspace_create(
    state: tauri::State<'_, crate::workspace::WorkspaceState>,
    root: std::path::PathBuf,
    agent_id: String,
    index: u32,
    name: String,
) -> AppResult<crate::workspace::AgentWorkspace> {
    crate::workspace::create_agent(&state, root, agent_id, index, name).await
}

/// Agent fermé : retire son worktree (sa branche est conservée).
#[tauri::command]
pub async fn agent_workspace_remove(state: tauri::State<'_, crate::workspace::WorkspaceState>, agent_id: String) -> AppResult<()> {
    crate::workspace::remove_agent(&state, &agent_id).await
}

#[tauri::command]
pub fn agent_set_busy(state: tauri::State<'_, crate::workspace::WorkspaceState>, agent_id: String, busy: bool) {
    crate::workspace::set_busy(&state, &agent_id, busy);
}

/// Fin d'une tâche d'agent : l'orchestrateur prend le relais en arrière-plan.
#[tauri::command]
pub fn agent_task_finished(app: AppHandle, agent_id: String, summary: Option<String>) {
    crate::workspace::orchestrator::task_finished(app, agent_id, summary);
}

#[tauri::command]
pub fn project_config_get(root: std::path::PathBuf) -> ProjectSettings {
    ProjectSettings {
        config: crate::workspace::build::load_config(&root),
        detected_build_command: crate::workspace::build::detect(&root),
    }
}

#[tauri::command]
pub fn project_config_set(root: std::path::PathBuf, config: crate::workspace::build::ProjectConfig) -> AppResult<()> {
    crate::workspace::build::save_config(&root, &config)
}

/// Réglages du projet, avec la commande de build détectée (pour l'afficher).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    config: crate::workspace::build::ProjectConfig,
    detected_build_command: Option<String>,
}
