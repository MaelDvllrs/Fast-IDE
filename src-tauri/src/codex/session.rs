//! Sessions Codex : un processus `codex app-server` par agent, piloté en
//! JSON-RPC (un message JSON par ligne sur stdin / stdout).
//!
//! Les messages de Codex sont traduits au vol dans le format de Claude Code
//! (`system` / `stream_event` / `assistant` / `user` / `result` /
//! `control_request`) : l'interface affiche ainsi un agent Codex comme un agent
//! Claude (conversation, actions, autorisations, arrêt, jetons).

use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::{oneshot, Mutex},
};

use crate::{
    claude::{emit_exit, emit_message, emit_stderr},
    error::{AppError, AppResult},
};

/// Réponse attendue à une requête JSON-RPC : son résultat, ou le message d'erreur.
type Reply = Result<Value, String>;

struct Session {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    /// Conversation Codex (« thread ») et tour en cours.
    thread_id: Mutex<Option<String>>,
    turn_id: Mutex<Option<String>>,
    /// Demandes d'autorisation en attente : identifiant donné à l'interface → id JSON-RPC.
    approvals: Mutex<HashMap<String, Value>>,
    effort: Option<String>,
}

#[derive(Default)]
pub struct CodexState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

pub struct StartOptions {
    pub cwd: PathBuf,
    /// Modèle Codex (ex. `gpt-6.1-sol`) ; `None` = modèle par défaut du compte.
    pub model: Option<String>,
    /// Niveau de raisonnement (`low`… selon le modèle) ; `None` = celui du modèle.
    pub effort: Option<String>,
    /// Instructions ajoutées à celles de Codex (prompt système de l'agent).
    pub system_prompt: Option<String>,
    /// Conversation (thread) à reprendre.
    pub resume: Option<String>,
}

/// Délai maximal d'une requête JSON-RPC (démarrage, envoi d'un tour…).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

impl Session {
    async fn write(&self, message: &Value) -> AppResult<()> {
        let mut line = serde_json::to_vec(message)?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write(&json!({ "id": id, "method": method, "params": params })).await?;
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(AppError::msg(message)),
            Ok(Err(_)) => Err(AppError::msg("Codex stopped before answering")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(AppError::msg(format!("Codex did not answer `{method}` in time")))
            }
        }
    }
}

/// La session `id` est-elle une session Codex ?
pub async fn owns(state: &CodexState, id: &str) -> bool {
    state.sessions.lock().await.contains_key(id)
}

async fn session(state: &CodexState, id: &str) -> AppResult<Arc<Session>> {
    state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::msg(format!("unknown session {id}")))
}

/// Lance `codex app-server`, initialise le protocole et ouvre (ou reprend) la conversation.
pub async fn start(app: AppHandle, state: &CodexState, id: String, opts: StartOptions) -> AppResult<()> {
    if owns(state, &id).await {
        return Err(AppError::msg(format!("session {id} already exists")));
    }
    let mut cmd = super::command(&super::program()?);
    cmd.arg("app-server")
        .current_dir(&opts.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Outils du planificateur et accord de l'utilisateur pour un `git push` (hook pre-push).
    let mcp = crate::scheduler::register(&app, &id, &opts.cwd);
    if let Some(url) = &mcp {
        cmd.env(crate::scheduler::push::ENV, crate::scheduler::push::url(url));
    }
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| AppError::msg("stdin unavailable"))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("stdout unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::msg("stderr unavailable"))?;

    let session = Arc::new(Session {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        thread_id: Mutex::new(None),
        turn_id: Mutex::new(None),
        approvals: Mutex::new(HashMap::new()),
        effort: opts.effort.clone(),
    });
    state.sessions.lock().await.insert(id.clone(), session.clone());

    // Journal de Codex : seulement les vraies erreurs (le reste est très bavard).
    let err_app = app.clone();
    let err_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.contains("ERROR") {
                emit_stderr(&err_app, &err_id, line);
            }
        }
    });
    tauri::async_runtime::spawn(read_loop(app.clone(), id.clone(), session.clone(), stdout));

    if let Err(err) = open_thread(&app, &id, &session, &opts, mcp).await {
        stop(state, &id).await;
        return Err(err);
    }
    Ok(())
}

