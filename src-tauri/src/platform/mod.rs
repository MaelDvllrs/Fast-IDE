//! Tout ce qui diffère entre Windows et macOS.
//!
//! Le reste du code n'utilise que les fonctions publiques de ce module ;
//! chaque OS fournit son implémentation dans `windows.rs` / `macos.rs`,
//! avec exactement les mêmes signatures.

use std::path::PathBuf;

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use self::macos as imp;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use self::windows as imp;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
compile_error!("FAST only targets Windows and macOS: add a module in src/platform/.");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    os: &'static str,
    path_separator: &'static str,
    /// Numéro de build de Windows (ex. 26200), `None` ailleurs. Le terminal en a
    /// besoin pour savoir comment ConPTY gère le redimensionnement.
    windows_build: Option<u32>,
}

pub fn info() -> PlatformInfo {
    PlatformInfo {
        os: imp::OS,
        path_separator: std::path::MAIN_SEPARATOR_STR,
        windows_build: imp::windows_build(),
    }
}

/// Préparation au démarrage, avant la création de la fenêtre.
pub fn init() {
    imp::init();
}

/// Ajustements propres à l'OS pour tout processus enfant lancé par l'IDE.
pub fn configure_command(cmd: &mut tokio::process::Command) {
    imp::configure_command(cmd);
}

/// Localise l'exécutable `claude` : d'abord via le PATH, puis dans les
/// emplacements d'installation connus de l'OS.
pub fn claude_program() -> AppResult<PathBuf> {
    if let Ok(path) = which::which("claude") {
        return Ok(path);
    }
    imp::claude_fallback_paths()
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            AppError::msg("`claude` CLI not found. Install Claude Code: https://docs.claude.com/claude-code")
        })
}

/// Commande (pour le shell du terminal intégré) qui lance l'installeur officiel.
pub fn claude_install_command() -> &'static str {
    imp::CLAUDE_INSTALL_COMMAND
}

/// Commande (pour le shell du terminal intégré) qui connecte Claude Code à un
/// abonnement claude.ai. Le chemin complet est utilisé : juste après une
/// installation, `claude` n'est pas encore dans le PATH du shell.
pub fn claude_login_command(program: &std::path::Path) -> String {
    imp::claude_login_command(program)
}

/// Commande qui lance le shell du terminal intégré.
pub struct ShellLaunch {
    pub program: String,
    pub args: Vec<String>,
    /// `true` si le shell affiche lui-même le message d'accueil ; sinon c'est
    /// au terminal de l'écrire avant la sortie du shell.
    pub prints_banner: bool,
}

/// Shell du terminal intégré, avec un éventuel message d'accueil.
pub fn shell_launch(banner: Option<&str>) -> ShellLaunch {
    imp::shell_launch(banner)
}

/// Commande qui exécute une ligne de shell (ex. « npm run build »).
pub fn shell_command(line: &str) -> tokio::process::Command {
    imp::shell_command(line)
}

/// Relie `link` au dossier `target` (le contenu n'est pas copié).
pub fn link_dir(target: &std::path::Path, link: &std::path::Path) -> AppResult<()> {
    imp::link_dir(target, link)
}

/// Supprime un lien créé par [`link_dir`] sans toucher au dossier cible.
pub fn unlink_dir(link: &std::path::Path) -> AppResult<()> {
    imp::unlink_dir(link)
}

/// Dossier personnel de l'utilisateur.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os(imp::HOME_VAR).map(PathBuf::from)
}
