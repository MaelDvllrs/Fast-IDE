//! Serveur MCP de FAST : les outils du planificateur, proposés aux agents
//! (Claude Code, Codex, Gemini CLI) en « streamable HTTP » sur 127.0.0.1.
//!
//! Chaque agent a sa propre adresse (`/mcp/<jeton>`) : FAST sait ainsi quel
//! agent appelle, dans quel dossier lancer la commande, et à quel projet
//! s'appliquent les limites. Les réponses sont du JSON simple (pas de flux
//! SSE) : un appel d'outil reste ouvert le temps de la tâche.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

use super::{agent_for, commands, preview_logs, run_check, start_preview, status_text, stop_preview, Agent, Kind, SchedulerState};

/// Corps de requête accepté au plus.
const MAX_BODY: usize = 4 * 1024 * 1024;

/// Démarre le serveur (au lancement de l'app) sur un port libre de 127.0.0.1.
pub fn serve<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("FAST MCP server unavailable: {err}");
                return;
            }
        };
        if let Ok(addr) = listener.local_addr() {
            *app.state::<SchedulerState>().port.lock().unwrap() = Some(addr.port());
        }
        while let Ok((stream, _)) = listener.accept().await {
            tauri::async_runtime::spawn(connection(app.clone(), stream));
        }
    });
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

async fn read_request(reader: &mut BufReader<TcpStream>) -> Option<Request> {
    let mut line = String::new();
    if reader.read_line(&mut line).await.ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next()?.to_owned(), parts.next()?.to_owned());
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await.ok()? == 0 {
            return None;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok()?;
            }
        }
    }
    if length > MAX_BODY {
        return None;
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.ok()?;
    Some(Request { method, path, body })
}

async fn respond(stream: &mut BufReader<TcpStream>, status: &str, body: Option<&Value>) -> std::io::Result<()> {
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nMcp-Session-Id: fast\r\n\r\n",
        body.len()
    );
    let stream = stream.get_mut();
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.flush().await
}

async fn connection<R: Runtime>(app: AppHandle<R>, stream: TcpStream) {
    let mut stream = BufReader::new(stream);
    while let Some(request) = read_request(&mut stream).await {
        let agent = request.path.strip_prefix("/mcp/").and_then(|token| agent_for(&app, token.trim_end_matches('/')));
        let result = match (request.method.as_str(), agent) {
            (_, None) => respond(&mut stream, "404 Not Found", None).await,
            ("POST", Some(agent)) => match serde_json::from_slice::<Value>(&request.body) {
                Ok(message) => match handle(&app, &agent, &message).await {
                    Some(reply) => respond(&mut stream, "200 OK", Some(&reply)).await,
                    // Notification : rien à répondre.
                    None => respond(&mut stream, "202 Accepted", None).await,
                },
                Err(_) => respond(&mut stream, "400 Bad Request", None).await,
            },
            // Fin de session MCP : rien à libérer ici (c'est l'arrêt de l'agent qui compte).
            ("DELETE", Some(_)) => respond(&mut stream, "200 OK", None).await,
            // Pas de flux d'événements du serveur vers le client.
            _ => respond(&mut stream, "405 Method Not Allowed", None).await,
        };
        if result.is_err() {
            return;
        }
    }
}

/// Message JSON-RPC → réponse (`None` pour une notification).
async fn handle<R: Runtime>(app: &AppHandle<R>, agent: &Agent, message: &Value) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message["method"].as_str().unwrap_or_default();
    let params = &message["params"];
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fast", "title": "FAST", "version": env!("CARGO_PKG_VERSION") },
            "instructions": super::agent_instructions(app),
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => Ok(call(app, agent, params["name"].as_str().unwrap_or_default(), &params["arguments"]).await),
        _ => Err(json!({ "code": -32601, "message": format!("method not found: {method}") })),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

fn tools() -> Value {
    json!([
        {
            "name": "run_check",
            "title": "Run a check",
            "description": "Run the project's type check, lint, unit tests, integration tests, production build or E2E tests \
                in your working folder, through FAST's shared queue (limited per project so agents don't overload the machine). \
                Waits for a free slot, then returns the exit status and the end of the output.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["typecheck", "lint", "test", "integration_test", "build", "e2e"] },
                    "script": { "type": "string", "description": "package.json script to run instead of the detected command" },
                    "args": { "type": "string", "description": "Extra arguments: test files, filters, flags (no shell operators)" },
                    "final_check": { "type": "boolean", "description": "Quick verification before finishing your task (runs first)" },
                    "needs_server": { "type": "boolean", "description": "integration_test only: the tests need a running server" }
                },
                "required": ["kind"]
            }
        },
        {
            "name": "start_preview",
            "title": "Start the preview server",
            "description": "Start the project's dev server (Next.js, Vite…) in your working folder and return its local URL. \
                Servers are limited per project and shared by all agents: you may wait in a queue. \
                Stop it with stop_preview as soon as you are done.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "script": { "type": "string", "description": "package.json script to run instead of the detected dev command" },
                    "user_requested": { "type": "boolean", "description": "true only when the user explicitly asked to see a preview" }
                }
            }
        },
        {
            "name": "preview_logs",
            "title": "Preview server output",
            "description": "Status and latest output of your preview server.",
            "inputSchema": {
                "type": "object",
                "properties": { "max_chars": { "type": "integer", "description": "Characters of output to return (default 8000)" } }
            }
        },
        {
            "name": "stop_preview",
            "title": "Stop the preview server",
            "description": "Stop your preview server and all its processes, freeing the slot for other agents.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "scheduler_status",
            "title": "Scheduler status",
            "description": "What is running and queued in this project (checks, builds, servers) and the limits.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

fn text(text: impl Into<String>, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": is_error })
}

async fn call<R: Runtime>(app: &AppHandle<R>, agent: &Agent, name: &str, args: &Value) -> Value {
    let flag = |key: &str| args[key].as_bool().unwrap_or(false);
    let script = args["script"].as_str();
    let outcome = match name {
        "run_check" => {
            let kind = args["kind"].as_str().and_then(Kind::parse).filter(|k| *k != Kind::Preview);
            match kind {
                None => Err("`kind` must be one of typecheck, lint, test, integration_test, build, e2e".to_owned()),
                Some(kind) => match commands::resolve(kind, &agent.cwd, script, args["args"].as_str()) {
                    Ok(command) => run_check(app, agent, kind, command, flag("needs_server"), flag("final_check")).await.map_err(|e| e.to_string()),
                    Err(err) => Err(err.to_string()),
                },
            }
        }
        "start_preview" => match commands::resolve(Kind::Preview, &agent.cwd, script, None) {
            Ok(command) => start_preview(app, agent, command, flag("user_requested")).await.map_err(|e| e.to_string()),
            Err(err) => Err(err.to_string()),
        },
        "stop_preview" => Ok(stop_preview(app, &agent.session).await),
        "preview_logs" => Ok(preview_logs(app, &agent.session, args["max_chars"].as_u64().unwrap_or(8000).min(50_000) as usize)),
        "scheduler_status" => Ok(status_text(app, agent)),
        _ => Err(format!("unknown tool `{name}`")),
    };
    match outcome {
        Ok(message) => text(message, false),
        Err(message) => text(message, true),
    }
}

/// Délai d'appel d'outil donné aux clients MCP : l'attente dans la file plus la tâche.
pub const TOOL_TIMEOUT: Duration = Duration::from_secs(40 * 60);
