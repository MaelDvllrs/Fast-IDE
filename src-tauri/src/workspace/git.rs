//! Appels à la commande `git` (doit être installée et dans le PATH).

use std::{path::Path, process::Stdio};

use tokio::process::Command;

use crate::{
    error::{AppError, AppResult},
    platform,
};

pub struct GitOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Lance `git <args>` dans `dir` et rend sa sortie, même en cas d'échec.
pub async fn run(dir: &Path, args: &[&str]) -> AppResult<GitOutput> {
    run_env(dir, args, &[]).await
}

/// Comme [`run`], avec des variables d'environnement en plus (identifiants GitHub…).
pub async fn run_env(dir: &Path, args: &[&str], env: &[(String, String)]) -> AppResult<GitOutput> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        // Jamais de demande interactive (identifiants, éditeur de message).
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .envs(env.iter().map(|(k, v)| (k, v)));
    platform::configure_command(&mut cmd);
    let out = cmd.output().await?;
    Ok(GitOutput {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Comme [`run`], mais une sortie en échec devient une erreur.
pub async fn ensure(dir: &Path, args: &[&str]) -> AppResult<String> {
    let out = run(dir, args).await?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(AppError::msg(format!("git {}: {}", args.join(" "), out.stderr.trim())))
    }
}

pub async fn available() -> bool {
    let mut cmd = Command::new("git");
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    platform::configure_command(&mut cmd);
    matches!(cmd.status().await, Ok(status) if status.success())
}

pub async fn is_repo(dir: &Path) -> bool {
    matches!(run(dir, &["rev-parse", "--is-inside-work-tree"]).await, Ok(out) if out.ok && out.stdout.trim() == "true")
}

/// Options à ajouter si aucune identité git n'est configurée : sinon `commit` échoue.
pub async fn identity(dir: &Path) -> Vec<&'static str> {
    if has_identity(dir).await {
        return vec![];
    }
    vec!["-c", "user.name=FAST", "-c", "user.email=fast@localhost"]
}

/// Une identité git (`user.email`) est-elle configurée ?
pub async fn has_identity(dir: &Path) -> bool {
    matches!(run(dir, &["config", "user.email"]).await, Ok(out) if out.ok && !out.stdout.trim().is_empty())
}

/// Indexe tout et crée un commit. `false` s'il n'y avait rien à committer.
pub async fn commit_all(dir: &Path, message: &str) -> AppResult<bool> {
    ensure(dir, &["add", "-A"]).await?;
    // `diff --cached --quiet` réussit quand rien n'est indexé.
    if run(dir, &["diff", "--cached", "--quiet"]).await?.ok {
        return Ok(false);
    }
    let mut args = identity(dir).await;
    args.extend(["commit", "--no-verify", "-m", message]);
    ensure(dir, &args).await?;
    Ok(true)
}

/// Termine un merge en cours (après résolution des conflits).
pub async fn commit_merge(dir: &Path) -> AppResult<()> {
    ensure(dir, &["add", "-A"]).await?;
    let mut args = identity(dir).await;
    args.extend(["commit", "--no-verify", "--no-edit"]);
    ensure(dir, &args).await.map(|_| ())
}

pub async fn current_branch(dir: &Path) -> AppResult<String> {
    Ok(ensure(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).await?.trim().to_owned())
}

pub async fn branch_exists(dir: &Path, branch: &str) -> bool {
    let reference = format!("refs/heads/{branch}");
    matches!(run(dir, &["rev-parse", "--verify", "--quiet", &reference]).await, Ok(out) if out.ok)
}

/// Fichiers en conflit d'un merge en cours.
pub async fn conflicted_files(dir: &Path) -> AppResult<Vec<String>> {
    let out = ensure(dir, &["diff", "--name-only", "--diff-filter=U"]).await?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
}

/// Nouveau dépôt avec un premier commit de tout le dossier (hors .gitignore).
pub async fn init(dir: &Path) -> AppResult<()> {
    ensure(dir, &["init"]).await?;
    ensure(dir, &["add", "-A"]).await?;
    let mut args = identity(dir).await;
    args.extend(["commit", "--no-verify", "--allow-empty", "-m", "Initial commit (FAST)"]);
    ensure(dir, &args).await.map(|_| ())
}

/// Au-delà de ce nombre de fichiers suivis, le moniteur de fichiers de git est activé.
const LARGE_REPO_FILES: usize = 20_000;

/// Réglages qui gardent `git status` / `git add` rapides sur les gros dépôts.
/// `core.fsmonitor` (service intégré à git sous Windows et macOS) évite de
/// rescanner tout l'arbre ; il n'est activé que pour les gros dépôts.
pub async fn tune_for_size(dir: &Path) -> AppResult<()> {
    ensure(dir, &["config", "feature.manyFiles", "true"]).await?;
    ensure(dir, &["config", "core.untrackedCache", "true"]).await?;
    let files = ensure(dir, &["ls-files", "-z"]).await?.matches('\0').count();
    if files > LARGE_REPO_FILES {
        ensure(dir, &["config", "core.fsmonitor", "true"]).await?;
    }
    Ok(())
}

/// `ancestor` est-il un ancêtre de `descendant` (fast-forward possible) ?
pub async fn is_ancestor(dir: &Path, ancestor: &str, descendant: &str) -> bool {
    matches!(run(dir, &["merge-base", "--is-ancestor", ancestor, descendant]).await, Ok(out) if out.ok)
}

/// Exclut un motif localement (.git/info/exclude), sans toucher au .gitignore du projet.
pub async fn exclude(dir: &Path, pattern: &str) -> AppResult<()> {
    let path = ensure(dir, &["rev-parse", "--git-path", "info/exclude"]).await?;
    let path = dir.join(path.trim());
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.lines().any(|line| line.trim() == pattern) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let separator = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    std::fs::write(&path, format!("{current}{separator}{pattern}\n"))?;
    Ok(())
}
