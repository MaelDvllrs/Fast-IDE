//! Orchestrateur : ramène le travail des agents sur la branche principale.
//!
//! Les agents travaillent en parallèle, chacun dans son worktree. À la fin
//! d'une tâche, son travail est committé tout de suite dans son worktree, puis
//! la tâche entre dans une file. Une seule boucle traite la file, par lots :
//!
//! 1. le worktree d'intégration `.fast/integration` repart de la branche principale ;
//! 2. chaque branche du lot y est fusionnée (Claude résout les conflits ; un
//!    agent dont le conflit ne se résout pas est écarté) ;
//! 3. un seul build pour tout le lot, dans ce worktree au cache chaud ;
//! 4. build réussi : la branche principale avance en fast-forward ;
//!    build cassé : lot de plusieurs tâches → reprise une par une pour isoler
//!    la fautive ; tâche seule → Claude corrige, nouvel essai ;
//! 5. les agents inactifs sont mis à jour sur la nouvelle branche principale.
//!
//! Tous les agents, Prime compris, ont leur worktree : seule cette boucle modifie
//! la branche principale, et personne n'attend personne. Prime (l'agent principal)
//! reste prioritaire : sa tâche est fusionnée la première du lot, donc en cas de
//! conflit ce sont les autres qui s'adaptent à son travail.
//!
//! (Sans git, les agents partagent le dossier du projet : l'attente de l'agent
//! qui y travaille, plus bas, ne sert plus que dans ce cas.)
//!
//! Le pipeline est du code Rust déterministe ; Claude n'intervient que sur un
//! conflit ou un build cassé. Chaque étape est envoyée à l'interface
//! (`orchestrator://event`), dans la conversation de l'agent concerné.

