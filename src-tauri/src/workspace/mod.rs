//! Espaces de travail des agents.
//!
//! Chaque agent, Prime compris, reçoit un worktree git isolé,
//! `.fast/worktrees/agent-N`, sur sa branche `fast/agent-N` : ses fichiers et ses
//! commandes ne gênent pas les autres (sans git, tous partagent le dossier du projet). À chaque fin de tâche, l'orchestrateur ramène son travail sur la
//! branche principale via le worktree d'intégration `.fast/integration`, le seul
//! où l'on build : son cache reste chaud (voir `orchestrator.rs`).

pub mod build;
pub mod deps;
pub mod run;
pub mod git;
pub mod orchestrator;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Mutex},
};

use serde::Serialize;

use crate::{error::AppResult, platform};

/// Dossiers partagés depuis le projet plutôt que réinstallés dans chaque worktree.
const SHARED_DIRS: &[&str] = &["node_modules"];

#[derive(Clone)]
pub(crate) struct AgentEntry {
    pub(crate) root: PathBuf,
    pub(crate) name: String,
    pub(crate) cwd: PathBuf,
    /// Branche de l'agent ; `None` seulement sans git (tous partagent alors le projet).
    pub(crate) branch: Option<String>,
    /// Ordre de création : 0 = Prime, l'agent principal, prioritaire à l'intégration.
    pub(crate) index: u32,
    /// Claude travaille sur une tâche (les étapes de l'orchestrateur ne comptent pas).
    pub(crate) busy: bool,
    /// Tâche terminée dont le commit n'est pas encore fait.
    pub(crate) committing: bool,
}

#[derive(Default)]
pub struct WorkspaceState {
    agents: Mutex<HashMap<String, AgentEntry>>,
    /// Tâches terminées en attente d'intégration (traitées par lots).
    queue: Mutex<Vec<orchestrator::Task>>,
    /// Une seule boucle d'intégration à la fois : les merges ne se croisent jamais.
    processing: AtomicBool,
    /// Accès au dossier du projet (branche principale) : le commit de l'agent qui
    /// y travaille et la mise à jour par l'orchestrateur ne se croisent jamais.
    root_lock: tokio::sync::Mutex<()>,
}

/// Ce que l'interface doit savoir pour lancer un agent.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspace {
    /// Dossier de travail de l'agent (worktree, ou le projet).
    cwd: PathBuf,
    branch: Option<String>,
    /// Pourquoi l'agent n'est pas isolé, s'il ne l'est pas (git absent…).
    notice: Option<String>,
}

/// Le projet est un dépôt git, avec `.fast/` exclu ; sinon le dépôt est créé.
pub(crate) async fn ensure_repo(root: &Path) -> AppResult<()> {
    if !git::is_repo(root).await {
        git::init(root).await?;
    }
    git::exclude(root, "/.fast/").await?;
    // Optimisation seulement : un échec n'empêche pas de travailler.
    let _ = git::tune_for_size(root).await;
    Ok(())
}

/// Relie les dossiers partagés (node_modules…) du projet dans un worktree.
fn link_shared(root: &Path, dir: &Path) {
    for shared in SHARED_DIRS {
        let (source, link) = (root.join(shared), dir.join(shared));
        if source.is_dir() && !link.exists() {
            // Un lien manquant n'empêche pas de travailler : le build le dira.
            let _ = platform::link_dir(&source, &link);
        }
    }
}

/// Crée (ou réutilise) le worktree `dir` sur `branch`, partant de HEAD si la branche est nouvelle.
async fn ensure_worktree(root: &Path, dir: &Path, branch: &str) -> AppResult<()> {
    if !git::is_repo(dir).await {
        git::ensure(root, &["worktree", "prune"]).await?;
        std::fs::create_dir_all(dir.parent().unwrap_or(root))?;
        let path = dir.to_string_lossy().into_owned();
        if git::branch_exists(root, branch).await {
            git::ensure(root, &["worktree", "add", &path, branch]).await?;
        } else {
            git::ensure(root, &["worktree", "add", "-b", branch, &path, "HEAD"]).await?;
        }
    }
    link_shared(root, dir);
    Ok(())
}

/// Worktree d'intégration : seul l'orchestrateur y travaille (merge + build).
pub(crate) async fn ensure_integration(root: &Path) -> AppResult<PathBuf> {
    let dir = root.join(".fast").join("integration");
    ensure_worktree(root, &dir, "fast/integration").await?;
    Ok(dir)
}