async fn open_thread(app: &AppHandle, id: &str, session: &Session, opts: &StartOptions, mcp: Option<String>) -> AppResult<()> {
    session
        .request(
            "initialize",
            json!({ "clientInfo": { "name": "fast", "title": "FAST", "version": env!("CARGO_PKG_VERSION") } }),
        )
        .await?;
    session.write(&json!({ "method": "initialized" })).await?;

    // Comme Claude en acceptEdits : écriture libre dans le dossier de l'agent (son
    // worktree), réseau autorisé, et approbation demandée pour le reste.
    let mut config = json!({ "sandbox_workspace_write": { "network_access": true } });
    if let Some(effort) = &opts.effort {
        config["model_reasoning_effort"] = json!(effort);
    }
    // Outils du planificateur de FAST (vérifications, builds, previews).
    if let Some(url) = &mcp {
        config["mcp_servers"] = json!({ "fast": {
            "url": url,
            "tool_timeout_sec": crate::scheduler::TOOL_TIMEOUT.as_secs(),
            // Sans cela, Codex demande l'accord à chaque appel d'un outil de FAST.
            "default_tools_approval_mode": "approve",
        }});
    }
    let mut params = json!({
        "cwd": opts.cwd,
        "approvalPolicy": "on-request",
        "sandbox": "workspace-write",
        "config": config,
    });
    if let Some(model) = &opts.model {
        params["model"] = json!(model);
    }
    let mut instructions = opts.system_prompt.clone().unwrap_or_default();
    if mcp.is_some() {
        instructions = format!("{}\n\n{instructions}", crate::scheduler::agent_instructions(app));
    }
    if !instructions.trim().is_empty() {
        params["developerInstructions"] = json!(instructions.trim());
    }

    // Conversation précédente : reprise ; introuvable, une nouvelle est ouverte.
    let mut result = None;
    if let Some(thread) = &opts.resume {
        let mut resume = params.clone();
        resume["threadId"] = json!(thread);
        resume["excludeTurns"] = json!(true);
        result = session.request("thread/resume", resume).await.ok();
    }
    let result = match result {
        Some(result) => result,
        None => session.request("thread/start", params).await?,
    };
    let thread = result["thread"]["id"].as_str().unwrap_or_default().to_owned();
    *session.thread_id.lock().await = Some(thread.clone());
    emit_message(
        app,
        id,
        json!({ "type": "system", "subtype": "init", "session_id": thread, "model": result["model"] }),
    );
    Ok(())
}

pub async fn send(state: &CodexState, id: &str, text: String) -> AppResult<()> {
    let session = session(state, id).await?;
    let thread = session.thread_id.lock().await.clone().ok_or_else(|| AppError::msg("Codex is not ready yet"))?;
    let mut params = json!({ "threadId": thread, "input": [{ "type": "text", "text": text }] });
    if let Some(effort) = &session.effort {
        params["effort"] = json!(effort);
    }
    let result = session.request("turn/start", params).await?;
    if let Some(turn) = result["turn"]["id"].as_str() {
        *session.turn_id.lock().await = Some(turn.to_owned());
    }
    Ok(())
}

/// Arrête le tour en cours ; la conversation continue au message suivant.
pub async fn interrupt(state: &CodexState, id: &str) -> AppResult<()> {
    let session = session(state, id).await?;
    let thread = session.thread_id.lock().await.clone();
    let turn = session.turn_id.lock().await.clone();
    let (Some(thread), Some(turn)) = (thread, turn) else { return Ok(()) };
    session.request("turn/interrupt", json!({ "threadId": thread, "turnId": turn })).await.map(|_| ())
}

/// Réponse de l'utilisateur à une demande d'autorisation (commande, modification de fichier).
pub async fn answer_permission(state: &CodexState, id: &str, request_id: &str, allow: bool) -> AppResult<()> {
    let session = session(state, id).await?;
    let rpc_id = session
        .approvals
        .lock()
        .await
        .remove(request_id)
        .ok_or_else(|| AppError::msg("this request is no longer pending"))?;
    let decision = if allow { "accept" } else { "decline" };
    session.write(&json!({ "id": rpc_id, "result": { "decision": decision } })).await
}

pub async fn stop(state: &CodexState, id: &str) {
    let Some(session) = state.sessions.lock().await.remove(id) else { return };
    let _ = session.child.lock().await.kill().await;
}

/// Fermeture de l'app : tous les processus Codex sont arrêtés.
pub fn stop_all(state: &CodexState) {
    let sessions: Vec<_> = state.sessions.blocking_lock().drain().map(|(_, s)| s).collect();
    for session in sessions {
        let _ = session.child.blocking_lock().start_kill();
    }
}

/// État de la traduction pendant un tour.
#[derive(Default)]
struct Translation {
    /// Jetons du tour (somme des requêtes du tour, `last` de chaque mise à jour).
    input: u64,
    cached: u64,
    output: u64,
    cache_write: u64,
    model: Option<String>,
    /// Fichiers des modifications annoncées (pour les demandes d'autorisation).
    file_changes: HashMap<String, String>,
}