use std::{path::Path, sync::atomic::Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::{build, busy_root_agent, ensure_integration, entry, git, idle_isolated, set_committing, AgentEntry, WorkspaceState};
use crate::{
    claude,
    error::{AppError, AppResult},
};

pub const EVENT: &str = "orchestrator://event";

const INTEGRATION_BRANCH: &str = "fast/integration";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    Running,
    Done,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepEvent {
    agent_id: String,
    /// Une tâche ; avec `stage`, identifie une étape dans la conversation.
    run_id: String,
    stage: &'static str,
    status: Status,
    label: String,
    /// Détail en cas d'erreur (sortie du build, message git…).
    detail: Option<String>,
}

/// Tâche terminée, en attente d'intégration.
#[derive(Clone)]
pub struct Task {
    agent_id: String,
    run_id: String,
    agent: AgentEntry,
    summary: Option<String>,
}

fn report(app: &AppHandle, task: &Task, stage: &'static str, status: Status, label: impl Into<String>, detail: Option<String>) {
    let event = StepEvent {
        agent_id: task.agent_id.clone(),
        run_id: task.run_id.clone(),
        stage,
        status,
        label: label.into(),
        detail,
    };
    if let Err(err) = app.emit(EVENT, event) {
        eprintln!("failed to emit orchestrator event: {err}");
    }
}

/// Même étape pour toutes les tâches d'un lot.
fn report_all(app: &AppHandle, tasks: &[Task], stage: &'static str, status: Status, label: &str, detail: Option<&str>) {
    for task in tasks {
        report(app, task, stage, status, label, detail.map(str::to_owned));
    }
}

/// Fin d'une tâche d'agent : commit immédiat (agent isolé), puis mise en file.
pub fn task_finished(app: AppHandle, agent_id: String, summary: Option<String>) {
    // Marqué tout de suite (avant que l'interface ne repasse l'agent en inactif) :
    // l'orchestrateur ne touche pas la branche principale avant le commit de l'agent du projet.
    set_committing(&app.state::<WorkspaceState>(), &agent_id, true);
    tauri::async_runtime::spawn(async move {
        let state = app.state::<WorkspaceState>();
        let Some(agent) = entry(&state, &agent_id) else {
            set_committing(&state, &agent_id, false);
            return;
        };
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
        let task = Task { run_id: format!("{agent_id}-{stamp}"), agent_id, agent, summary };

        // Commit immédiat, sans attendre la file. Pour l'agent du dossier projet, le
        // verrou garantit que l'orchestrateur ne met pas la branche principale à jour en même temps.
        let committed = if task.agent.branch.is_none() {
            let _root = state.root_lock.lock().await;
            commit(&app, &task).await
        } else {
            commit(&app, &task).await
        };
        set_committing(&state, &task.agent_id, false);
        match committed {
            Ok(true) => {}
            Ok(false) => return,
            Err(err) => {
                report(&app, &task, "commit", Status::Error, "Could not commit", Some(err.to_string()));
                return;
            }
        }

        report(&app, &task, "queue", Status::Running, "Waiting to integrate", None);
        state.queue.lock().unwrap().push(task);
        // Une seule boucle à la fois ; celle en cours prendra cette tâche au tour suivant.
        if !state.processing.swap(true, Ordering::SeqCst) {
            process_queue(&app, &state).await;
        }
    });
}

/// Commit du travail de l'agent. `false` = rien à committer (déjà signalé).
async fn commit(app: &AppHandle, task: &Task) -> AppResult<bool> {
    report(app, task, "commit", Status::Running, "Committing changes", None);
    let changed = git::commit_all(&task.agent.cwd, &commit_message(&task.agent.name, task.summary.as_deref())).await?;
    report(app, task, "commit", Status::Done, if changed { "Committed changes" } else { "No changes to commit" }, None);
    Ok(changed)
}

async fn process_queue(app: &AppHandle, state: &WorkspaceState) {
    loop {
        let batch: Vec<Task> = std::mem::take(&mut *state.queue.lock().unwrap());
        if batch.is_empty() {
            state.processing.store(false, Ordering::SeqCst);
            // Une tâche a pu arriver entre la file vide et le drapeau baissé.
            if state.queue.lock().unwrap().is_empty() || state.processing.swap(true, Ordering::SeqCst) {
                return;
            }
            continue;
        }
        let Some(root) = batch.first().map(|t| t.agent.root.clone()) else { continue };
        if let Err(err) = integrate_batch(app, state, &root, batch.clone()).await {
            report_all(app, &batch, "integrate", Status::Error, "Integration stopped", Some(&err.to_string()));
        }
    }
}

async fn integrate_batch(app: &AppHandle, state: &WorkspaceState, root: &Path, batch: Vec<Task>) -> AppResult<()> {
    // Tout est déjà committé (l'agent du dossier projet l'est sur la branche principale).
    // Prime d'abord (puis l'ordre de création) : son travail est intégré avant celui des autres.
    let mut tasks = batch;
    tasks.sort_by_key(|t| t.agent.index);
    for task in &tasks {
        report(app, task, "queue", Status::Done, "Integration started", None);
    }

    let main = git::current_branch(root).await?;
    let integration = ensure_integration(root).await?;

    if !try_integrate(app, state, root, &integration, &main, &tasks, tasks.len() == 1).await? && tasks.len() > 1 {
        // Le lot ne build pas : chaque tâche seule, pour isoler la fautive.
        for task in &tasks {
            try_integrate(app, state, root, &integration, &main, std::slice::from_ref(task), true).await?;
        }
    }

    // Les agents inactifs repartent du code à jour (fast-forward seulement : sans risque).
    for peer in idle_isolated(state, root) {
        let _ = git::run(&peer.cwd, &["merge", "--ff-only", &main]).await;
    }
    Ok(())
}

/// Fusionne `tasks` dans le worktree d'intégration, build, puis avance la
/// branche principale. `final_try` : dernier essai pour ces tâches (Claude
/// corrige un build cassé, l'échec est signalé). Rend `true` si c'est intégré.
async fn try_integrate(
    app: &AppHandle,
    state: &WorkspaceState,
    root: &Path,
    integration: &Path,
    main: &str,
    tasks: &[Task],
    final_try: bool,
) -> AppResult<bool> {
    // Repart de la branche principale ; jamais de `git clean` (il pourrait entrer
    // dans le lien vers node_modules et vider le dossier du projet).
    git::ensure(integration, &["reset", "--hard", main]).await?;

    let mut merged: Vec<&Task> = Vec::new();
    for task in tasks {
        let Some(branch) = &task.agent.branch else {
            merged.push(task); // déjà sur la branche principale
            continue;
        };
        report(app, task, "sync", Status::Running, format!("Merging with {main}"), None);
        match merge_branch(integration, branch, main).await {
            Ok(()) => {
                report(app, task, "sync", Status::Done, format!("Merged with {main}"), None);
                merged.push(task);
            }
            Err(err) => report(app, task, "sync", Status::Error, format!("Could not merge with {main}"), Some(err.to_string())),
        }
    }
    if merged.is_empty() {
        return Ok(true);
    }
    let merged: Vec<Task> = merged.into_iter().cloned().collect();

    if !build_step(app, root, integration, &merged, final_try).await? {
        return Ok(false);
    }

    // La branche principale avance sur le résultat intégré et testé — jamais
    // pendant que l'agent du dossier projet travaille (il a la priorité).
    for _ in 0..MAX_MAIN_RESYNCS {
        if let Some(lead) = busy_root_agent(state, root) {
            report_all(app, &merged, "merge", Status::Running, &format!("Waiting for {lead} to finish"), None);
            while busy_root_agent(state, root).is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
        let root_guard = state.root_lock.lock().await;
        // L'agent du projet n'a rien committé entre-temps : fast-forward direct.
        if git::is_ancestor(root, main, INTEGRATION_BRANCH).await {
            report_all(app, &merged, "merge", Status::Running, &format!("Updating {main}"), None);
            let ff = git::run(root, &["merge", "--ff-only", INTEGRATION_BRANCH]).await?;
            drop(root_guard);
            if !ff.ok {
                let detail = format!(
                    "{}\nCommit or stash the changes in the project folder, then finish another task.",
                    ff.stderr.trim()
                );
                report_all(app, &merged, "merge", Status::Error, &format!("Could not update {main}"), Some(&detail));
                return Ok(false);
            }
            report_all(app, &merged, "merge", Status::Done, &format!("Merged into {main}"), None);
            return Ok(true);
        }
        drop(root_guard);

        // La branche principale a avancé (commit de l'agent du projet) : on l'intègre
        // d'abord — sa version l'emporte en cas de conflit — puis on rebuild.
        report_all(app, &merged, "sync", Status::Running, &format!("Syncing with the latest {main}"), None);
        if let Err(err) = merge_branch(integration, main, main).await {
            report_all(app, &merged, "sync", Status::Error, &format!("Could not sync with {main}"), Some(&err.to_string()));
            return Ok(false);
        }
        report_all(app, &merged, "sync", Status::Done, &format!("Synced with the latest {main}"), None);
        if !build_step(app, root, integration, &merged, true).await? {
            return Ok(false);
        }
    }
    let detail = format!("{main} kept changing; the next finished task will retry.");
    report_all(app, &merged, "merge", Status::Error, &format!("Could not update {main}"), Some(&detail));
    Ok(false)
}

/// Nombre de fois où l'on réintègre une branche principale qui a bougé avant d'abandonner.
const MAX_MAIN_RESYNCS: usize = 3;

/// Build dans le worktree d'intégration. `final_try` : Claude corrige un build
/// cassé et l'échec est signalé ; sinon un échec laisse reprendre tâche par tâche.
async fn build_step(app: &AppHandle, root: &Path, integration: &Path, merged: &[Task], final_try: bool) -> AppResult<bool> {
    let Some(command) = build::command(root) else { return Ok(true) };
    let label = if merged.len() > 1 {
        format!("Building {} tasks ({command})", merged.len())
    } else {
        format!("Building ({command})")
    };
    report_all(app, merged, "build", Status::Running, &label, None);
    let (ok, output) = build::run(integration, &command).await?;
    if !ok {
        if !final_try {
            // Le lot sera repris tâche par tâche : pas encore un échec définitif.
            report_all(app, merged, "build", Status::Running, "Batch build failed, retrying alone", None);
            return Ok(false);
        }
        if let Err(output) = fix_build(integration, &command, &output).await? {
            report_all(app, merged, "build", Status::Error, "Build failed", Some(&output));
            return Ok(false);
        }
    }
    report_all(app, merged, "build", Status::Done, "Build passed", None);
    Ok(true)
}

fn commit_message(agent: &str, summary: Option<&str>) -> String {
    let first_line = summary.and_then(|s| s.lines().find(|l| !l.trim().is_empty())).map(str::trim);
    match first_line {
        Some(line) => format!("{agent}: {}", line.chars().take(72).collect::<String>()),
        None => format!("{agent}: task completed"),
    }
}

/// Merge d'une branche d'agent dans le worktree d'intégration ; Claude résout les conflits.
async fn merge_branch(integration: &Path, branch: &str, main: &str) -> AppResult<()> {
    let merge = git::run(integration, &["merge", "--no-edit", branch]).await?;
    if merge.ok {
        return Ok(());
    }
    let conflicts = git::conflicted_files(integration).await?;
    if conflicts.is_empty() {
        let _ = git::run(integration, &["merge", "--abort"]).await;
        return Err(AppError::msg(merge.stderr.trim().to_owned()));
    }

    let prompt = format!(
        "A git merge of the branch `{branch}` into `{main}` stopped on conflicts in these files:\n{}\n\n\
         Resolve every conflict: keep the intent of both sides, remove all conflict markers \
         (<<<<<<<, =======, >>>>>>>) and leave the code compiling. When both sides change the same code in \
         incompatible ways, the `{main}` side (ours) has priority: it holds the main branch and the work already \
         integrated, including Prime's, the lead agent. Keep its version and adapt the other change to it. Edit the files only; do not run git commands.",
        conflicts.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n")
    );
    let resolved = claude::run_once(integration, &prompt).await;
    if resolved.is_err() || has_conflict_markers(integration, &conflicts) {
        let _ = git::run(integration, &["merge", "--abort"]).await;
        return Err(AppError::msg(match resolved {
            Err(err) => format!("Conflicts could not be resolved: {err}"),
            Ok(_) => "Conflict markers are still present after resolution.".into(),
        }));
    }
    git::commit_merge(integration).await
}

fn has_conflict_markers(dir: &Path, files: &[String]) -> bool {
    files.iter().any(|file| {
        std::fs::read_to_string(dir.join(file))
            .map(|text| text.lines().any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> ")))
            .unwrap_or(false)
    })
}

/// Claude corrige un build cassé dans le worktree d'intégration, puis nouvel
/// essai. `Ok(Err(sortie))` = le build échoue encore.
async fn fix_build(integration: &Path, command: &str, output: &str) -> AppResult<Result<(), String>> {
    let prompt = format!(
        "The build command `{command}` fails in this project. Fix the code so that it succeeds. \
         Make the smallest change that fixes the errors; do not run git commands.\n\nBuild output:\n```\n{output}\n```"
    );
    if claude::run_once(integration, &prompt).await.is_err() {
        return Ok(Err(output.to_owned()));
    }
    git::commit_all(integration, "Fix build (FAST orchestrator)").await?;
    let (ok, output) = build::run(integration, command).await?;
    Ok(if ok { Ok(()) } else { Err(output) })
}
