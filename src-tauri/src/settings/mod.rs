//! Préférences de l'utilisateur, enregistrées dans `settings.json` du dossier
//! de configuration de l'app (%APPDATA%\<identifier> sous Windows,
//! ~/Library/Application Support/<identifier> sur macOS).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};

/// Champs absents du fichier = valeur par défaut : on peut ajouter des
/// préférences sans casser les fichiers existants.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Identifiant du thème de l'interface (ex. "dark"), `None` pour le thème par défaut.
    pub theme: Option<String>,
    /// Mise à jour automatique au lancement ; `None` = activée (valeur par défaut).
    pub auto_update: Option<bool>,
    /// Dernier projet ouvert, rouvert au lancement.
    pub last_project: Option<String>,
    /// Compte GitHub connecté (login, nom, avatar), affiché dès le lancement en
    /// attendant la réponse de GitHub. Le jeton reste dans le trousseau du système.
    pub github_account: Option<serde_json::Value>,
    /// Tâches lourdes des agents en même temps par projet ; `None` = limites par défaut.
    pub scheduler: Option<crate::scheduler::Limits>,
}

fn path<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(format!("config directory unavailable: {e}")))?;
    Ok(dir.join("settings.json"))
}

/// Lit les préférences ; fichier absent ou illisible = préférences par défaut.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
    path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Écrit les préférences via un fichier temporaire puis un renommage, pour ne
/// jamais laisser un fichier à moitié écrit.
pub fn save<R: Runtime>(app: &AppHandle<R>, settings: &Settings) -> AppResult<()> {
    let target = path(app)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
    std::fs::rename(&tmp, &target)?;
    Ok(())
}