async fn read_loop(app: AppHandle, id: String, session: Arc<Session>, stdout: tokio::process::ChildStdout) {
    let mut lines = BufReader::new(stdout).lines();
    let mut tr = Translation::default();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let method = message["method"].as_str().map(str::to_owned);
        match (method, message.get("id")) {
            // Réponse à une requête de FAST.
            (None, Some(rpc_id)) => {
                let Some(rpc_id) = rpc_id.as_u64() else { continue };
                if let Some(tx) = session.pending.lock().await.remove(&rpc_id) {
                    let reply = match message.get("error") {
                        Some(error) => Err(error["message"].as_str().unwrap_or("Codex error").to_owned()),
                        None => Ok(message["result"].clone()),
                    };
                    let _ = tx.send(reply);
                }
            }
            // Requête de Codex (autorisation…).
            (Some(method), Some(rpc_id)) => {
                server_request(&app, &id, &session, &tr, &method, rpc_id.clone(), &message["params"]).await;
            }
            // Notification.
            (Some(method), None) => notification(&app, &id, &mut tr, &method, &message["params"]),
            _ => {}
        }
    }
    // Processus terminé : les requêtes en attente échouent, l'interface est prévenue.
    for (_, tx) in session.pending.lock().await.drain() {
        let _ = tx.send(Err("Codex stopped".into()));
    }
    let code = session.child.lock().await.wait().await.ok().and_then(|s| s.code());
    emit_exit(&app, &id, code);
}

/// Commande lisible : Codex enveloppe ses commandes dans `powershell.exe -Command "…"` (ou `bash -lc '…'`).
pub(crate) fn clean_command(command: &str) -> String {
    let trimmed = command.trim();
    for marker in [" -Command \"", " -lc '", " -lc \"", " -c \""] {
        if let Some(start) = trimmed.find(marker) {
            let head = &trimmed[..start];
            if head.contains("powershell") || head.contains("pwsh") || head.contains("bash") || head.contains("sh\"") || head.ends_with("sh") {
                let inner = &trimmed[start + marker.len()..];
                let quote = marker.chars().last().unwrap_or('"');
                return inner.strip_suffix(quote).unwrap_or(inner).trim().to_owned();
            }
        }
    }
    trimmed.to_owned()
}

/// Outil « Claude » équivalent à un élément Codex : nom et paramètres affichés.
fn tool_for(item: &Value) -> Option<(String, Value)> {
    match item["type"].as_str()? {
        "commandExecution" => {
            let command = clean_command(item["command"].as_str().unwrap_or_default());
            Some(("Bash".into(), json!({ "command": command })))
        }
        "fileChange" => {
            let changes = item["changes"].as_array().cloned().unwrap_or_default();
            let first = changes.first()?;
            let path = first["path"].as_str().unwrap_or_default();
            let tool = if first["kind"]["type"] == "add" { "Write" } else { "Edit" };
            Some((tool.into(), json!({ "file_path": path })))
        }
        "mcpToolCall" => Some((
            format!("mcp__{}__{}", item["server"].as_str().unwrap_or("mcp"), item["tool"].as_str().unwrap_or("tool")),
            item["arguments"].clone(),
        )),
        "webSearch" => Some(("WebSearch".into(), json!({ "query": item["query"] }))),
        "imageView" => Some(("Read".into(), json!({ "file_path": item["path"] }))),
        _ => None,
    }
}

/// Sortie de la traduction : un message au format Claude, ou une erreur à afficher.
#[derive(Debug, PartialEq)]
enum Out {
    Message(Value),
    Stderr(String),
}

fn notification(app: &AppHandle, id: &str, tr: &mut Translation, method: &str, params: &Value) {
    for out in translate(tr, method, params) {
        match out {
            Out::Message(message) => emit_message(app, id, message),
            Out::Stderr(line) => emit_stderr(app, id, line),
        }
    }
}

