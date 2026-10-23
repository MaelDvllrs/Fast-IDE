//! Intégration de Codex (CLI d'OpenAI), au même titre que Claude Code.
//!
//! Chaque agent Codex est un processus `codex app-server` (JSON-RPC sur
//! stdin/stdout). Pour que l'interface n'ait qu'un seul format à lire, ses
//! événements sont traduits dans celui de Claude Code (`stream-json`) et
//! envoyés sur le même canal `claude://event` (voir `session.rs`).

mod session;

use std::{path::PathBuf, process::Stdio};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

use crate::{
    error::{AppError, AppResult},
    platform,
};

pub use session::{answer_permission, interrupt, models, owns, send, start, stop, stop_all, CodexState, StartOptions};

/// Variables qui feraient passer Codex par une facturation API au lieu de
/// l'abonnement ChatGPT : on ne les transmet jamais au processus.
const API_KEY_VARS: &[&str] = &["OPENAI_API_KEY", "CODEX_API_KEY"];

/// Commande d'installation (lancée dans le terminal intégré, visible de l'utilisateur).
const INSTALL_COMMAND: &str = "npm install -g @openai/codex";

/// Exécutable natif de Codex installé par `npm install -g @openai/codex` : lancé
/// directement plutôt que par `codex.cmd` (cmd → node → exe), pour que l'arrêt
/// d'un agent arrête vraiment Codex.
fn native_program() -> Option<PathBuf> {
    let npm = PathBuf::from(std::env::var_os("APPDATA")?).join("npm").join("node_modules").join("@openai");
    let triple = if cfg!(target_arch = "aarch64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" };
    let package = if cfg!(target_arch = "aarch64") { "codex-win32-arm64" } else { "codex-win32-x64" };
    let tail = |base: PathBuf| base.join(package).join("vendor").join(triple).join("bin").join("codex.exe");
    // Dépendance optionnelle : à côté du paquet principal, ou dans ses node_modules.
    [tail(npm.clone()), tail(npm.join("codex").join("node_modules").join("@openai"))]
        .into_iter()
        .find(|p| p.is_file())
}

/// Programme `codex` : `FAST_CODEX_BIN` (développement), l'exécutable natif, le PATH,
/// sinon le lanceur placé par `npm install -g`.
pub fn program() -> AppResult<PathBuf> {
    if let Some(path) = std::env::var_os("FAST_CODEX_BIN").map(PathBuf::from).filter(|p| p.is_file()) {
        return Ok(path);
    }
    if cfg!(target_os = "windows") {
        if let Some(path) = native_program() {
            return Ok(path);
        }
    }
    if let Ok(path) = which::which("codex") {
        return Ok(path);
    }
    let fallback = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("npm").join("codex.cmd"))
    } else {
        platform::home_dir().map(|home| home.join(".npm-global").join("bin").join("codex"))
    };
    fallback
        .filter(|p| p.is_file())
        .ok_or_else(|| AppError::msg("`codex` CLI not found. Install Codex: npm install -g @openai/codex"))
}

pub(crate) fn command(program: &std::path::Path) -> Command {
    let mut cmd = Command::new(program);
    for var in API_KEY_VARS {
        cmd.env_remove(var);
    }
    platform::configure_command(&mut cmd);
    cmd
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    installed: bool,
    /// Connecté à un compte ChatGPT (abonnement).
    logged_in: bool,
    /// Mode de connexion annoncé par Codex (« ChatGPT », « API key »…).
    login_method: Option<String>,
    /// Adresse du compte ChatGPT connecté.
    email: Option<String>,
    /// Formule ChatGPT : « plus », « pro », « team »…
    plan: Option<String>,
    install_command: String,
    /// Commande de connexion (ouvre le navigateur), si Codex est installé.
    login_command: Option<String>,
}

/// Chemin entre guillemets pour le shell du terminal intégré (PowerShell / zsh).
fn quoted(program: &std::path::Path) -> String {
    let path = program.to_string_lossy();
    if cfg!(target_os = "windows") {
        format!("& '{}'", path.replace('\'', "''"))
    } else {
        format!("'{}'", path.replace('\'', "'\\''"))
    }
}

/// Codex est-il installé, et connecté à un compte ChatGPT ?
pub async fn status() -> CodexStatus {
    let install_command = INSTALL_COMMAND.to_owned();
    let Ok(program) = program() else {
        return CodexStatus {
            installed: false,
            logged_in: false,
            login_method: None,
            email: None,
            plan: None,
            install_command,
            login_command: None,
        };
    };

    // `codex login status` : « Logged in using ChatGPT » (code 0), sinon « Not logged in ».
    let mut cmd = command(&program);
    cmd.args(["login", "status"]).stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await;
    let text = match output {
        Ok(Ok(out)) if out.status.success() => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            Some(text)
        }
        _ => None,
    };
    let method = text
        .as_deref()
        .and_then(|t| t.lines().find_map(|l| l.trim().strip_prefix("Logged in using ").map(str::to_owned)));

    let logged_in = method.as_deref().is_some_and(|m| m.eq_ignore_ascii_case("chatgpt"));
    let claims = if logged_in { account_claims() } else { None };
    let claim = |read: fn(&Value) -> &Value| claims.as_ref().and_then(|c| read(c).as_str().map(str::to_owned));
    CodexStatus {
        installed: true,
        logged_in,
        login_method: method,
        email: claim(|c| &c["email"]),
        plan: claim(|c| &c["https://api.openai.com/auth"]["chatgpt_plan_type"]),
        install_command,
        login_command: Some(format!("{} login", quoted(&program))),
    }
}

/// Identité du compte ChatGPT : jeton d'identité (JWT) enregistré par Codex
/// dans `~/.codex/auth.json` (ou `$CODEX_HOME`). Seule la partie lisible est décodée.
fn account_claims() -> Option<Value> {
    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| platform::home_dir().map(|h| h.join(".codex")))?;
    let auth: Value = serde_json::from_str(&std::fs::read_to_string(home.join("auth.json")).ok()?).ok()?;
    let payload = auth["tokens"]["id_token"].as_str()?.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()
}

/// Déconnecte Codex du compte ChatGPT.
pub async fn logout() -> AppResult<()> {
    let mut cmd = command(&program()?);
    cmd.args(["logout"]).stdin(Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| AppError::msg("Codex did not answer in time"))??;
    if out.status.success() {
        Ok(())
    } else {
        Err(AppError::msg(String::from_utf8_lossy(&out.stderr).trim().to_owned()))
    }
}
