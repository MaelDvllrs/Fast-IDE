//! Gestion de version du projet ouvert, pour le panneau Git : état des
//! fichiers, index, commit, push / pull, branches, publication sur GitHub et
//! clonage. Tout passe par la commande `git` ; les échanges avec github.com
//! utilisent le jeton du compte connecté (voir [`crate::github::git_env`]).

use std::path::{Path, PathBuf, MAIN_SEPARATOR};

use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    github::{self, GithubState},
    workspace::git,
};

/// Préfixe des branches internes de FAST (agents, intégration), masquées du panneau.
const INTERNAL_BRANCH_PREFIX: &str = "fast/";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Chemin relatif à la racine du dépôt, séparateurs `/`.
    pub path: String,
    /// Chemin absolu, au format du système (pour ouvrir le fichier).
    pub abs_path: String,
    /// Lettre de git : M, A, D, R, C, T, U (conflit) ou ? (non suivi).
    pub status: String,
    /// Ancien chemin d'un fichier renommé.
    pub from: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repo: bool,
    /// `None` sur une tête détachée.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// URL du remote `origin`.
    pub remote: Option<String>,
    /// Le dépôt a au moins un commit.
    pub has_commits: bool,
    pub merging: bool,
    pub staged: Vec<Change>,
    pub changes: Vec<Change>,
    pub conflicts: Vec<Change>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub current: Option<String>,
    pub local: Vec<String>,
    /// Branches distantes (`origin/x`) sans branche locale du même nom.
    pub remote: Vec<String>,
}

/// Racine du dépôt contenant `dir`, `None` si ce n'est pas un dépôt.
async fn toplevel(dir: &Path) -> Option<PathBuf> {
    let out = git::run(dir, &["rev-parse", "--show-toplevel"]).await.ok()?;
    out.ok.then(|| PathBuf::from(native(out.stdout.trim())))
}

async fn repo_root(dir: &Path) -> AppResult<PathBuf> {
    toplevel(dir).await.ok_or_else(|| AppError::msg("This folder isn't a Git repository."))
}

/// Séparateurs du système (git rend des `/` même sous Windows).
fn native(path: &str) -> String {
    path.replace('/', &MAIN_SEPARATOR.to_string())
}

pub async fn status(dir: &Path) -> AppResult<RepoStatus> {
    if !git::available().await {
        return Err(AppError::msg("Git isn't installed (or not in the PATH)."));
    }
    let Some(top) = toplevel(dir).await else {
        return Ok(RepoStatus::default());
    };
    let out = git::ensure(&top, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).await?;
    let mut status = RepoStatus { is_repo: true, ..Default::default() };
    let change = |path: &str, letter: char, from: Option<&str>| Change {
        path: path.to_owned(),
        abs_path: format!("{}{MAIN_SEPARATOR}{}", top.display(), native(path)),
        status: letter.to_string(),
        from: from.map(str::to_owned),
    };

    let mut records = out.split('\0').filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => status.has_commits = value != "(initial)",
                "branch.head" if value != "(detached)" => status.branch = Some(value.to_owned()),
                "branch.upstream" => status.upstream = Some(value.to_owned()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = record.as_bytes()[0];
        // Champs avant le chemin : 8 (modifié), 9 (renommé), 10 (conflit).
        let fields = match kind {
            b'1' => 9,
            b'2' => 10,
            b'u' => 11,
            b'?' => {
                status.changes.push(change(&record[2..], '?', None));
                continue;
            }
            _ => continue,
        };
        let parts: Vec<&str> = record.splitn(fields, ' ').collect();
        let (Some(xy), Some(path)) = (parts.get(1), parts.last()) else { continue };
        let mut xy = xy.chars();
        let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
        match kind {
            b'u' => status.conflicts.push(change(path, 'U', None)),
            _ => {
                // Renommage : l'ancien chemin suit, dans l'enregistrement suivant.
                let from = if kind == b'2' { records.next() } else { None };
                if x != '.' {
                    status.staged.push(change(path, x, from));
                }
                if y != '.' {
                    status.changes.push(change(path, y, None));
                }
            }
        }
    }

    status.remote = git::run(&top, &["remote", "get-url", "origin"])
        .await
        .ok()
        .filter(|o| o.ok)
        .map(|o| o.stdout.trim().to_owned());
    status.merging = git::run(&top, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).await.is_ok_and(|o| o.ok);
    Ok(status)
}