/// Notification Codex → messages au format de Claude Code (stream-json).
fn translate(tr: &mut Translation, method: &str, params: &Value) -> Vec<Out> {
    let mut out = Vec::new();
    let item = &params["item"];
    let stream = |event: Value| Out::Message(json!({ "type": "stream_event", "event": event }));
    match method {
        "item/agentMessage/delta" => {
            out.push(stream(json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": params["delta"] } })));
        }
        "item/started" => match item["type"].as_str() {
            Some("reasoning") => out.push(stream(json!({ "type": "content_block_start", "content_block": { "type": "thinking" } }))),
            _ => {
                if item["type"] == "fileChange" {
                    if let (Some(item_id), Some(path)) = (item["id"].as_str(), item["changes"][0]["path"].as_str()) {
                        tr.file_changes.insert(item_id.to_owned(), path.to_owned());
                    }
                }
                if let Some((name, input)) = tool_for(item) {
                    out.push(Out::Message(json!({
                        "type": "assistant",
                        "message": { "content": [{ "type": "tool_use", "id": item["id"], "name": name, "input": input }] },
                    })));
                }
            }
        },
        "item/completed" => match item["type"].as_str() {
            Some("reasoning") => out.push(stream(json!({ "type": "content_block_stop" }))),
            Some("agentMessage") => {
                let text = item["text"].as_str().unwrap_or_default();
                if !text.trim().is_empty() {
                    out.push(Out::Message(json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": text }] } })));
                }
            }
            _ => {
                if tool_for(item).is_some() {
                    let failed = matches!(item["status"].as_str(), Some("failed" | "declined"));
                    out.push(Out::Message(json!({
                        "type": "user",
                        "message": { "content": [{ "type": "tool_result", "tool_use_id": item["id"], "is_error": failed }] },
                    })));
                }
            }
        },
        "thread/tokenUsage/updated" => {
            // `inputTokens` comprend les jetons relus depuis le cache : on les sépare.
            let last = &params["tokenUsage"]["last"];
            let n = |key: &str| last[key].as_u64().unwrap_or(0);
            let cached = n("cachedInputTokens");
            tr.input += n("inputTokens").saturating_sub(cached);
            tr.cached += cached;
            tr.output += n("outputTokens");
            tr.cache_write += n("cacheWriteInputTokens");
        }
        "model/rerouted" | "thread/started" => {
            if let Some(model) = params["thread"]["model"].as_str().or(params["model"].as_str()) {
                tr.model = Some(model.to_owned());
            }
        }
        "turn/completed" => {
            let turn = &params["turn"];
            let status = turn["status"].as_str().unwrap_or("completed");
            let model = tr.model.clone().unwrap_or_else(|| "codex".into());
            out.push(Out::Message(json!({
                "type": "result",
                "subtype": status,
                "is_error": status != "completed",
                "result": turn["error"]["message"],
                "usage": {
                    "input_tokens": tr.input,
                    "output_tokens": tr.output,
                    "cache_read_input_tokens": tr.cached,
                    "cache_creation_input_tokens": tr.cache_write,
                },
                "modelUsage": { model: {
                    "inputTokens": tr.input, "outputTokens": tr.output,
                    "cacheReadInputTokens": tr.cached, "cacheCreationInputTokens": tr.cache_write, "costUSD": 0.0,
                }},
                // L'abonnement ChatGPT n'est pas facturé au jeton : pas de coût estimé.
                "total_cost_usd": 0.0,
            })));
            *tr = Translation { model: tr.model.take(), ..Default::default() };
        }
        "error" => {
            if params["willRetry"] != true {
                out.push(Out::Stderr(params["error"]["message"].as_str().unwrap_or("Codex error").to_owned()));
            }
        }
        _ => {}
    }
    out
}

async fn server_request(
    app: &AppHandle,
    id: &str,
    session: &Session,
    tr: &Translation,
    method: &str,
    rpc_id: Value,
    params: &Value,
) {
    let (tool, input) = match method {
        "item/commandExecution/requestApproval" => (
            "Bash",
            json!({
                "command": clean_command(params["command"].as_str().unwrap_or_default()),
                "description": params["reason"],
            }),
        ),
        "item/fileChange/requestApproval" => {
            let path = params["itemId"].as_str().and_then(|i| tr.file_changes.get(i)).cloned().unwrap_or_default();
            ("Edit", json!({ "file_path": path, "description": params["reason"] }))
        }
        // Autres demandes (saisie, MCP…) : pas encore gérées, refusées pour ne pas bloquer l'agent.
        _ => {
            let _ = session
                .write(&json!({ "id": rpc_id, "error": { "code": -32601, "message": format!("{method} is not supported by FAST") } }))
                .await;
            return;
        }
    };
    let request_id = format!("codex-{}", rpc_id.to_string().trim_matches('"'));
    session.approvals.lock().await.insert(request_id.clone(), rpc_id);
    emit_message(
        app,
        id,
        json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "can_use_tool", "tool_name": tool, "input": input },
        }),
    );
}

/// Modèles proposés par Codex pour le compte connecté (via un `app-server` éphémère).
pub async fn models() -> AppResult<Vec<Value>> {
    let mut cmd = super::command(&super::program()?);
    cmd.arg("app-server")
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
            json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "fast", "version": env!("CARGO_PKG_VERSION") } } }),
            json!({ "method": "initialized" }),
            json!({ "id": 2, "method": "model/list", "params": {} }),
        ];
        for request in requests {
            let mut line = serde_json::to_vec(&request)?;
            line.push(b'\n');
            stdin.write_all(&line).await?;
        }
        stdin.flush().await?;
        while let Some(line) = lines.next_line().await? {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if message["id"] == 2 {
                if let Some(error) = message.get("error") {
                    return Err(AppError::msg(error["message"].as_str().unwrap_or("Codex error").to_owned()));
                }
                let models = message["result"]["data"].as_array().cloned().unwrap_or_default();
                return Ok(models.into_iter().filter(|m| m["hidden"] != true).collect());
            }
        }
        Err(AppError::msg("Codex stopped before listing its models"))
    };
    let result = tokio::time::timeout(Duration::from_secs(60), exchange)
        .await
        .map_err(|_| AppError::msg("Codex did not answer in time"))?;
    let _ = child.kill().await;
    result
}

