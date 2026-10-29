//! Planificateur des tâches lourdes des agents : vérifications (types, lint,
//! tests), builds, tests E2E et serveurs de preview.
//!
//! Sans lui, chaque agent lancerait son serveur de dev et ses builds en même
//! temps que les autres, et la machine ralentirait. Les agents passent donc par
//! les outils du serveur MCP de FAST (`mcp.rs`) : FAST lance lui-même chaque
//! commande dans le dossier de l'agent, au plus N à la fois par projet et par
//! type d'opération, et met les autres en file selon leur priorité :
//!
//! 1. preview demandée explicitement par l'utilisateur ;
//! 2. vérification rapide avant de terminer une tâche ;
//! 3. tests unitaires et vérifications statiques ;
//! 4. build complet, tests E2E (et preview lancée par l'agent pour lui-même).
//!
//! Par défaut, un seul serveur (preview ou E2E) par projet ; les limites se
//! règlent dans les préférences, jamais par les agents. À la fin d'une tâche,
//! tout son arbre de processus est arrêté (job Windows, groupe macOS) : un
//! serveur ne reste jamais en arrière-plan. Une preview lancée par l'agent pour
//! ses tests s'arrête au plus tard à la fin de son tour.
//!
//! Les mêmes opérations lancées directement dans le shell sont refusées
//! (`guard`), avec un message qui renvoie l'agent vers l'outil.
//! (Le bouton Run de l'utilisateur ne passe pas par ici.)

mod commands;
mod mcp;
pub mod push;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::Child,
    sync::oneshot,
};

pub use mcp::{serve, TOOL_TIMEOUT};

use crate::{
    error::{AppError, AppResult},
    platform::{self, ProcessTree},
    settings,
};

pub const EVENT: &str = "scheduler://event";

/// Attente maximale dans la file : au-delà, l'agent est invité à réessayer
/// (les clients MCP abandonnent un appel d'outil trop long).
const QUEUE_WAIT: Duration = Duration::from_secs(9 * 60);
/// Durée maximale d'une vérification ou d'un build.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Démarrage d'un serveur : attente de son adresse dans sa sortie.
const PREVIEW_STARTUP: Duration = Duration::from_secs(120);
/// Délai laissé aux programmes pour se fermer d'eux-mêmes avant l'arrêt forcé.
const GRACE: Duration = Duration::from_secs(4);
/// Sortie gardée par tâche (la fin).
const OUTPUT_KEEP: usize = 200_000;
/// Fin de sortie renvoyée à l'agent.
const OUTPUT_TAIL: usize = 8_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Typecheck,
    Lint,
    Test,
    IntegrationTest,
    E2e,
    Build,
    Preview,
}

impl Kind {
    /// Nom donné par un agent (`typecheck`, mais aussi `type_check`, `unit_tests`…).
    fn parse(value: &str) -> Option<Self> {
        let name: String = value.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        Some(match name.as_str() {
            "typecheck" | "types" | "tsc" => Kind::Typecheck,
            "lint" | "eslint" => Kind::Lint,
            "test" | "tests" | "unit" | "unittest" | "unittests" => Kind::Test,
            "integrationtest" | "integrationtests" | "integration" => Kind::IntegrationTest,
            "e2e" | "e2etest" | "e2etests" | "endtoend" => Kind::E2e,
            "build" => Kind::Build,
            "preview" => Kind::Preview,
            _ => return None,
        })
    }

    fn id(self) -> &'static str {
        match self {
            Kind::Typecheck => "typecheck",
            Kind::Lint => "lint",
            Kind::Test => "test",
            Kind::IntegrationTest => "integration_test",
            Kind::E2e => "e2e",
            Kind::Build => "build",
            Kind::Preview => "preview",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Kind::Typecheck => "type check",
            Kind::Lint => "lint",
            Kind::Test => "unit tests",
            Kind::IntegrationTest => "integration tests",
            Kind::E2e => "E2E tests",
            Kind::Build => "production build",
            Kind::Preview => "preview server",
        }
    }

    /// Poids d'une opération (pour reconnaître la plus lourde d'un enchaînement).
    fn weight(self) -> u8 {
        match self {
            Kind::Preview | Kind::E2e => 3,
            Kind::Build => 2,
            _ => 1,
        }
    }

    /// Occupe un des serveurs du projet (port, navigateur…).
    fn uses_server(self) -> bool {
        matches!(self, Kind::Preview | Kind::E2e)
    }
}

