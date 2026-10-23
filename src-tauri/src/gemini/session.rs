//! Sessions Gemini : un processus `gemini --acp` par agent (Agent Client
//! Protocol, JSON-RPC, un message par ligne). Les messages sont traduits dans le
//! format de Claude Code, comme pour Codex : l'interface les affiche tels quels.

use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
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
    claude::{emit_exit, emit_message},
    error::{AppError, AppResult},
};

type Reply = Result<Value, String>;

struct Session {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    /// Session ACP (conversation de Gemini CLI).
    session_id: Mutex<Option<String>>,
    /// Un tour est en cours : en dehors, les `session/update` sont la relecture
    /// de l'historique (reprise) et sont ignorés, FAST affichant déjà la conversation.
    prompting: AtomicBool,
    /// Demandes d'autorisation en attente : identifiant donné à l'interface → (id JSON-RPC, options).
    approvals: Mutex<HashMap<String, (Value, Vec<Value>)>>,
    /// Prompt système de l'agent, ajouté en tête du premier message (ACP n'a pas de champ pour cela).
    system_prompt: Mutex<Option<String>>,
    translation: Mutex<Translation>,
}

#[derive(Default)]
pub struct GeminiState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

pub struct StartOptions {
    pub cwd: PathBuf,
    /// Modèle (ex. `gemini-2.5-pro`) ; `None` = « auto » (choix de Gemini CLI).
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    /// Session ACP à reprendre.
    pub resume: Option<String>,
}

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

    /// Requête JSON-RPC ; `timeout` à `None` pour un tour (aussi long que nécessaire).
    async fn request(&self, method: &str, params: Value, timeout: Option<Duration>) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        let reply = match timeout {
            Some(limit) => match tokio::time::timeout(limit, rx).await {
                Ok(reply) => reply,
                Err(_) => {
                    self.pending.lock().await.remove(&id);
                    return Err(AppError::msg(format!("Gemini CLI did not answer `{method}` in time")));
                }
            },
            None => rx.await,
        };
        match reply {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(message)) => Err(AppError::msg(message)),
            Err(_) => Err(AppError::msg("Gemini CLI stopped before answering")),
        }
    }
}

pub async fn owns(state: &GeminiState, id: &str) -> bool {
    state.sessions.lock().await.contains_key(id)
}

async fn session(state: &GeminiState, id: &str) -> AppResult<Arc<Session>> {
    state.sessions.lock().await.get(id).cloned().ok_or_else(|| AppError::msg(format!("unknown session {id}")))
}

pub async fn start(app: AppHandle, state: &GeminiState, id: String, opts: StartOptions) -> AppResult<()> {
    if owns(state, &id).await {
        return Err(AppError::msg(format!("session {id} already exists")));
    }
    let mut cmd = super::command()?;
    cmd.arg("--acp")
        .current_dir(&opts.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| AppError::msg("stdin unavailable"))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("stdout unavailable"))?;

    let session = Arc::new(Session {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        session_id: Mutex::new(None),
        prompting: AtomicBool::new(false),
        approvals: Mutex::new(HashMap::new()),
        system_prompt: Mutex::new(opts.system_prompt.clone().filter(|p| !p.trim().is_empty())),
        translation: Mutex::new(Translation::default()),
    });
    state.sessions.lock().await.insert(id.clone(), session.clone());
    tauri::async_runtime::spawn(read_loop(app.clone(), id.clone(), session.clone(), stdout));

    if let Err(err) = open_session(&app, &id, &session, &opts).await {
        stop(state, &id).await;
        return Err(err);
    }
    Ok(())
}