/// Lance `git <base> -- <paths>` par paquets (limite de longueur des lignes de commande).
async fn for_paths(top: &Path, base: &[&str], paths: &[String]) -> AppResult<()> {
    for chunk in paths.chunks(100) {
        let mut args = base.to_vec();
        args.push("--");
        args.extend(chunk.iter().map(String::as_str));
        git::ensure(top, &args).await?;
    }
    Ok(())
}

/// Ajoute à l'index ; `paths` vide = toutes les modifications.
pub async fn stage(dir: &Path, paths: &[String]) -> AppResult<()> {
    let top = repo_root(dir).await?;
    if paths.is_empty() {
        return git::ensure(&top, &["add", "-A"]).await.map(|_| ());
    }
    for_paths(&top, &["add", "-A"], paths).await
}

/// Retire de l'index ; `paths` vide = tout.
pub async fn unstage(dir: &Path, paths: &[String]) -> AppResult<()> {
    let top = repo_root(dir).await?;
    let has_head = git::run(&top, &["rev-parse", "-q", "--verify", "HEAD"]).await?.ok;
    match (has_head, paths.is_empty()) {
        (true, true) => git::ensure(&top, &["reset", "-q"]).await.map(|_| ()),
        (true, false) => for_paths(&top, &["restore", "--staged"], paths).await,
        // Aucun commit encore : il n'y a pas de HEAD à restaurer.
        (false, true) => git::ensure(&top, &["rm", "--cached", "-r", "-q", "."]).await.map(|_| ()),
        (false, false) => for_paths(&top, &["rm", "--cached", "-r", "-q", "--ignore-unmatch"], paths).await,
    }
}

/// Crée un commit. Si rien n'est indexé, toutes les modifications le sont d'abord.
/// Rend le hash court du commit.
pub async fn commit(github: &GithubState, dir: &Path, message: &str) -> AppResult<String> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::msg("Write a commit message first."));
    }
    let top = repo_root(dir).await?;
    if git::run(&top, &["diff", "--cached", "--quiet"]).await?.ok {
        git::ensure(&top, &["add", "-A"]).await?;
        if git::run(&top, &["diff", "--cached", "--quiet"]).await?.ok {
            return Err(AppError::msg("There is nothing to commit."));
        }
    }
    // Sans identité git configurée : celle du compte GitHub (adresse noreply), sinon FAST.
    let mut owned = Vec::new();
    if !git::has_identity(&top).await {
        if let Some(account) = github::cached_account(github) {
            owned.push(format!("user.name={}", account.name.clone().unwrap_or_else(|| account.login.clone())));
            owned.push(format!("user.email={}", account.noreply_email()));
        } else {
            owned.push("user.name=FAST".to_owned());
            owned.push("user.email=fast@localhost".to_owned());
        }
    }
    let mut args = Vec::new();
    for value in &owned {
        args.extend(["-c", value.as_str()]);
    }
    args.extend(["commit", "-q", "-m", message]);
    git::ensure(&top, &args).await?;
    Ok(git::ensure(&top, &["rev-parse", "--short", "HEAD"]).await?.trim().to_owned())
}

/// Erreur git → message court, avec une piste pour les cas courants.
fn remote_error(action: &str, stderr: &str) -> AppError {
    let stderr = stderr.trim();
    let hint = if stderr.contains("non-fast-forward") || stderr.contains("fetch first") || stderr.contains("[rejected]") {
        "\nThe remote has new commits: pull first."
    } else if stderr.contains("Authentication failed") || stderr.contains("could not read Username") || stderr.contains("403") {
        "\nSign in to GitHub (Preferences → Accounts) or check your access to this repository."
    } else {
        ""
    };
    AppError::msg(format!("{action} failed: {stderr}{hint}"))
}

pub async fn push(github: &GithubState, dir: &Path) -> AppResult<()> {
    let top = repo_root(dir).await?;
    let status = status(&top).await?;
    let env = github::git_env(github);
    let args: &[&str] = if status.upstream.is_some() {
        &["push"]
    } else if status.remote.is_some() {
        // Première publication de la branche : on la relie à origin.
        &["push", "-u", "origin", "HEAD"]
    } else {
        return Err(AppError::msg("This repository has no remote. Publish it to GitHub first."));
    };
    let out = git::run_env(&top, args, &env).await?;
    if out.ok {
        Ok(())
    } else {
        Err(remote_error("Push", &out.stderr))
    }
}