/// Nombre de tâches simultanées par projet, réglé dans les préférences.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Limits {
    /// Serveurs (preview, E2E, tests d'intégration qui en demandent un).
    pub servers: u32,
    pub typecheck: u32,
    pub lint: u32,
    pub test: u32,
    pub integration_test: u32,
    pub e2e: u32,
    pub build: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self { servers: 1, typecheck: 2, lint: 2, test: 2, integration_test: 1, e2e: 1, build: 1 }
    }
}

impl Limits {
    fn of(&self, kind: Kind) -> usize {
        let n = match kind {
            Kind::Typecheck => self.typecheck,
            Kind::Lint => self.lint,
            Kind::Test => self.test,
            Kind::IntegrationTest => self.integration_test,
            Kind::E2e => self.e2e,
            Kind::Build => self.build,
            Kind::Preview => self.servers,
        };
        n.max(1) as usize
    }
}

/// Priorité dans la file : 1 passe en premier.
fn priority(kind: Kind, user_requested: bool, final_check: bool) -> u8 {
    match kind {
        Kind::Preview if user_requested => 1,
        _ if final_check => 2,
        Kind::Typecheck | Kind::Lint | Kind::Test | Kind::IntegrationTest => 3,
        _ => 4,
    }
}

/// Agent connu du serveur MCP (une adresse par session).
#[derive(Clone)]
struct Agent {
    session: String,
    cwd: PathBuf,
    /// Projet : les limites s'appliquent à tous ses agents (worktrees compris).
    root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    Queued,
    Running,
}

struct Task {
    id: u64,
    agent: Agent,
    kind: Kind,
    /// Occupe un serveur du projet.
    server: bool,
    priority: u8,
    command: String,
    user_requested: bool,
    status: Status,
    /// Ordre d'arrivée, à priorité égale.
    seq: u64,
    since: u64,
    url: Option<String>,
    output: Arc<Mutex<String>>,
    /// En file : prévient la tâche que son tour est venu.
    go: Option<oneshot::Sender<()>>,
    /// En cours : demande l'arrêt du processus.
    stop: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    tasks: Vec<Task>,
}