async fn open_session(app: &AppHandle, id: &str, session: &Session, opts: &StartOptions) -> AppResult<()> {
    let init = session
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            }),
            Some(REQUEST_TIMEOUT),
        )
        .await?;
    // Outils du planificateur de FAST, si Gemini CLI accepte les serveurs MCP en HTTP.
    let mut mcp_servers = json!([]);
    if init["agentCapabilities"]["mcpCapabilities"]["http"] == true {
        if let Some(url) = crate::scheduler::register(app, id, &opts.cwd) {
            mcp_servers = json!([{ "type": "http", "name": "fast", "url": url, "headers": [] }]);
            let mut prompt = session.system_prompt.lock().await;
            *prompt = Some(format!("{}\n\n{}", crate::scheduler::agent_instructions(app), prompt.clone().unwrap_or_default()));
        }
    }

    // Reprise de la conversation ; introuvable, une nouvelle est ouverte.
    let mut session_id = None;
    let mut result = None;
    if let Some(previous) = &opts.resume {
        let params = json!({ "sessionId": previous, "cwd": opts.cwd, "mcpServers": mcp_servers });
        if let Ok(loaded) = session.request("session/load", params, Some(REQUEST_TIMEOUT)).await {
            session_id = Some(previous.clone());
            result = Some(loaded);
        }
    }
    let result = match result {
        Some(result) => result,
        None => {
            let created = session
                .request("session/new", json!({ "cwd": opts.cwd, "mcpServers": mcp_servers }), Some(REQUEST_TIMEOUT))
                .await
                .map_err(|err| {
                    // Sans compte, Gemini CLI réclame une clé API : message trompeur ici.
                    if super::status().logged_in {
                        err
                    } else {
                        AppError::msg("Not signed in to Gemini: sign in with Google in AI & Models.")
                    }
                })?;
            session_id = created["sessionId"].as_str().map(str::to_owned);
            created
        }
    };
    let session_id = session_id.ok_or_else(|| AppError::msg("Gemini CLI did not open a session"))?;
    *session.session_id.lock().await = Some(session_id.clone());

    // Comme Claude en acceptEdits : modifications acceptées d'office, commandes soumises à
    // approbation. Dossier non approuvé par Gemini CLI : mode par défaut (tout est demandé).
    let _ = session
        .request("session/set_mode", json!({ "sessionId": session_id, "modeId": "autoEdit" }), Some(REQUEST_TIMEOUT))
        .await;
    let mut model = result["models"]["currentModelId"].as_str().unwrap_or("auto").to_owned();
    if let Some(chosen) = &opts.model {
        if session
            .request("session/set_model", json!({ "sessionId": session_id, "modelId": chosen }), Some(REQUEST_TIMEOUT))
            .await
            .is_ok()
        {
            model = chosen.clone();
        }
    }
    session.translation.lock().await.model = Some(model.clone());
    emit_message(
        app,
        id,
        json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
            "model": model,
            // Modèles proposés au compte (ACP n'a pas de méthode pour les lister à part).
            "available_models": result["models"]["availableModels"],
        }),
    );
    Ok(())
}

pub async fn send(app: AppHandle, state: &GeminiState, id: &str, text: String) -> AppResult<()> {
    let session = session(state, id).await?;
    let session_id = session.session_id.lock().await.clone().ok_or_else(|| AppError::msg("Gemini CLI is not ready yet"))?;
    let text = match session.system_prompt.lock().await.take() {
        Some(prompt) => format!("<instructions>\n{prompt}\n</instructions>\n\n{text}"),
        None => text,
    };
    session.prompting.store(true, Ordering::SeqCst);
    {
        let mut tr = session.translation.lock().await;
        *tr = Translation { model: tr.model.take(), ..Default::default() };
    }

    // Un tour dure tant que l'agent travaille : la réponse arrive à sa fin.
    let id = id.to_owned();
    tauri::async_runtime::spawn(async move {
        let params = json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] });
        let reply = session.request("session/prompt", params, None).await;
        session.prompting.store(false, Ordering::SeqCst);
        let mut tr = session.translation.lock().await;
        for out in tr.flush() {
            out.emit(&app, &id);
        }
        result_message(&tr, reply).emit(&app, &id);
    });
    Ok(())
}

/// Arrête le tour en cours ; les autorisations en attente sont annulées.
pub async fn interrupt(state: &GeminiState, id: &str) -> AppResult<()> {
    let session = session(state, id).await?;
    let Some(session_id) = session.session_id.lock().await.clone() else { return Ok(()) };
    for (_, (rpc_id, _)) in session.approvals.lock().await.drain() {
        let _ = session
            .write(&json!({ "jsonrpc": "2.0", "id": rpc_id, "result": { "outcome": { "outcome": "cancelled" } } }))
            .await;
    }
    session.write(&json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session_id } })).await
}

