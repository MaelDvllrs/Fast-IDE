//! Commande de build du projet : détectée, ou réglée dans `.fast/config.json`.

use std::{path::Path, process::Stdio};

use serde::{Deserialize, Serialize};

use crate::{error::AppResult, platform};

/// Réglages propres au projet, dans `<projet>/.fast/config.json`.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectConfig {
    /// Commande de build imposée ; `None` = détection automatique, `""` = pas de build.
    pub build_command: Option<String>,
}

fn config_path(root: &Path) -> std::path::PathBuf {
    root.join(".fast").join("config.json")
}

pub fn load_config(root: &Path) -> ProjectConfig {
    std::fs::read_to_string(config_path(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_config(root: &Path, config: &ProjectConfig) -> AppResult<()> {
    let path = config_path(root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(config)?)?;
    Ok(())
}

/// Commande devinée d'après les fichiers du projet.
pub fn detect(root: &Path) -> Option<String> {
    let has_build_script = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|pkg| pkg["scripts"]["build"].is_string());
    if has_build_script {
        return Some("npm run build".into());
    }
    if root.join("Cargo.toml").is_file() {
        return Some("cargo build".into());
    }
    None
}

/// Commande à lancer : réglage du projet, sinon détection. `None` = pas de build.
pub fn command(root: &Path) -> Option<String> {
    match load_config(root).build_command {
        Some(cmd) if cmd.trim().is_empty() => None,
        Some(cmd) => Some(cmd),
        None => detect(root),
    }
}

/// Fin de la sortie d'un build : assez pour comprendre une erreur, sans tout garder.
const OUTPUT_TAIL: usize = 6000;

/// Lance le build dans `dir` ; rend (réussite, fin de la sortie).
pub async fn run(dir: &Path, command: &str) -> AppResult<(bool, String)> {
    let mut cmd = platform::shell_command(command);
    cmd.current_dir(dir).stdin(Stdio::null());
    platform::configure_command(&mut cmd);
    let out = cmd.output().await?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    let tail = match text.char_indices().rev().nth(OUTPUT_TAIL) {
        Some((cut, _)) => text[cut..].to_owned(),
        None => text,
    };
    Ok((out.status.success(), tail))
}