#[derive(Default)]
pub struct SchedulerState {
    inner: Mutex<Inner>,
    /// Adresse MCP (jeton) → agent.
    agents: Mutex<HashMap<String, Agent>>,
    port: Mutex<Option<u16>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskView {
    id: u64,
    root: PathBuf,
    session_id: String,
    kind: Kind,
    status: Status,
    priority: u8,
    command: String,
    user_requested: bool,
    since: u64,
    url: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

fn limits<R: Runtime>(app: &AppHandle<R>) -> Limits {
    settings::load(app).scheduler.unwrap_or_default()
}

fn snapshot(inner: &Inner) -> Vec<TaskView> {
    let mut tasks: Vec<&Task> = inner.tasks.iter().collect();
    tasks.sort_by_key(|t| (t.status == Status::Queued, t.priority, t.seq));
    tasks
        .into_iter()
        .map(|t| TaskView {
            id: t.id,
            root: t.agent.root.clone(),
            session_id: t.agent.session.clone(),
            kind: t.kind,
            status: t.status,
            priority: t.priority,
            command: t.command.clone(),
            user_requested: t.user_requested,
            since: t.since,
            url: t.url.clone(),
        })
        .collect()
}

fn emit<R: Runtime>(app: &AppHandle<R>, inner: &Inner) {
    let _ = app.emit(EVENT, snapshot(inner));
}

/// Démarre les tâches en file qui ont une place, par priorité puis par ordre d'arrivée.
fn dispatch(inner: &mut Inner, limits: &Limits) {
    let mut order: Vec<usize> = (0..inner.tasks.len()).filter(|&i| inner.tasks[i].status == Status::Queued).collect();
    order.sort_by_key(|&i| (inner.tasks[i].priority, inner.tasks[i].seq));
    for i in order {
        let task = &inner.tasks[i];
        let running = |pred: &dyn Fn(&Task) -> bool| {
            inner.tasks.iter().filter(|t| t.status == Status::Running && t.agent.root == task.agent.root && pred(t)).count()
        };
        let fits = running(&|t| t.kind == task.kind) < limits.of(task.kind)
            && (!task.server || running(&|t| t.server) < limits.servers.max(1) as usize);
        if fits {
            let task = &mut inner.tasks[i];
            task.status = Status::Running;
            task.since = now_ms();
            if let Some(go) = task.go.take() {
                let _ = go.send(());
            }
        }
    }
}

fn state<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, SchedulerState> {
    app.state::<SchedulerState>()
}

/// Place une tâche dans la file et attend son tour. Rend son identifiant, le
/// signal d'arrêt et sa sortie.
async fn acquire<R: Runtime>(
    app: &AppHandle<R>,
    agent: &Agent,
    kind: Kind,
    server: bool,
    priority: u8,
    command: &str,
    user_requested: bool,
) -> AppResult<(u64, oneshot::Receiver<()>, Arc<Mutex<String>>)> {
    let limits = limits(app);
    let (go_tx, go_rx) = oneshot::channel();
    let (stop_tx, stop_rx) = oneshot::channel();
    let output = Arc::new(Mutex::new(String::new()));
    let id = {
        let state = state(app);
        let mut inner = state.inner.lock().unwrap();
        inner.next_id += 1;
        let id = inner.next_id;
        inner.tasks.push(Task {
            id,
            agent: agent.clone(),
            kind,
            server,
            priority,
            command: command.to_owned(),
            user_requested,
            status: Status::Queued,
            seq: id,
            since: now_ms(),
            url: None,
            output: output.clone(),
            go: Some(go_tx),
            stop: Some(stop_tx),
        });
        dispatch(&mut inner, &limits);
        emit(app, &inner);
        id
    };
    match tokio::time::timeout(QUEUE_WAIT, go_rx).await {
        Ok(Ok(())) => Ok((id, stop_rx, output)),
        // Retirée de la file (agent arrêté, fin de son tour).
        Ok(Err(_)) => Err(AppError::msg("cancelled: the agent's turn ended")),
        Err(_) => {
            finish(app, id);
            Err(AppError::msg(format!(
                "still waiting for a free {} slot: other agents are using it. Do something else, then call the tool again.",
                kind.label()
            )))
        }
    }
}

/// Fin d'une tâche : sa place revient aux suivantes.
fn finish<R: Runtime>(app: &AppHandle<R>, id: u64) {
    let limits = limits(app);
    let state = state(app);
    let mut inner = state.inner.lock().unwrap();
    inner.tasks.retain(|t| t.id != id);
    dispatch(&mut inner, &limits);
    emit(app, &inner);
}

/// Annule les tâches qui répondent à `pred` : retirées de la file, ou arrêtées.
fn cancel<R: Runtime>(app: &AppHandle<R>, pred: impl Fn(&Task) -> bool) {
    let limits = limits(app);
    let state = state(app);
    let mut inner = state.inner.lock().unwrap();
    for task in inner.tasks.iter_mut().filter(|t| pred(t)) {
        if task.status == Status::Running {
            if let Some(stop) = task.stop.take() {
                let _ = stop.send(());
            }
        }
    }
    // En file : retirées tout de suite (leur attente se termine en erreur).
    inner.tasks.retain(|t| !(t.status == Status::Queued && pred(t)));
    dispatch(&mut inner, &limits);
    emit(app, &inner);
}

/// Lance une ligne de shell dans le dossier de l'agent, sortie recueillie dans `output`.
fn spawn(command: &str, cwd: &Path, check: bool, output: &Arc<Mutex<String>>) -> AppResult<(Child, Option<ProcessTree>)> {
    let mut cmd = platform::shell_command(command);
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Sortie lisible (sans couleurs) ; pas de navigateur ouvert par les serveurs de dev.
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1")
        .env("BROWSER", "none")
        .kill_on_drop(true);
    if check {
        // Tests en une passe (Vitest, Jest…), pas en mode watch.
        cmd.env("CI", "1");
    }
    platform::configure_command(&mut cmd);
    platform::own_process_tree(&mut cmd);
    let mut child = cmd.spawn()?;
    let tree = ProcessTree::attach(&child);
    if let Some(out) = child.stdout.take() {
        tauri::async_runtime::spawn(collect(out, output.clone()));
    }
    if let Some(err) = child.stderr.take() {
        tauri::async_runtime::spawn(collect(err, output.clone()));
    }
    Ok((child, tree))
}

async fn collect(reader: impl AsyncRead + Unpin, output: Arc<Mutex<String>>) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut out = output.lock().unwrap();
        out.push_str(&strip_ansi(&line));
        out.push('\n');
        if out.len() > OUTPUT_KEEP {
            let cut = out.len() - OUTPUT_KEEP / 2;
            let cut = (cut..out.len()).find(|&i| out.is_char_boundary(i)).unwrap_or(0);
            out.drain(..cut);
        }
    }
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // Séquence CSI : jusqu'à la lettre finale.
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

fn tail(output: &Mutex<String>, max: usize) -> String {
    let out = output.lock().unwrap();
    let start = out.len().saturating_sub(max);
    let start = (start..out.len()).find(|&i| out.is_char_boundary(i)).unwrap_or(0);
    out[start..].trim().to_owned()
}

/// Arrête proprement tout l'arbre de processus : demande de fermeture, puis
/// arrêt forcé de ce qui reste (descendants compris).
async fn shut_down(child: &mut Child, tree: Option<&ProcessTree>) {
    if let Some(tree) = tree {
        tree.stop(false);
        let _ = tokio::time::timeout(GRACE, child.wait()).await;
        tree.stop(true);
    } else {
        let _ = child.start_kill();
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}

/// Adresse locale annoncée par un serveur de dev (« http://localhost:3000 »).
fn find_url(output: &str) -> Option<String> {
    for prefix in ["http://localhost:", "http://127.0.0.1:", "http://0.0.0.0:", "http://[::1]:"] {
        if let Some(start) = output.find(prefix) {
            let rest = &output[start..];
            let end = rest.find(|c: char| c.is_whitespace() || c == ')' || c == '"' || c == '\'').unwrap_or(rest.len());
            return Some(rest[..end].trim_end_matches(['/', '.', ',']).replace("0.0.0.0", "localhost"));
        }
    }
    None
}

/// Une vérification ou un build : attend sa place, s'exécute, rend la sortie.
async fn run_check<R: Runtime>(
    app: &AppHandle<R>,
    agent: &Agent,
    kind: Kind,
    command: String,
    needs_server: bool,
    final_check: bool,
) -> AppResult<String> {
    let server = kind.uses_server() || needs_server;
    let (id, mut stop, output) = acquire(app, agent, kind, server, priority(kind, false, final_check), &command, false).await?;
    let started = Instant::now();
    let (mut child, tree) = match spawn(&command, &agent.cwd, true, &output) {
        Ok(spawned) => spawned,
        Err(err) => {
            finish(app, id);
            return Err(err);
        }
    };
    let outcome = tokio::select! {
        status = child.wait() => Some(status.ok().and_then(|s| s.code())),
        _ = &mut stop => None,
        _ = tokio::time::sleep(CHECK_TIMEOUT) => Some(None),
    };
    // Fin normale comprise : ce que la tâche aurait laissé tourner est arrêté aussi.
    shut_down(&mut child, tree.as_ref()).await;
    finish(app, id);

    let seconds = started.elapsed().as_secs_f32();
    let out = tail(&output, OUTPUT_TAIL);
    let head = match outcome {
        None => return Err(AppError::msg(format!("{} stopped: the agent's turn ended", kind.label()))),
        Some(Some(0)) => format!("{} passed (`{command}`, {seconds:.1}s)", capitalize(kind.label())),
        Some(Some(code)) => format!("{} FAILED with exit code {code} (`{command}`, {seconds:.1}s)", capitalize(kind.label())),
        Some(None) if started.elapsed() >= CHECK_TIMEOUT => format!("{} timed out after {} minutes (`{command}`)", capitalize(kind.label()), CHECK_TIMEOUT.as_secs() / 60),
        Some(None) => format!("{} ended without an exit code (`{command}`)", capitalize(kind.label())),
    };
    Ok(if out.is_empty() { head } else { format!("{head}\n\nOutput (end):\n{out}") })
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// Serveur de preview de l'agent : attend sa place, démarre, rend son adresse.
/// Il tourne jusqu'à `stop_preview`, à la fin du tour (sauf preview demandée par
/// l'utilisateur) ou à l'arrêt de l'agent.
async fn start_preview<R: Runtime>(app: &AppHandle<R>, agent: &Agent, command: String, user_requested: bool) -> AppResult<String> {
    // Une preview à la fois par agent : la sienne est réutilisée.
    let existing = {
        let state = state(app);
        let inner = state.inner.lock().unwrap();
        inner
            .tasks
            .iter()
            .find(|t| t.agent.session == agent.session && t.kind == Kind::Preview && t.status == Status::Running)
            .map(|t| (t.url.clone(), t.command.clone()))
    };
    if let Some((url, running)) = existing {
        return Ok(match url {
            Some(url) => format!("Your preview is already running at {url} (`{running}`)."),
            None => format!("Your preview (`{running}`) is already starting; call preview_logs to follow it."),
        });
    }

    let (id, mut stop, output) =
        acquire(app, agent, Kind::Preview, true, priority(Kind::Preview, user_requested, false), &command, user_requested).await?;
    let (mut child, tree) = match spawn(&command, &agent.cwd, false, &output) {
        Ok(spawned) => spawned,
        Err(err) => {
            finish(app, id);
            return Err(err);
        }
    };

    // Le processus est suivi jusqu'à sa fin ; `exited` prévient le démarrage s'il s'arrête tout de suite.
    let (exited_tx, mut exited) = oneshot::channel::<Option<i32>>();
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = &mut stop => None,
        };
        shut_down(&mut child, tree.as_ref()).await;
        finish(&app_handle, id);
        let _ = exited_tx.send(code);
    });