/// Réponse de l'utilisateur : l'option « autoriser une fois » ou « refuser » de Gemini CLI.
pub async fn answer_permission(state: &GeminiState, id: &str, request_id: &str, allow: bool) -> AppResult<()> {
    let session = session(state, id).await?;
    let (rpc_id, options) = session
        .approvals
        .lock()
        .await
        .remove(request_id)
        .ok_or_else(|| AppError::msg("this request is no longer pending"))?;
    let wanted = if allow { "allow_once" } else { "reject_once" };
    let option = options
        .iter()
        .find(|o| o["kind"] == wanted)
        .and_then(|o| o["optionId"].as_str())
        .unwrap_or(if allow { "proceed_once" } else { "cancel" });
    session
        .write(&json!({ "jsonrpc": "2.0", "id": rpc_id, "result": { "outcome": { "outcome": "selected", "optionId": option } } }))
        .await
}

pub async fn stop(state: &GeminiState, id: &str) {
    let Some(session) = state.sessions.lock().await.remove(id) else { return };
    let _ = session.child.lock().await.kill().await;
}

pub fn stop_all(state: &GeminiState) {
    let sessions: Vec<_> = state.sessions.blocking_lock().drain().map(|(_, s)| s).collect();
    for session in sessions {
        let _ = session.child.blocking_lock().start_kill();
    }
}

// --- Traduction ACP → format Claude Code -----------------------------------------

#[derive(Debug, PartialEq)]
enum Out {
    Message(Value),
}

impl Out {
    fn emit(self, app: &AppHandle, id: &str) {
        match self {
            Out::Message(message) => emit_message(app, id, message),
        }
    }
}

#[derive(Default)]
struct Translation {
    /// Texte de la réponse en cours (Gemini n'envoie que des morceaux).
    text: String,
    thinking: bool,
    /// Outils annoncés : nom et paramètres affichés (pour les mises à jour sans détail).
    tools: HashMap<String, (String, Value)>,
    model: Option<String>,
}