pub async fn pull(github: &GithubState, dir: &Path) -> AppResult<()> {
    let top = repo_root(dir).await?;
    if status(&top).await?.upstream.is_none() {
        return Err(AppError::msg("This branch isn't on the remote yet. Push it first."));
    }
    let out = git::run_env(&top, &["pull", "--no-rebase", "--no-edit"], &github::git_env(github)).await?;
    if out.ok {
        Ok(())
    } else {
        Err(remote_error("Pull", &format!("{}\n{}", out.stdout.trim(), out.stderr.trim())))
    }
}

/// Récupère l'état du remote (commits en avance / en retard), sans rien modifier.
pub async fn fetch(github: &GithubState, dir: &Path) -> AppResult<()> {
    let top = repo_root(dir).await?;
    let out = git::run_env(&top, &["fetch", "--prune", "-q"], &github::git_env(github)).await?;
    if out.ok {
        Ok(())
    } else {
        Err(remote_error("Fetch", &out.stderr))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    /// Date du commit, en secondes depuis l'époque Unix.
    pub time: i64,
    /// Pas encore sur la branche distante suivie.
    pub unpushed: bool,
}

/// Derniers commits de la branche courante, du plus récent au plus ancien.
pub async fn log(dir: &Path, limit: usize) -> AppResult<Vec<Commit>> {
    let top = repo_root(dir).await?;
    if !git::run(&top, &["rev-parse", "-q", "--verify", "HEAD"]).await?.ok {
        return Ok(vec![]);
    }
    let count = format!("-n{limit}");
    // Champs séparés par \x1f, commits par \x1e : aucun des deux n'apparaît dans un message.
    let out = git::ensure(&top, &["log", &count, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1e"]).await?;
    let unpushed: Vec<String> = match git::run(&top, &["rev-list", &count, "@{upstream}..HEAD"]).await? {
        o if o.ok => o.stdout.lines().map(str::to_owned).collect(),
        // Pas de branche distante : rien n'est publié.
        _ => vec!["*".to_owned()],
    };
    Ok(out
        .split('\x1e')
        .filter_map(|record| {
            let mut fields = record.trim_start_matches('\n').split('\x1f');
            let hash = fields.next()?.to_owned();
            if hash.is_empty() {
                return None;
            }
            Some(Commit {
                unpushed: unpushed.first().is_some_and(|u| u == "*") || unpushed.contains(&hash),
                short_hash: fields.next()?.to_owned(),
                subject: fields.next()?.to_owned(),
                author: fields.next()?.to_owned(),
                time: fields.next()?.trim().parse().unwrap_or(0),
                hash,
            })
        })
        .collect())
}

pub async fn branches(dir: &Path) -> AppResult<Branches> {
    let top = repo_root(dir).await?;
    let list = |refs: &'static str| {
        let top = top.clone();
        async move {
            let out = git::ensure(&top, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", refs]).await?;
            AppResult::Ok(
                out.lines()
                    .map(str::trim)
                    .filter(|b| !b.is_empty() && !b.starts_with(INTERNAL_BRANCH_PREFIX))
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            )
        }
    };
    let local = list("refs/heads").await?;
    let remote = list("refs/remotes")
        .await?
        .into_iter()
        // `origin/HEAD` (ou `origin` seul) n'est qu'un alias.
        .filter(|b| b.contains('/') && !b.ends_with("/HEAD"))
        .filter(|b| {
            let short = b.split_once('/').map_or(b.as_str(), |(_, rest)| rest);
            !short.starts_with(INTERNAL_BRANCH_PREFIX) && !local.iter().any(|l| l == short)
        })
        .collect();
    Ok(Branches { current: git::current_branch(&top).await.ok().filter(|b| b != "HEAD"), local, remote })
}

/// Passe sur `branch` ; une branche distante (`origin/x`) devient une branche locale qui la suit.
pub async fn checkout(dir: &Path, branch: &str) -> AppResult<()> {
    let top = repo_root(dir).await?;
    let is_remote = !git::branch_exists(&top, branch).await
        && git::run(&top, &["rev-parse", "-q", "--verify", &format!("refs/remotes/{branch}")]).await?.ok;
    if is_remote {
        git::ensure(&top, &["switch", "--track", branch]).await?;
    } else {
        git::ensure(&top, &["switch", branch]).await?;
    }
    Ok(())
}

pub async fn create_branch(dir: &Path, name: &str) -> AppResult<()> {
    let top = repo_root(dir).await?;
    let name = name.trim();
    if !git::run(&top, &["check-ref-format", "--branch", name]).await?.ok {
        return Err(AppError::msg(format!("\"{name}\" isn't a valid branch name.")));
    }
    git::ensure(&top, &["switch", "-c", name]).await.map(|_| ())
}

/// Dépôt git dans le dossier ouvert, avec un premier commit.
pub async fn init(dir: &Path) -> AppResult<()> {
    crate::workspace::ensure_repo(dir).await
}

/// Crée un dépôt GitHub pour le projet ouvert, l'ajoute comme `origin` et pousse la branche.
pub async fn publish(github: &GithubState, dir: &Path, name: &str, private: bool, description: Option<&str>) -> AppResult<github::Repo> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Choose a repository name."));
    }
    crate::workspace::ensure_repo(dir).await?;
    let top = repo_root(dir).await?;
    if git::run(&top, &["remote", "get-url", "origin"]).await?.ok {
        return Err(AppError::msg("This repository already has an \"origin\" remote."));
    }
    if !git::run(&top, &["rev-parse", "-q", "--verify", "HEAD"]).await?.ok {
        git::commit_all(&top, "Initial commit").await?;
    }
    let repo = github::create_repo(github, name, private, description).await?;
    git::ensure(&top, &["remote", "add", "origin", &repo.clone_url]).await?;
    let out = git::run_env(&top, &["push", "-u", "origin", "HEAD"], &github::git_env(github)).await?;
    if !out.ok {
        return Err(remote_error("The repository was created, but the push", &out.stderr));
    }
    Ok(repo)
}

/// Clone `url` dans un nouveau dossier de `parent` ; rend le chemin du dossier.
pub async fn clone(github: &GithubState, url: &str, parent: &Path, name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(AppError::msg("Invalid folder name."));
    }
    let dest = parent.join(name);
    if dest.exists() {
        return Err(AppError::msg(format!("{} already exists.", dest.display())));
    }
    let out = git::run_env(parent, &["clone", "-q", "--", url, name], &github::git_env(github)).await?;
    if !out.ok {
        return Err(remote_error("Clone", &out.stderr));
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_in(dir: &Path, args: &[&str]) {
        tauri::async_runtime::block_on(git::ensure(dir, args)).unwrap();
    }

    /// État d'un dépôt avec un fichier indexé, modifié, renommé, supprimé et non suivi.
    #[test]
    fn parses_status() {
        let dir = std::env::temp_dir().join(format!("fast-scm-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        for f in ["a.txt", "b.txt", "c.txt", "src/d.txt"] {
            std::fs::write(dir.join(f), f).unwrap();
        }
        git_in(&dir, &["init", "-q", "-b", "main"]);
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("a.txt"), "changed").unwrap();
        git_in(&dir, &["mv", "b.txt", "renamed b.txt"]);
        std::fs::remove_file(dir.join("c.txt")).unwrap();
        std::fs::write(dir.join("src/new file.txt"), "new").unwrap();
        std::fs::write(dir.join("src/d.txt"), "staged").unwrap();
        git_in(&dir, &["add", "src/d.txt"]);

        let s = tauri::async_runtime::block_on(status(&dir.join("src"))).unwrap();
        let fmt = |v: &[Change]| v.iter().map(|c| format!("{} {}", c.status, c.path)).collect::<Vec<_>>();
        assert!(s.is_repo && s.has_commits);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(fmt(&s.staged), ["R renamed b.txt", "M src/d.txt"]);
        assert_eq!(s.staged[0].from.as_deref(), Some("b.txt"));
        assert_eq!(fmt(&s.changes), ["M a.txt", "D c.txt", "? src/new file.txt"]);
        assert!(s.changes[2].abs_path.ends_with(&format!("src{MAIN_SEPARATOR}new file.txt")));

        tauri::async_runtime::block_on(stage(&dir, &[])).unwrap();
        tauri::async_runtime::block_on(unstage(&dir, &["a.txt".into()])).unwrap();
        let s = tauri::async_runtime::block_on(status(&dir)).unwrap();
        assert_eq!(fmt(&s.changes), ["M a.txt"]);

        git_in(&dir, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "second: with | odd chars"]);
        let commits = tauri::async_runtime::block_on(log(&dir, 10)).unwrap();
        let subjects: Vec<_> = commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["second: with | odd chars", "init"]);
        assert!(commits.iter().all(|c| c.unpushed && c.author == "t" && c.time > 0 && c.hash.starts_with(&c.short_hash)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