    let deadline = Instant::now() + PREVIEW_STARTUP;
    loop {
        if let Some(url) = find_url(&output.lock().unwrap()) {
            {
                let state = state(app);
                let mut inner = state.inner.lock().unwrap();
                if let Some(task) = inner.tasks.iter_mut().find(|t| t.id == id) {
                    task.url = Some(url.clone());
                }
                emit(app, &inner);
            }
            return Ok(format!(
                "Preview server running at {url} (`{command}`).\nCall stop_preview as soon as you no longer need it; it is stopped anyway at the end of your turn{}.",
                if user_requested { " unless the user asked for it" } else { "" }
            ));
        }
        if let Ok(code) = exited.try_recv() {
            let code = code.map(|c| c.to_string()).unwrap_or_else(|| "none".into());
            return Err(AppError::msg(format!(
                "the preview server (`{command}`) stopped (exit code {code}).\n\nOutput (end):\n{}",
                tail(&output, OUTPUT_TAIL)
            )));
        }
        if Instant::now() >= deadline {
            return Ok(format!(
                "Preview server started (`{command}`) but no local address was found in its output yet.\n\nOutput (end):\n{}",
                tail(&output, OUTPUT_TAIL)
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Arrête la preview de l'agent et attend que ses processus soient terminés.
async fn stop_preview<R: Runtime>(app: &AppHandle<R>, session: &str) -> String {
    let is_preview = |t: &Task| t.agent.session == session && t.kind == Kind::Preview;
    let count = state(app).inner.lock().unwrap().tasks.iter().filter(|t| is_preview(t)).count();
    if count == 0 {
        return "No preview server is running for you.".into();
    }
    cancel(app, is_preview);
    let deadline = Instant::now() + GRACE + Duration::from_secs(8);
    while Instant::now() < deadline && state(app).inner.lock().unwrap().tasks.iter().any(|t| is_preview(t)) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    "Preview server stopped.".into()
}

fn preview_logs<R: Runtime>(app: &AppHandle<R>, session: &str, max: usize) -> String {
    let state = state(app);
    let inner = state.inner.lock().unwrap();
    match inner.tasks.iter().find(|t| t.agent.session == session && t.kind == Kind::Preview) {
        Some(task) => {
            let status = match (&task.url, task.status) {
                (_, Status::Queued) => "waiting for a free server slot".to_owned(),
                (Some(url), _) => format!("running at {url}"),
                (None, _) => "starting".to_owned(),
            };
            format!("Preview (`{}`) {status}.\n\nOutput (end):\n{}", task.command, tail(&task.output, max))
        }
        None => "No preview server is running for you.".into(),
    }
}

/// État du projet de l'agent, pour qu'il sache ce qui tourne et ce qui attend.
fn status_text<R: Runtime>(app: &AppHandle<R>, agent: &Agent) -> String {
    let limits = limits(app);
    let state = state(app);
    let inner = state.inner.lock().unwrap();
    let mut lines = vec![format!(
        "Limits for this project: {} server(s), type check {}, lint {}, unit tests {}, integration tests {}, E2E {}, build {}.",
        limits.servers, limits.typecheck, limits.lint, limits.test, limits.integration_test, limits.e2e, limits.build
    )];
    for task in snapshot(&inner).into_iter().filter(|t| t.root == agent.root) {
        let whose = if task.session_id == agent.session { "yours" } else { "another agent" };
        let status = if task.status == Status::Running { "running" } else { "queued" };
        lines.push(format!("- {} {status} ({whose}): `{}`", Kind::label(task.kind), task.command));
    }
    if lines.len() == 1 {
        lines.push("Nothing is running.".into());
    }
    lines.join("\n")
}

// --- Agents ------------------------------------------------------------------

/// Projet d'un dossier d'agent : `<projet>/.fast/worktrees/agent-N` → `<projet>`.
fn project_root(cwd: &Path) -> PathBuf {
    let parts: Vec<_> = cwd.components().collect();
    match parts.iter().rposition(|c| c.as_os_str() == ".fast") {
        Some(i) if i > 0 => parts[..i].iter().collect(),
        _ => cwd.to_path_buf(),
    }
}

/// Jeton imprévisible pour l'adresse MCP d'un agent.
fn token() -> String {
    use std::hash::{BuildHasher, RandomState};
    let seed = (now_ms(), std::process::id(), Instant::now());
    format!("{:016x}{:016x}", RandomState::new().hash_one(seed), RandomState::new().hash_one(seed))
}

/// Adresse du serveur MCP de FAST pour la session `session` (dossier `cwd`).
/// `None` si le serveur n'a pas pu démarrer : l'agent travaille alors sans.
pub fn register<R: Runtime>(app: &AppHandle<R>, session: &str, cwd: &Path) -> Option<String> {
    let state = state(app);
    let port = (*state.port.lock().unwrap())?;
    let token = token();
    let agent = Agent { session: session.to_owned(), cwd: cwd.to_path_buf(), root: project_root(cwd) };
    let mut agents = state.agents.lock().unwrap();
    agents.retain(|_, a| a.session != session);
    agents.insert(token.clone(), agent);
    Some(format!("http://127.0.0.1:{port}/mcp/{token}"))
}

fn agent_for<R: Runtime>(app: &AppHandle<R>, token: &str) -> Option<Agent> {
    state(app).agents.lock().unwrap().get(token).cloned()
}

/// Fin du tour d'un agent : ses tâches s'arrêtent, sauf une preview demandée
/// par l'utilisateur (il la regarde encore).
pub fn turn_ended<R: Runtime>(app: &AppHandle<R>, session: &str) {
    cancel(app, |t| t.agent.session == session && !(t.kind == Kind::Preview && t.user_requested));
    push::deny_session(session);
}

/// Session arrêtée : toutes ses tâches s'arrêtent et son adresse MCP est retirée.
pub fn session_ended<R: Runtime>(app: &AppHandle<R>, session: &str) {
    state(app).agents.lock().unwrap().retain(|_, a| a.session != session);
    cancel(app, |t| t.agent.session == session);
    push::deny_session(session);
}

/// Fermeture de l'app : tout s'arrête, sans attendre.
pub fn stop_all<R: Runtime>(app: &AppHandle<R>) {
    cancel(app, |_| true);
}

/// Instructions données à chaque agent (ajoutées à son prompt système).
pub fn agent_instructions<R: Runtime>(app: &AppHandle<R>) -> String {
    let servers = limits(app).servers;
    format!(
        "FAST, the IDE you run in, schedules heavy work for all its agents so the machine stays responsive. \
         Use the tools of the `fast` MCP server for it:\n\
         - run_check(kind): type check, lint, unit tests, integration tests, production build or E2E tests. \
         FAST finds the project's command (or pass `script`, a package.json script, and `args`), runs it, and returns its output. \
         Pass final_check=true for the quick verification before you finish a task.\n\
         - start_preview / preview_logs / stop_preview: the dev server. At most {servers} server(s) run per project, shared by all agents: \
         call stop_preview as soon as you are done with it. Pass user_requested=true only when the user explicitly asked for a preview.\n\
         Never run these through the shell (`npm run dev`, `next dev`, `vite`, `tsc`, `eslint`, `vitest`, `jest`, `playwright test`, \
         `npm run build`, `next build`, `cargo test`…): such commands are refused. If a tool reports that you are queued, \
         do something else and call it again later."
    )
}

// --- Commandes de shell des agents ------------------------------------------

/// Outils du serveur MCP de FAST (noms nus, sans préfixe de serveur).
const TOOLS: &[&str] = &["run_check", "start_preview", "stop_preview", "preview_logs", "scheduler_status"];

/// Demande d'autorisation d'un agent : un outil de FAST est autorisé d'office, une
/// opération planifiée lancée dans le shell est refusée avec la marche à suivre.
/// Rend la réponse à donner (`Some`), ou `None` pour laisser décider l'utilisateur.
pub fn guard<R: Runtime>(app: &AppHandle<R>, session: &str, tool: &str, input: &Value) -> Option<(bool, Option<String>)> {
    decide(tool, input, || {
        let root = state(app).agents.lock().unwrap().values().find(|a| a.session == session).map(|a| a.root.clone());
        root.is_some_and(|r| push::guarded(&r))
    })
}

/// Décision de [`guard`] ; `push_guarded` : le hook pre-push protège le projet de l'agent.
fn decide(tool: &str, input: &Value, push_guarded: impl FnOnce() -> bool) -> Option<(bool, Option<String>)> {
    let bare = tool.rsplit("__").next().unwrap_or(tool);
    if TOOLS.iter().any(|t| *t == bare || tool.starts_with(&format!("{t} ")) || tool.starts_with(&format!("{t}("))) {
        return Some((true, None));
    }
    if !matches!(tool, "Bash" | "PowerShell") {
        return None;
    }
    let command = input["command"].as_str()?;
    // `git push` seul : c'est le hook pre-push qui demande l'accord (une seule question).
    if push::is_plain_push(command) {
        return push_guarded().then_some((true, None));
    }
    let kind = commands::classify(command)?;
    let how = match kind {
        Kind::Preview => "call the `start_preview` tool of the `fast` MCP server (and `stop_preview` when you are done)".to_owned(),
        kind => format!("call the `run_check` tool of the `fast` MCP server with kind=\"{}\"", kind.id()),
    };
    Some((false, Some(format!("FAST runs the {} of all agents through a shared queue: {how} instead of the shell.", kind.label()))))
}

// --- Commandes de l'interface -----------------------------------------------

#[tauri::command]
pub fn scheduler_tasks(app: AppHandle) -> Vec<serde_json::Value> {
    let state = state(&app);
    let inner = state.inner.lock().unwrap();
    snapshot(&inner).into_iter().filter_map(|t| serde_json::to_value(t).ok()).collect()
}

/// Arrêt d'une tâche par l'utilisateur (panneau des tâches).
#[tauri::command]
pub fn scheduler_stop(app: AppHandle, task_id: u64) {
    cancel(&app, |t| t.id == task_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: u64, root: &str, kind: Kind, priority: u8, status: Status) -> Task {
        Task {
            id,
            agent: Agent { session: format!("s{id}"), cwd: root.into(), root: root.into() },
            kind,
            server: kind.uses_server(),
            priority,
            command: String::new(),
            user_requested: false,
            status,
            seq: id,
            since: 0,
            url: None,
            output: Default::default(),
            go: None,
            stop: None,
        }
    }

    #[test]
    fn dispatches_by_priority_within_limits() {
        let limits = Limits::default();
        let mut inner = Inner::default();
        inner.tasks.push(task(1, "/p", Kind::Preview, 4, Status::Running));
        inner.tasks.push(task(2, "/p", Kind::E2e, 4, Status::Queued));
        inner.tasks.push(task(3, "/p", Kind::Preview, 1, Status::Queued));
        inner.tasks.push(task(4, "/p", Kind::Typecheck, 3, Status::Queued));
        inner.tasks.push(task(5, "/p", Kind::Typecheck, 3, Status::Queued));
        inner.tasks.push(task(6, "/p", Kind::Typecheck, 2, Status::Queued));
        inner.tasks.push(task(7, "/other", Kind::Preview, 4, Status::Queued));
        dispatch(&mut inner, &limits);
        let status = |id: u64| inner.tasks.iter().find(|t| t.id == id).unwrap().status;
        // Un seul serveur par projet : E2E et la seconde preview attendent.
        assert!(status(2) == Status::Queued && status(3) == Status::Queued);
        // Deux vérifications de types : la finale (priorité 2) d'abord, puis la plus ancienne.
        assert!(status(6) == Status::Running && status(4) == Status::Running && status(5) == Status::Queued);
        // Autre projet : ses propres limites.
        assert!(status(7) == Status::Running);

        // Le serveur se libère : la preview demandée par l'utilisateur passe avant l'E2E.
        inner.tasks.retain(|t| t.id != 1);
        dispatch(&mut inner, &limits);
        let status = |id: u64| inner.tasks.iter().find(|t| t.id == id).unwrap().status;
        assert!(status(3) == Status::Running && status(2) == Status::Queued);
    }

    #[test]
    fn guards_agent_commands() {
        let guard = |tool: &str, input: &Value| decide(tool, input, || true);
        assert_eq!(guard("mcp__fast__run_check", &Value::Null), Some((true, None)));
        assert_eq!(guard("Bash", &serde_json::json!({ "command": "git status" })), None);
        // `git push` : autorisé ici, c'est le hook qui demande l'accord ; sans hook, l'utilisateur décide.
        assert_eq!(guard("Bash", &serde_json::json!({ "command": "git push origin main" })), Some((true, None)));
        assert_eq!(decide("Bash", &serde_json::json!({ "command": "git push" }), || false), None);
        let (allow, message) = guard("Bash", &serde_json::json!({ "command": "npm run dev" })).unwrap();
        assert!(!allow && message.unwrap().contains("start_preview"));
        assert_eq!(guard("Read", &serde_json::json!({})), None);
        assert_eq!(Kind::parse("type_check"), Some(Kind::Typecheck));
        assert_eq!(Kind::parse("unit-tests"), Some(Kind::Test));
    }

    #[test]
    fn finds_urls_and_project_roots() {
        assert_eq!(find_url("  ▲ Next.js 15\n  - Local:   http://localhost:3000\n").as_deref(), Some("http://localhost:3000"));
        assert_eq!(find_url("VITE ready\n➜  Local:   http://127.0.0.1:5173/\n").as_deref(), Some("http://127.0.0.1:5173"));
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m\r"), "ok");
        let root = Path::new("D:/p/app");
        assert_eq!(project_root(&root.join(".fast").join("worktrees").join("agent-2")), root);
        assert_eq!(project_root(root), root);
    }
}


/// Sonde de développement : `FAST_PROBE_DIR=<projet> FAST_PROBE_OUT=<fichier> cargo run`
/// lance l'app sans fenêtre, inscrit un agent de test sur ce projet et écrit son
/// adresse MCP dans le fichier, pour y brancher Claude Code ou Codex à la main.
/// Les changements de la file sont affichés sur la sortie standard.
#[cfg(debug_assertions)]
pub fn debug_probe<R: Runtime>(app: AppHandle<R>) {
    let (Some(dir), Some(out)) = (std::env::var_os("FAST_PROBE_DIR"), std::env::var_os("FAST_PROBE_OUT")) else { return };
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    tauri::async_runtime::spawn(async move {
        let url = loop {
            if let Some(url) = register(&app, "probe-session", Path::new(&dir)) {
                break url;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let _ = std::fs::write(&out, &url);
        println!("MCP {url}");
        let mut last = String::new();
        loop {
            let now = serde_json::to_string(&snapshot(&state(&app).inner.lock().unwrap())).unwrap_or_default();
            if now != last {
                println!("TASKS {now}");
                last = now;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
}