impl Translation {
    /// Fin du texte ou de la réflexion en cours : le message complet remplace le texte affiché au fil de l'eau.
    fn flush(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        if self.thinking {
            self.thinking = false;
            out.push(Out::Message(json!({ "type": "stream_event", "event": { "type": "content_block_stop" } })));
        }
        let text = std::mem::take(&mut self.text);
        if !text.trim().is_empty() {
            out.push(Out::Message(json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": text }] } })));
        }
        out
    }
}

/// Outil « Claude » équivalent à un appel d'outil ACP (catégorie, titre, emplacements).
fn tool_for(call: &Value) -> (String, Value) {
    let title = call["title"].as_str().unwrap_or_default();
    let path = call["locations"][0]["path"]
        .as_str()
        .or_else(|| call["content"].as_array().and_then(|c| c.iter().find_map(|i| i["path"].as_str())));
    match call["kind"].as_str().unwrap_or("other") {
        "execute" => ("Bash".into(), json!({ "command": title })),
        "edit" | "delete" | "move" => {
            let creating = title.starts_with("Create ") || title.starts_with("Writing to ");
            (if creating { "Write" } else { "Edit" }.into(), json!({ "file_path": path.unwrap_or(title) }))
        }
        "read" => ("Read".into(), json!({ "file_path": path.unwrap_or(title) })),
        "search" => ("Grep".into(), json!({ "pattern": title })),
        "fetch" => ("WebFetch".into(), json!({ "url": title })),
        _ => (if title.is_empty() { "tool".into() } else { title.to_owned() }, json!({})),
    }
}

/// `session/update` → messages au format Claude.
fn translate(tr: &mut Translation, update: &Value) -> Vec<Out> {
    let mut out = Vec::new();
    let stream = |event: Value| Out::Message(json!({ "type": "stream_event", "event": event }));
    match update["sessionUpdate"].as_str() {
        Some("agent_message_chunk") => {
            let text = update["content"]["text"].as_str().unwrap_or_default();
            // Gemini CLI signale un changement de mode par un faux message.
            if text.starts_with("[MODE_UPDATE]") {
                return out;
            }
            if tr.thinking {
                tr.thinking = false;
                out.push(stream(json!({ "type": "content_block_stop" })));
            }
            tr.text.push_str(text);
            out.push(stream(json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": text } })));
        }
        Some("agent_thought_chunk") => {
            if !tr.thinking {
                out.extend(tr.flush());
                tr.thinking = true;
                out.push(stream(json!({ "type": "content_block_start", "content_block": { "type": "thinking" } })));
            }
        }
        Some("tool_call") => {
            out.extend(tr.flush());
            let id = update["toolCallId"].as_str().unwrap_or_default().to_owned();
            let (name, input) = tool_for(update);
            tr.tools.insert(id.clone(), (name.clone(), input.clone()));
            out.push(Out::Message(json!({
                "type": "assistant",
                "message": { "content": [{ "type": "tool_use", "id": id, "name": name, "input": input }] },
            })));
            if matches!(update["status"].as_str(), Some("completed" | "failed")) {
                out.push(tool_result(&id, update["status"] == "failed"));
            }
        }
        Some("tool_call_update") => {
            let id = update["toolCallId"].as_str().unwrap_or_default();
            if matches!(update["status"].as_str(), Some("completed" | "failed")) {
                out.push(tool_result(id, update["status"] == "failed"));
            }
        }
        _ => {}
    }
    out
}

fn tool_result(id: &str, failed: bool) -> Out {
    Out::Message(json!({
        "type": "user",
        "message": { "content": [{ "type": "tool_result", "tool_use_id": id, "is_error": failed }] },
    }))
}

/// Réponse de `session/prompt` → message `result` (fin du tour, jetons).
fn result_message(tr: &Translation, reply: AppResult<Value>) -> Out {
    let model = tr.model.clone().unwrap_or_else(|| "gemini".into());
    let (stop, error, usage) = match reply {
        Ok(result) => (result["stopReason"].as_str().unwrap_or("end_turn").to_owned(), None, result["usage"].clone()),
        Err(err) => ("error".to_owned(), Some(err.to_string()), Value::Null),
    };
    let n = |key: &str| usage[key].as_u64().unwrap_or(0);
    // `inputTokens` comprend les jetons relus depuis le cache : on les sépare.
    let cached = n("cachedReadTokens");
    let input = n("inputTokens").saturating_sub(cached);
    let output = n("outputTokens") + n("thoughtTokens");
    let message = match (stop.as_str(), &error) {
        (_, Some(err)) => Some(err.clone()),
        ("max_tokens", _) => Some("The conversation is too long for the model's context window.".into()),
        ("max_turn_requests", _) => Some("Gemini stopped: too many steps in a single turn.".into()),
        _ => None,
    };
    Out::Message(json!({
        "type": "result",
        "subtype": stop,
        "is_error": stop != "end_turn",
        "result": message,
        "usage": { "input_tokens": input, "output_tokens": output, "cache_read_input_tokens": cached, "cache_creation_input_tokens": 0 },
        "modelUsage": { model: {
            "inputTokens": input, "outputTokens": output, "cacheReadInputTokens": cached, "cacheCreationInputTokens": 0, "costUSD": 0.0,
        }},
        // Le compte Google n'est pas facturé au jeton : pas de coût estimé.
        "total_cost_usd": 0.0,
    }))
}

async fn read_loop(app: AppHandle, id: String, session: Arc<Session>, stdout: tokio::process::ChildStdout) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let method = message["method"].as_str().map(str::to_owned);
        match (method, message.get("id")) {
            // Réponse à une requête de FAST.
            (None, Some(rpc_id)) => {
                let Some(rpc_id) = rpc_id.as_u64() else { continue };
                if let Some(tx) = session.pending.lock().await.remove(&rpc_id) {
                    let reply = match message.get("error") {
                        Some(error) => Err(error["message"].as_str().unwrap_or("Gemini CLI error").to_owned()),
                        None => Ok(message["result"].clone()),
                    };
                    let _ = tx.send(reply);
                }
            }
            // Requête de Gemini CLI : seule l'autorisation est attendue (fs et terminal désactivés).
            (Some(method), Some(rpc_id)) => {
                if method == "session/request_permission" {
                    permission_request(&app, &id, &session, rpc_id.clone(), &message["params"]).await;
                } else {
                    let error = json!({ "code": -32601, "message": format!("{method} is not supported by FAST") });
                    let _ = session.write(&json!({ "jsonrpc": "2.0", "id": rpc_id, "error": error })).await;
                }
            }
            // `session/update` : seulement pendant un tour (sinon, relecture de l'historique).
            (Some(method), None) => {
                if method == "session/update" && session.prompting.load(Ordering::SeqCst) {
                    let mut tr = session.translation.lock().await;
                    for out in translate(&mut tr, &message["params"]["update"]) {
                        out.emit(&app, &id);
                    }
                }
            }
            _ => {}
        }
    }
    for (_, tx) in session.pending.lock().await.drain() {
        let _ = tx.send(Err("Gemini CLI stopped".into()));
    }
    let code = session.child.lock().await.wait().await.ok().and_then(|s| s.code());
    emit_exit(&app, &id, code);
}

async fn permission_request(app: &AppHandle, id: &str, session: &Session, rpc_id: Value, params: &Value) {
    let (tool, mut input) = tool_for(&params["toolCall"]);
    if let Some(input) = input.as_object_mut() {
        input.insert("description".into(), params["toolCall"]["title"].clone());
    }
    let options = params["options"].as_array().cloned().unwrap_or_default();
    let request_id = format!("gemini-{}", rpc_id.to_string().trim_matches('"'));
    session.approvals.lock().await.insert(request_id.clone(), (rpc_id, options));
    // Le texte en cours est terminé avant la demande.
    let mut tr = session.translation.lock().await;
    for out in tr.flush() {
        out.emit(app, id);
    }
    drop(tr);
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

#[cfg(test)]
mod tests {
    use super::{result_message, translate, Out, Translation};
    use serde_json::json;

    /// Un tour Gemini (messages au format ACP de Gemini CLI 0.65) → format Claude.
    #[test]
    fn translates_a_turn() {
        let mut tr = Translation { model: Some("gemini-2.5-pro".into()), ..Default::default() };
        let mut all = Vec::new();
        for update in [
            json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "**Plan**\nRead files" } }),
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "[MODE_UPDATE] autoEdit" } }),
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "I'll check " } }),
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "git." } }),
            json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "status": "in_progress", "title": "git --version", "kind": "execute", "content": [], "locations": [] }),
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed" }),
            json!({ "sessionUpdate": "tool_call", "toolCallId": "e1", "status": "pending", "title": "Create hello.txt", "kind": "edit", "locations": [{ "path": "D:/p/hello.txt" }] }),
            json!({ "sessionUpdate": "tool_call_update", "toolCallId": "e1", "status": "failed" }),
        ] {
            all.extend(translate(&mut tr, &update));
        }
        all.extend(tr.flush());
        all.push(result_message(
            &tr,
            Ok(json!({ "stopReason": "end_turn", "usage": { "inputTokens": 12000, "outputTokens": 300, "cachedReadTokens": 8000, "thoughtTokens": 50 } })),
        ));
        let m: Vec<_> = all.into_iter().map(|Out::Message(v)| v).collect();

        assert_eq!(m[0]["event"]["content_block"]["type"], "thinking");
        assert_eq!(m[1]["event"]["type"], "content_block_stop");
        assert_eq!(m[2]["event"]["delta"]["text"], "I'll check ");
        assert_eq!(m[4]["message"]["content"][0]["text"], "I'll check git.");
        assert_eq!(m[5]["message"]["content"][0]["name"], "Bash");
        assert_eq!(m[5]["message"]["content"][0]["input"]["command"], "git --version");
        assert_eq!(m[6]["message"]["content"][0]["is_error"], false);
        assert_eq!(m[7]["message"]["content"][0]["name"], "Write");
        assert_eq!(m[7]["message"]["content"][0]["input"]["file_path"], "D:/p/hello.txt");
        assert_eq!(m[8]["message"]["content"][0]["is_error"], true);
        let result = &m[9];
        assert_eq!(result["is_error"], false);
        assert_eq!(result["usage"]["input_tokens"], 4000);
        assert_eq!(result["usage"]["cache_read_input_tokens"], 8000);
        assert_eq!(result["usage"]["output_tokens"], 350);
        assert_eq!(m.len(), 10);
    }
}
