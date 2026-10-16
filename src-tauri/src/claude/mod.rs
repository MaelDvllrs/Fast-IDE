//! Orchestration du véritable agent Claude Code.
//!
//! Chaque session est un processus `claude` lancé en mode headless avec un flux
//! JSON bidirectionnel (stdin/stdout). Rust relaie chaque ligne JSON à
//! l'interface via l'événement `claude://event`.

use std::{collections::HashMap, path::PathBuf, process::Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

use crate::{
    error::{AppError, AppResult},
    platform,
};

pub const EVENT: &str = "claude://event";

struct Session {
    // `kill_on_drop` : retirer la session de la map tue le processus.
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct ClaudeState {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeEvent {
    session_id: String,
    event: EventKind,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
enum EventKind {
    /// Une ligne JSON de `--output-format stream-json`.
    Message(serde_json::Value),
    /// Une ligne de stdout qui n'est pas du JSON.
    Raw(String),
    Stderr(String),
    /// Fin du processus, avec son code de sortie si disponible.
    Exit(Option<i32>),
}

pub struct StartOptions {
    pub cwd: PathBuf,
    pub permission_mode: Option<String>,
    /// Alias ou nom de modèle (`opus`, `sonnet`…) ; `None` = modèle par défaut du compte.
    pub model: Option<String>,
    /// Identifiant d'une conversation à reprendre (changement de modèle en cours de route).
    pub resume: Option<String>,
}

/// Variables qui feraient passer Claude Code par une facturation API au lieu de
/// l'abonnement claude.ai : on ne les transmet jamais au processus.
const API_KEY_VARS: &[&str] = &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/// Commande `claude` prête à l'emploi : réglages propres à l'OS, et sans clé
/// API dans l'environnement pour toujours utiliser l'abonnement.
fn claude_command(program: &std::path::Path) -> Command {
    let mut cmd = Command::new(program);
    for var in API_KEY_VARS {
        cmd.env_remove(var);
    }
    platform::configure_command(&mut cmd);
    cmd
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    installed: bool,
    /// Connecté à un compte claude.ai (abonnement).
    logged_in: bool,
    /// Commande shell qui installe Claude Code (à lancer dans le terminal intégré).
    install_command: String,
    /// Commande shell qui lance la connexion, si Claude Code est installé.
    login_command: Option<String>,
}

/// Claude Code est-il installé, et connecté à un abonnement ?
/// Durée maximale d'une passe de l'orchestrateur (résolution de conflit, correction de build).
const ONE_SHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Passe unique de Claude Code dans `cwd`, autorisée à modifier les fichiers
/// (`acceptEdits`) : utilisée par l'orchestrateur. Rend le texte de la réponse.
pub async fn run_once(cwd: &std::path::Path, prompt: &str) -> AppResult<String> {
    let mut cmd = claude_command(&platform::claude_program()?);
    cmd.args(["-p", prompt, "--permission-mode", "acceptEdits", "--output-format", "json"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(ONE_SHOT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| AppError::msg("Claude did not finish in time"))??;
    let result: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| AppError::msg(String::from_utf8_lossy(&out.stderr).trim().to_owned()))?;
    if result["is_error"] == true || !out.status.success() {
        return Err(AppError::msg(result["result"].as_str().unwrap_or("Claude failed").to_owned()));
    }
    Ok(result["result"].as_str().unwrap_or_default().to_owned())
}

pub async fn status() -> ClaudeStatus {
    let install_command = platform::claude_install_command().to_owned();
    let Ok(program) = platform::claude_program() else {
        return ClaudeStatus { installed: false, logged_in: false, install_command, login_command: None };
    };

    // `claude auth status` répond en JSON : { "loggedIn": true, "authMethod": "claude.ai", ... }
    let mut cmd = claude_command(&program);
    cmd.args(["auth", "status"]).stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await;
    let logged_in = match output {
        Ok(Ok(out)) => serde_json::from_slice::<serde_json::Value>(&out.stdout)
            .map(|v| v["loggedIn"] == true && v["authMethod"] == "claude.ai")
            .unwrap_or(false),
        _ => false,
    };

    ClaudeStatus {
        installed: true,
        logged_in,
        install_command,
        login_command: Some(platform::claude_login_command(&program)),
    }
}

pub async fn start(app: AppHandle, state: &ClaudeState, id: String, opts: StartOptions) -> AppResult<()> {
    let mut sessions = state.sessions.lock().await;
    if sessions.contains_key(&id) {
        return Err(AppError::msg(format!("session {id} already exists")));
    }

    let mut cmd = claude_command(&platform::claude_program()?);
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        // Texte envoyé au fur et à mesure (événements `stream_event`) pour l'afficher en direct.
        "--include-partial-messages",
    ]);
    if let Some(mode) = &opts.permission_mode {
        cmd.args(["--permission-mode", mode]);
    }
    if let Some(model) = &opts.model {
        cmd.args(["--model", model]);
    }
    if let Some(session) = &opts.resume {
        cmd.args(["--resume", session]);
    }
    cmd.current_dir(&opts.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| AppError::msg("stdin unavailable"))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("stdout unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::msg("stderr unavailable"))?;

    tauri::async_runtime::spawn(forward_lines(app.clone(), id.clone(), stderr, EventKind::Stderr));
    tauri::async_runtime::spawn(forward_stdout(app, id.clone(), stdout));

    sessions.insert(id, Session { child, stdin });
    Ok(())
}

pub async fn send(state: &ClaudeState, id: &str, text: String) -> AppResult<()> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("unknown session {id}")))?;

    let message = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
    });
    let mut line = serde_json::to_vec(&message)?;
    line.push(b'\n');
    session.stdin.write_all(&line).await?;
    session.stdin.flush().await?;
    Ok(())
}

/// Arrête toutes les sessions (fermeture de l'app) : `kill_on_drop` tue les processus.
pub fn stop_all(state: &ClaudeState) {
    state.sessions.blocking_lock().clear();
}

pub async fn stop(state: &ClaudeState, id: &str) {
    state.sessions.lock().await.remove(id);
}

async fn forward_stdout(app: AppHandle, id: String, stdout: impl AsyncRead + Unpin) {
    forward_lines(app.clone(), id.clone(), stdout, |line| {
        match serde_json::from_str(&line) {
            Ok(value) => EventKind::Message(value),
            Err(_) => EventKind::Raw(line),
        }
    })
    .await;

    // stdout fermé : le processus se termine, on récupère son code de sortie.
    let state = app.state::<ClaudeState>();
    let session = state.sessions.lock().await.remove(&id);
    let code = match session {
        Some(mut s) => s.child.wait().await.ok().and_then(|status| status.code()),
        None => None,
    };
    emit(&app, &id, EventKind::Exit(code));
}

async fn forward_lines(
    app: AppHandle,
    id: String,
    reader: impl AsyncRead + Unpin,
    to_event: impl Fn(String) -> EventKind,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() {
            emit(&app, &id, to_event(line));
        }
    }
}

fn emit(app: &AppHandle, id: &str, event: EventKind) {
    let payload = ClaudeEvent {
        session_id: id.to_owned(),
        event,
    };
    if let Err(err) = app.emit(EVENT, payload) {
        eprintln!("failed to emit Claude event: {err}");
    }
}
