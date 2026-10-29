//! Orchestration du véritable agent Claude Code.
//!
//! Chaque session est un processus `claude` lancé en mode headless avec un flux
//! JSON bidirectionnel (stdin/stdout). Rust relaie chaque ligne JSON à
//! l'interface via l'événement `claude://event`.

use std::{collections::HashMap, path::PathBuf, process::Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

use crate::{
    codex::{self, CodexState},
    error::{AppError, AppResult},
    gemini::{self, GeminiState},
    platform, scheduler,
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

/// Message au format de Claude Code, pour la session `id` (utilisé aussi par les
/// sessions Codex, traduites dans ce format).
pub(crate) fn emit_message<R: Runtime>(app: &AppHandle<R>, id: &str, message: serde_json::Value) {
    emit(app, id, EventKind::Message(message));
}

pub(crate) fn emit_stderr(app: &AppHandle, id: &str, line: String) {
    emit(app, id, EventKind::Stderr(line));
}

pub(crate) fn emit_exit(app: &AppHandle, id: &str, code: Option<i32>) {
    emit(app, id, EventKind::Exit(code));
}

pub struct StartOptions {
    pub cwd: PathBuf,
    pub permission_mode: Option<String>,
    /// Alias ou nom de modèle (`opus`, `sonnet`…) ; `None` = modèle par défaut du compte.
    pub model: Option<String>,
    /// Identifiant d'une conversation à reprendre (changement de modèle en cours de route).
    pub resume: Option<String>,
    /// Niveau d'effort (`low`, `medium`, `high`, `xhigh`, `max`) ; `None` = celui du compte.
    pub effort: Option<String>,
    /// Instructions ajoutées au prompt système de Claude Code ; `Some("")` = retirées.
    pub system_prompt: Option<String>,
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
    /// Compte connecté (e-mail, organisation, formule : « pro », « max », « team »…).
    email: Option<String>,
    org_name: Option<String>,
    subscription_type: Option<String>,
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

/// Modèle rapide pour les petites tâches de l'interface (résumé d'une conversation).
const SUMMARY_MODEL: &str = "claude-haiku-5-5";

/// Réponse courte d'un modèle rapide, sans aucun outil ni session gardée : sert
/// au résumé en une ligne de chaque conversation d'agent.
pub async fn quick_answer(prompt: &str) -> AppResult<String> {
    let mut cmd = claude_command(&platform::claude_program()?);
    cmd.args(["-p", prompt, "--model", SUMMARY_MODEL, "--tools", "", "--effort", "low"])
        .args(["--no-session-persistence", "--output-format", "json"])
        // Hors du projet : rien à lire, rien à modifier.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(90), cmd.output())
        .await
        .map_err(|_| AppError::msg("Claude did not answer in time"))??;
    let result: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| AppError::msg(String::from_utf8_lossy(&out.stderr).trim().to_owned()))?;
    if result["is_error"] == true {
        return Err(AppError::msg(result["result"].as_str().unwrap_or("Claude failed").to_owned()));
    }
    Ok(result["result"].as_str().unwrap_or_default().trim().to_owned())
}

pub async fn status() -> ClaudeStatus {
    let install_command = platform::claude_install_command().to_owned();
    let Ok(program) = platform::claude_program() else {
        return ClaudeStatus {
            installed: false,
            logged_in: false,
            install_command,
            login_command: None,
            email: None,
            org_name: None,
            subscription_type: None,
        };
    };

    // `claude auth status` répond en JSON : { "loggedIn": true, "authMethod": "claude.ai", ... }
    let mut cmd = claude_command(&program);
    cmd.args(["auth", "status"]).stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await;
    let auth = match output {
        Ok(Ok(out)) => serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap_or_default(),
        _ => serde_json::Value::Null,
    };
    let logged_in = auth["loggedIn"] == true && auth["authMethod"] == "claude.ai";
    let field = |key: &str| logged_in.then(|| auth[key].as_str().map(str::to_owned)).flatten();

    ClaudeStatus {
        installed: true,
        logged_in,
        install_command,
        login_command: Some(platform::claude_login_command(&program)),
        email: field("email"),
        org_name: field("orgName"),
        subscription_type: field("subscriptionType"),
    }
}

/// Déconnecte Claude Code du compte claude.ai.
pub async fn logout() -> AppResult<()> {
    let mut cmd = claude_command(&platform::claude_program()?);
    cmd.args(["auth", "logout"]).stdin(Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output())
        .await
        .map_err(|_| AppError::msg("Claude Code did not answer in time"))??;
    if out.status.success() {
        Ok(())
    } else {
        Err(AppError::msg(String::from_utf8_lossy(&out.stderr).trim().to_owned()))
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
        // Les demandes d'autorisation (commande à lancer, fichier hors du projet…)
        // arrivent à FAST (`control_request` / `can_use_tool`) au lieu d'être refusées
        // d'office faute de fenêtre interactive ; l'interface y répond.
        "--permission-prompt-tool",
        "stdio",
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
    if let Some(effort) = &opts.effort {
        cmd.args(["--effort", effort]);
    }
    // Outils du planificateur (vérifications, builds, previews) : serveur MCP de FAST,
    // autorisés d'office ; leurs instructions s'ajoutent au prompt système.
    let mut system_prompt = opts.system_prompt.clone().unwrap_or_default();
    if let Some(url) = scheduler::register(&app, &id, &opts.cwd) {
        let config = serde_json::json!({ "mcpServers": { "fast": { "type": "http", "url": url } } });
        let path = std::env::temp_dir().join(format!("fast-mcp-{}.json", id.replace(|c: char| !c.is_ascii_alphanumeric(), "-")));
        std::fs::write(&path, config.to_string())?;
        cmd.arg("--mcp-config").arg(path).args(["--allowedTools", "mcp__fast"]);
        cmd.env("MCP_TOOL_TIMEOUT", scheduler::TOOL_TIMEOUT.as_millis().to_string());
        // Un `git push` de l'agent attend l'accord de l'utilisateur (hook pre-push).
        cmd.env(scheduler::push::ENV, scheduler::push::url(&url));
        system_prompt = format!("{}\n\n{system_prompt}", scheduler::agent_instructions(&app));
    }
    if !system_prompt.trim().is_empty() {
        cmd.args(["--append-system-prompt", system_prompt.trim()]);
    }
    // Sans cela, une conversation reprise garde le prompt système enregistré à
    // son premier message : une modification (ou un retrait) ne s'appliquerait pas.
    cmd.args(["--system-prompt-snapshot", "off"]);
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

/// Réponse à une demande d'autorisation de Claude Code (`control_request` reçu
/// avec `request_id`) : `allow` autorise l'outil tel quel, sinon il est refusé
/// avec `message` (que Claude lit pour adapter sa suite).
pub async fn answer_permission(
    state: &ClaudeState,
    id: &str,
    request_id: String,
    allow: bool,
    input: serde_json::Value,
    message: Option<String>,
) -> AppResult<()> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("unknown session {id}")))?;

    let decision = if allow {
        serde_json::json!({ "behavior": "allow", "updatedInput": input })
    } else {
        serde_json::json!({
            "behavior": "deny",
            "message": message.unwrap_or_else(|| "The user denied this action.".into()),
        })
    };
    let reply = serde_json::json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": decision },
    });
    let mut line = serde_json::to_vec(&reply)?;
    line.push(b'\n');
    session.stdin.write_all(&line).await?;
    session.stdin.flush().await?;
    Ok(())
}

