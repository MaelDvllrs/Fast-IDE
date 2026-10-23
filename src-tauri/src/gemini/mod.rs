//! Intégration de Gemini CLI (Google), au même titre que Claude Code et Codex.
//!
//! Chaque agent Gemini est un processus `gemini --acp` : Agent Client Protocol,
//! JSON-RPC sur stdin/stdout. Ses événements sont traduits dans le format de
//! Claude Code et envoyés sur le canal `claude://event` (voir `session.rs`).
//! Gemini CLI est un script Node : il est lancé avec `node` directement (pas
//! par `gemini.cmd`), pour que l'arrêt d'un agent arrête vraiment le processus.

mod session;

use std::{path::PathBuf, process::Stdio};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

use crate::{
    error::{AppError, AppResult},
    platform,
};

pub use session::{answer_permission, interrupt, owns, send, start, stop, stop_all, GeminiState, StartOptions};

/// Variables qui feraient passer Gemini par une clé API au lieu du compte Google.
const API_KEY_VARS: &[&str] = &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"];

const INSTALL_COMMAND: &str = "npm install -g @google/gemini-cli";

/// Script d'entrée de Gemini CLI (`bundle/gemini.js`) installé par `npm install -g`.
fn script() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("FAST_GEMINI_SCRIPT").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(path);
    }
    let roots: Vec<PathBuf> = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("npm").join("node_modules")).into_iter().collect()
    } else {
        let mut roots = vec![PathBuf::from("/opt/homebrew/lib/node_modules"), PathBuf::from("/usr/local/lib/node_modules")];
        if let Some(home) = platform::home_dir() {
            roots.push(home.join(".npm-global").join("lib").join("node_modules"));
        }
        roots
    };
    roots
        .into_iter()
        .map(|root| root.join("@google").join("gemini-cli").join("bundle").join("gemini.js"))
        .find(|p| p.is_file())
}

/// Commande qui lance Gemini CLI : `node …/gemini.js`.
pub(crate) fn command() -> AppResult<Command> {
    let script = script().ok_or_else(|| AppError::msg("Gemini CLI not found. Install it: npm install -g @google/gemini-cli"))?;
    let node = which::which("node").map_err(|_| AppError::msg("Node.js not found: Gemini CLI needs Node 20 or later."))?;
    let mut cmd = Command::new(node);
    cmd.arg(script);
    for var in API_KEY_VARS {
        cmd.env_remove(var);
    }
    platform::configure_command(&mut cmd);
    Ok(cmd)
}

/// Dossier de configuration de Gemini CLI (`~/.gemini`).
fn home() -> Option<PathBuf> {
    std::env::var_os("GEMINI_CLI_HOME").map(PathBuf::from).or_else(platform::home_dir).map(|h| h.join(".gemini"))
}

fn read_json(path: PathBuf) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Adresse contenue dans le jeton d'identité (JWT) enregistré à la connexion.
fn token_email(path: PathBuf) -> Option<String> {
    let payload = read_json(path)?["id_token"].as_str()?.split('.').nth(1)?.to_owned();
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()?;
    claims["email"].as_str().map(str::to_owned)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiStatus {
    installed: bool,
    /// Connecté avec un compte Google (identifiants enregistrés par Gemini CLI).
    logged_in: bool,
    /// Adresse du compte Google, si Gemini CLI l'a enregistrée.
    email: Option<String>,
    install_command: String,
}

/// Gemini CLI est-il installé, et connecté à un compte Google ?
/// (Type de connexion choisi `oauth-personal` et identifiants présents.)
pub fn status() -> GeminiStatus {
    let installed = script().is_some();
    let dir = home();
    let selected = dir
        .clone()
        .and_then(|d| read_json(d.join("settings.json")))
        .and_then(|s| s["security"]["auth"]["selectedType"].as_str().map(str::to_owned));
    let creds = dir.clone().is_some_and(|d| d.join("oauth_creds.json").is_file());
    // Compte actif noté par Gemini CLI, sinon l'adresse du jeton d'identité Google.
    let email = dir
        .clone()
        .and_then(|d| read_json(d.join("google_accounts.json")))
        .and_then(|a| a["active"].as_str().map(str::to_owned))
        .or_else(|| dir.and_then(|d| token_email(d.join("oauth_creds.json"))));
    GeminiStatus {
        installed,
        logged_in: installed && creds && selected.as_deref() == Some("oauth-personal"),
        email,
        install_command: INSTALL_COMMAND.to_owned(),
    }
}

/// Connexion avec le compte Google : Gemini CLI ouvre lui-même la page de
/// connexion dans le navigateur et attend sa validation (5 minutes au plus).
pub async fn login() -> AppResult<()> {
    let mut cmd = command()?;
    cmd.arg("--acp")
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take().ok_or_else(|| AppError::msg("stdin unavailable"))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("stdout unavailable"))?;
    let mut lines = BufReader::new(stdout).lines();

    let exchange = async {
        let requests = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            } }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "authenticate", "params": { "methodId": "oauth-personal" } }),
        ];
        for request in requests {
            let mut line = serde_json::to_vec(&request)?;
            line.push(b'\n');
            stdin.write_all(&line).await?;
        }
        stdin.flush().await?;
        while let Some(line) = lines.next_line().await? {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if message["id"] == 2 && message.get("method").is_none() {
                return match message.get("error") {
                    Some(error) => Err(AppError::msg(error["message"].as_str().unwrap_or("Google sign-in failed").to_owned())),
                    None => Ok(()),
                };
            }
        }
        Err(AppError::msg("Gemini CLI stopped during the sign-in"))
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(330), exchange)
        .await
        .map_err(|_| AppError::msg("Google sign-in timed out"))?;
    let _ = child.kill().await;
    result
}

/// Déconnexion : les identifiants Google de Gemini CLI sont supprimés.
pub fn logout() -> AppResult<()> {
    let Some(dir) = home() else { return Ok(()) };
    for file in ["oauth_creds.json", "google_accounts.json"] {
        let path = dir.join(file);
        if path.exists() {
            std::fs::remove_file(path)?;
        }
    }
    Ok(())
}
