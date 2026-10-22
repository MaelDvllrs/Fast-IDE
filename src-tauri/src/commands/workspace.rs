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
    // Les préférences ne règlent que le build : le reste du fichier (commande Run…) est gardé.
    let mut current = crate::workspace::build::load_config(&root);
    current.build_command = config.build_command;
    crate::workspace::build::save_config(&root, &current)
}

/// Réglages du projet, avec la commande de build détectée (pour l'afficher).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    config: crate::workspace::build::ProjectConfig,
    detected_build_command: Option<String>,
}

/// Commandes possibles pour le bouton Run, et celle choisie pour ce projet.
#[tauri::command]
pub fn project_run_options(root: std::path::PathBuf) -> crate::workspace::run::RunOptions {
    crate::workspace::run::options(&root)
}

#[tauri::command]
pub fn project_run_set(root: std::path::PathBuf, command: Option<String>) -> AppResult<()> {
    crate::workspace::run::set(&root, command)
}

/// Fichier collé dans le champ d'un agent (capture d'écran, document) : enregistré
/// dans `<projet>/.fast/attachments/` (exclu de git) pour que l'agent puisse le lire.
/// `data` est le contenu encodé en base64. Rend le chemin du fichier.
#[tauri::command]
pub fn attachment_save(root: std::path::PathBuf, name: String, data: String) -> AppResult<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|_| AppError::msg("the pasted file could not be read"))?;
    // Nom sûr : sans dossier ni caractère interdit sous Windows.
    let base = std::path::Path::new(&name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let clean: String = base
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let clean = if clean.trim().is_empty() { "pasted-file".to_owned() } else { clean };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dir = root.join(".fast").join("attachments");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{stamp}-{clean}"));
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Agents du projet et leurs conversations (`.fast/agents.json`), pour les
/// rouvrir au prochain lancement. `None` si rien n'a encore été enregistré.
#[tauri::command(async)]
pub fn project_agents_load(root: std::path::PathBuf) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(root.join(".fast").join("agents.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Enregistre les agents du projet ; écrit dans un fichier temporaire puis le
/// renomme, pour ne jamais laisser un fichier à moitié écrit.
#[tauri::command(async)]
pub fn project_agents_save(root: std::path::PathBuf, state: serde_json::Value) -> AppResult<()> {
    let dir = root.join(".fast");
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join("agents.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&state)?)?;
    std::fs::rename(&tmp, dir.join("agents.json"))?;
    Ok(())
}