/// Arrête le tour en cours d'un agent (bouton Stop) ; la session reste ouverte
/// et la conversation continue au message suivant.
pub async fn interrupt(state: &ClaudeState, id: &str) -> AppResult<()> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(id)
        .ok_or_else(|| AppError::msg(format!("unknown session {id}")))?;
    let request = serde_json::json!({
        "type": "control_request",
        "request_id": format!("fast-interrupt-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
        "request": { "subtype": "interrupt" },
    });
    let mut line = serde_json::to_vec(&request)?;
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

/// Réponse à une demande d'autorisation, quelle que soit l'IA de la session.
async fn answer_any<R: Runtime>(app: AppHandle<R>, id: String, request_id: String, allow: bool, input: serde_json::Value, reason: Option<String>) {
    let codex = app.state::<CodexState>();
    if codex::owns(&codex, &id).await {
        let _ = codex::answer_permission(&codex, &id, &request_id, allow).await;
        return;
    }
    let gemini = app.state::<GeminiState>();
    if gemini::owns(&gemini, &id).await {
        let _ = gemini::answer_permission(&gemini, &id, &request_id, allow).await;
        return;
    }
    let _ = answer_permission(&app.state::<ClaudeState>(), &id, request_id, allow, input, reason).await;
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

fn emit<R: Runtime>(app: &AppHandle<R>, id: &str, event: EventKind) {
    // Planificateur : fin de tour, fin de session, et commandes lourdes lancées dans le shell.
    match &event {
        EventKind::Message(message) if message["type"] == "result" => scheduler::turn_ended(app, id),
        EventKind::Message(message) if message["type"] == "control_request" && message["request"]["subtype"] == "can_use_tool" => {
            let request = &message["request"];
            if let Some((allow, reason)) = scheduler::guard(app, id, request["tool_name"].as_str().unwrap_or_default(), &request["input"]) {
                let request_id = message["request_id"].as_str().unwrap_or_default().to_owned();
                let input = request["input"].clone();
                tauri::async_runtime::spawn(answer_any(app.clone(), id.to_owned(), request_id, allow, input, reason));
                return;
            }
        }
        EventKind::Exit(_) => scheduler::session_ended(app, id),
        _ => {}
    }
    let payload = ClaudeEvent {
        session_id: id.to_owned(),
        event,
    };
    if let Err(err) = app.emit(EVENT, payload) {
        eprintln!("failed to emit Claude event: {err}");
    }
}
