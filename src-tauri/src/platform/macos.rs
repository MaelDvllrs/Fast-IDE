use std::{path::PathBuf, process::Command};

pub const OS: &str = "macos";
pub const HOME_VAR: &str = "HOME";

const MARKER: &str = "__VIBE_IDE_PATH__";

/// Une app lancée depuis le Finder/Dock hérite d'un PATH minimal
/// (`/usr/bin:/bin:...`) : on récupère celui du shell de connexion pour
/// trouver `claude`, `node`, Homebrew, etc.
pub fn init() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!("printf '{MARKER}%s{MARKER}' \"$PATH\"");
    let Ok(output) = Command::new(shell).args(["-ilc", &script]).output() else {
        return;
    };
    // Les marqueurs isolent le PATH d'éventuels messages affichés par le profil du shell.
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(path) = stdout.split(MARKER).nth(1).filter(|p| !p.is_empty()) {
        std::env::set_var("PATH", path);
    }
}

pub fn windows_build() -> Option<u32> {
    None
}

/// Installeur officiel, pour le shell de l'utilisateur.
pub const CLAUDE_INSTALL_COMMAND: &str = "curl -fsSL https://claude.ai/install.sh | bash";

/// `'chemin' auth login --claudeai`, apostrophes du chemin échappées pour le shell.
pub fn claude_login_command(program: &std::path::Path) -> String {
    let path = program.to_string_lossy().replace('\'', "'\\''");
    format!("'{path}' auth login --claudeai")
}

/// Ligne de shell via `/bin/sh -c` (le PATH du shell de connexion est déjà appliqué au démarrage).
pub fn shell_command(line: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("/bin/sh");
    cmd.args(["-c", line]);
    cmd
}

pub fn link_dir(target: &std::path::Path, link: &std::path::Path) -> crate::error::AppResult<()> {
    Ok(std::os::unix::fs::symlink(target, link)?)
}

/// `remove_file` sur un lien symbolique supprime le lien, pas le dossier cible.
pub fn unlink_dir(link: &std::path::Path) -> crate::error::AppResult<()> {
    Ok(std::fs::remove_file(link)?)
}

pub fn configure_command(_cmd: &mut tokio::process::Command) {}

/// Groupe de processus propre : `kill -<pid>` atteint aussi tous les descendants.
pub fn own_process_tree(cmd: &mut tokio::process::Command) {
    cmd.process_group(0);
}

/// Groupe de processus de la tâche (créé par `own_process_tree`).
pub struct ProcessTree {
    pgid: u32,
}

impl ProcessTree {
    pub fn attach(child: &tokio::process::Child) -> Option<Self> {
        child.id().map(|pgid| Self { pgid })
    }

    /// SIGTERM à tout le groupe (fin propre), SIGKILL avec `force`.
    pub fn stop(&self, force: bool) {
        let signal = if force { "-KILL" } else { "-TERM" };
        let _ = Command::new("kill")
            .args([signal, "--", &format!("-{}", self.pgid)])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Shell de l'utilisateur, en mode login pour charger son profil. Un PTY Unix
/// n'efface pas l'écran : le terminal écrit le message d'accueil lui-même.
pub fn shell_launch(_banner: Option<&str>) -> super::ShellLaunch {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    super::ShellLaunch { program: shell, args: vec!["-l".into()], prints_banner: false }
}

pub fn claude_fallback_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = super::home_dir() {
        paths.push(home.join(".local/bin/claude"));
        paths.push(home.join(".claude/local/claude"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/claude"));
    paths.push(PathBuf::from("/usr/local/bin/claude"));
    paths
}

/// Shell de connexion de l'utilisateur : même PATH que dans son terminal (nvm, Homebrew…).
pub fn command_launch(command: &str) -> super::ShellLaunch {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    super::ShellLaunch { program: shell, args: vec!["-l".into(), "-c".into(), command.into()], prints_banner: false }
}