/// Prépare l'espace de travail d'un agent (worktree). `index` 0 = Prime, l'agent principal.
pub async fn create_agent(state: &WorkspaceState, root: PathBuf, id: String, index: u32, name: String) -> AppResult<AgentWorkspace> {
    let register = |cwd: PathBuf, branch: Option<String>| {
        state.agents.lock().unwrap().insert(
            id.clone(),
            AgentEntry { root: root.clone(), name: name.clone(), cwd, branch, index, busy: false, committing: false },
        );
    };

    if !git::available().await {
        register(root.clone(), None);
        return Ok(AgentWorkspace {
            cwd: root.clone(),
            branch: None,
            notice: Some("git is not installed: agents share the project folder.".into()),
        });
    }

    ensure_repo(&root).await?;
    // Un `git push` lancé par un agent attendra l'accord de l'utilisateur.
    crate::scheduler::push::install_hook(&root).await;

    let slug = format!("agent-{}", index + 1);
    let branch = format!("fast/{slug}");
    let dir = root.join(".fast").join("worktrees").join(&slug);

    // Worktree d'une session précédente : réutilisé tel quel.
    ensure_worktree(&root, &dir, &branch).await?;

    register(dir.clone(), Some(branch.clone()));
    Ok(AgentWorkspace { cwd: dir, branch: Some(branch), notice: None })
}

/// Agent fermé : son worktree est retiré, sa branche (et donc son travail) est gardée.
pub async fn remove_agent(state: &WorkspaceState, id: &str) -> AppResult<()> {
    let Some(entry) = state.agents.lock().unwrap().remove(id) else {
        return Ok(());
    };
    if entry.branch.is_none() {
        return Ok(());
    }
    // Les liens d'abord : un retrait récursif ne doit jamais entrer dans le dossier partagé.
    for shared in SHARED_DIRS {
        let link = entry.cwd.join(shared);
        if link.exists() {
            platform::unlink_dir(&link)?;
        }
    }
    let path = entry.cwd.to_string_lossy().into_owned();
    git::ensure(&entry.root, &["worktree", "remove", "--force", &path]).await.map(|_| ())
}

pub fn set_busy(state: &WorkspaceState, id: &str, busy: bool) {
    if let Some(entry) = state.agents.lock().unwrap().get_mut(id) {
        entry.busy = busy;
    }
}

pub(crate) fn set_committing(state: &WorkspaceState, id: &str, committing: bool) {
    if let Some(entry) = state.agents.lock().unwrap().get_mut(id) {
        entry.committing = committing;
    }
}

pub(crate) fn entry(state: &WorkspaceState, id: &str) -> Option<AgentEntry> {
    state.agents.lock().unwrap().get(id).cloned()
}

/// Agent qui travaille dans le dossier du projet (sur la branche principale), s'il travaille en ce moment.
pub(crate) fn busy_root_agent(state: &WorkspaceState, root: &Path) -> Option<String> {
    state
        .agents
        .lock()
        .unwrap()
        .values()
        .find(|e| e.root == root && e.branch.is_none() && (e.busy || e.committing))
        .map(|e| e.name.clone())
}

/// Agents du projet `root` (identifiant, entrée).
pub(crate) fn agents_in(state: &WorkspaceState, root: &Path) -> Vec<(String, AgentEntry)> {
    state.agents.lock().unwrap().iter().filter(|(_, e)| e.root == root).map(|(id, e)| (id.clone(), e.clone())).collect()
}

/// Même dossier, quelle que soit l'écriture (séparateurs, casse sous Windows).
fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let text = p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_owned();
        if cfg!(windows) { text.to_lowercase() } else { text }
    };
    norm(a) == norm(b)
}

/// Agent qui travaille dans `cwd` (identifiant, entrée).
pub(crate) fn agent_by_cwd(state: &WorkspaceState, cwd: &Path) -> Option<(String, AgentEntry)> {
    state.agents.lock().unwrap().iter().find(|(_, e)| same_path(&e.cwd, cwd)).map(|(id, e)| (id.clone(), e.clone()))
}

/// Worktree de l'agent remis sur la branche principale (fast-forward seulement :
/// sans risque pour son travail). Rend `true` s'il est à jour.
pub async fn sync_with_main(state: &WorkspaceState, id: &str) -> AppResult<bool> {
    let Some(agent) = entry(state, id) else { return Ok(false) };
    if agent.branch.is_none() {
        return Ok(true);
    }
    let main = git::current_branch(&agent.root).await?;
    let ok = git::run(&agent.cwd, &["merge", "--ff-only", &main]).await?.ok;
    if ok {
        let (root, dir) = (agent.root.clone(), agent.cwd.clone());
        let _ = tauri::async_runtime::spawn_blocking(move || deps::relink_shared(&root, &dir)).await;
    }
    Ok(ok)
}

/// Agents isolés et inactifs du projet : ceux qu'on peut mettre à jour sans risque.
pub(crate) fn idle_isolated(state: &WorkspaceState, root: &Path) -> Vec<AgentEntry> {
    state
        .agents
        .lock()
        .unwrap()
        .values()
        .filter(|e| e.root == root && e.branch.is_some() && !e.busy)
        .cloned()
        .collect()
}