#[cfg(test)]
mod tests {
    use super::{clean_command, translate, Out, Translation};
    use serde_json::json;

    /// Un tour réel de Codex (messages relevés sur `codex app-server` 0.164) → format Claude.
    #[test]
    fn translates_a_turn() {
        let mut tr = Translation::default();
        let mut all = Vec::new();
        let mut feed = |method: &str, params: serde_json::Value| all.extend(translate(&mut tr, method, &params));
        feed("item/agentMessage/delta", json!({ "itemId": "m1", "delta": "Hel" }));
        feed("item/completed", json!({ "item": { "type": "agentMessage", "id": "m1", "text": "Hello", "phase": "commentary" } }));
        feed("item/started", json!({ "item": { "type": "commandExecution", "id": "c1", "status": "inProgress",
            "command": r#""C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "git --version""# } }));
        feed("item/completed", json!({ "item": { "type": "commandExecution", "id": "c1", "status": "failed", "command": "x" } }));
        feed("item/started", json!({ "item": { "type": "fileChange", "id": "f1", "status": "inProgress",
            "changes": [{ "path": r"D:\p\hello.txt", "kind": { "type": "add" }, "diff": "" }] } }));
        feed("thread/tokenUsage/updated", json!({ "tokenUsage": { "last": { "inputTokens": 17018, "cachedInputTokens": 13440, "outputTokens": 65, "cacheWriteInputTokens": 0 } } }));
        feed("thread/tokenUsage/updated", json!({ "tokenUsage": { "last": { "inputTokens": 17349, "cachedInputTokens": 13440, "outputTokens": 105 } } }));
        feed("turn/completed", json!({ "turn": { "id": "t1", "status": "completed", "error": null } }));

        let messages: Vec<_> = all.iter().map(|o| match o { Out::Message(m) => m.clone(), Out::Stderr(e) => json!({ "stderr": e }) }).collect();
        assert_eq!(messages[0]["event"]["delta"]["text"], "Hel");
        assert_eq!(messages[1]["message"]["content"][0]["text"], "Hello");
        assert_eq!(messages[2]["message"]["content"][0]["name"], "Bash");
        assert_eq!(messages[2]["message"]["content"][0]["input"]["command"], "git --version");
        assert_eq!(messages[3]["message"]["content"][0]["is_error"], true);
        assert_eq!(messages[4]["message"]["content"][0]["name"], "Write");
        assert_eq!(messages[4]["message"]["content"][0]["input"]["file_path"], r"D:\p\hello.txt");
        let result = &messages[5];
        assert_eq!(result["type"], "result");
        assert_eq!(result["is_error"], false);
        // Entrées hors cache : (17018 - 13440) + (17349 - 13440).
        assert_eq!(result["usage"]["input_tokens"], 3578 + 3909);
        assert_eq!(result["usage"]["cache_read_input_tokens"], 26880);
        assert_eq!(result["usage"]["output_tokens"], 170);
        assert_eq!(messages.len(), 6);
        // Le tour suivant repart de zéro.
        assert_eq!(tr.input, 0);
    }

    #[test]
    fn unwraps_shell_commands() {
        assert_eq!(
            clean_command(r#""C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "git --version""#),
            "git --version"
        );
        assert_eq!(clean_command("/bin/bash -lc 'npm test'"), "npm test");
        assert_eq!(clean_command("ls -la"), "ls -la");
    }
}
