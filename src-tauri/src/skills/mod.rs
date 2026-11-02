//! Skills des agents : dossiers contenant un `SKILL.md` (nom, description, puis
//! instructions), lus par chaque IA dans ses propres dossiers :
//!
//! | IA          | Projet              | Général               |
//! |-------------|---------------------|-----------------------|
//! | Claude Code | `.claude/skills/`   | `~/.claude/skills/`   |
//! | Codex       | `.agents/skills/`   | `~/.codex/skills/`    |
//! | Gemini CLI  | `.gemini/skills/`   | `~/.gemini/skills/`   |
//!
//! Un skill installé par FAST est copié dans le dossier de chaque IA choisie.
//! L'installation part d'un lien GitHub (dépôt, dossier ou `SKILL.md`) : les
//! fichiers du skill sont lus par l'API GitHub, avec le compte connecté s'il y
//! en a un (dépôts privés, limite de requêtes plus haute).

use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::{AppError, AppResult},
    github::{self, GithubState},
    platform,
};

/// Fichiers au plus par skill, et taille totale au plus : un lien vers un dépôt
/// entier ne doit pas remplir le disque.
const MAX_FILES: usize = 300;
const MAX_BYTES: u64 = 20 * 1024 * 1024;

pub const AIS: &[&str] = &["claude-code", "codex", "gemini"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Project,
    Global,
}

fn home() -> AppResult<PathBuf> {
    platform::home_dir().ok_or_else(|| AppError::msg("home folder not found"))
}

/// Dossier de skills d'une IA, pour le projet `project` ou en général.
fn root(ai: &str, scope: Scope, project: Option<&Path>) -> AppResult<PathBuf> {
    let env_home = |var: &str, default: &str| -> AppResult<PathBuf> {
        Ok(match std::env::var_os(var) {
            Some(dir) => PathBuf::from(dir),
            None => home()?.join(default),
        })
    };
    Ok(match (scope, ai) {
        (Scope::Project, ai) => {
            let project = project.ok_or_else(|| AppError::msg("open a project first"))?;
            match ai {
                "claude-code" => project.join(".claude").join("skills"),
                "codex" => project.join(".agents").join("skills"),
                "gemini" => project.join(".gemini").join("skills"),
                _ => return Err(AppError::msg(format!("unknown AI {ai}"))),
            }
        }
        (Scope::Global, "claude-code") => home()?.join(".claude").join("skills"),
        (Scope::Global, "codex") => env_home("CODEX_HOME", ".codex")?.join("skills"),
        (Scope::Global, "gemini") => env_home("GEMINI_CLI_HOME", ".gemini")?.join("skills"),
        (Scope::Global, ai) => return Err(AppError::msg(format!("unknown AI {ai}"))),
    })
}

/// `name` et `description` de l'en-tête YAML d'un `SKILL.md`.
fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let header: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let field = |key: &str| -> Option<String> {
        let start = header.iter().position(|l| l.starts_with(&format!("{key}:")))?;
        let value = header[start][key.len() + 1..].trim();
        // Valeur sur plusieurs lignes (`>` ou `|`) : les lignes indentées qui suivent.
        let value = if value.is_empty() || value.starts_with('>') || value.starts_with('|') {
            header[start + 1..]
                .iter()
                .take_while(|l| l.starts_with(' ') || l.starts_with('\t'))
                .map(|l| l.trim())
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            value.trim_matches(|c| c == '"' || c == '\'').to_owned()
        };
        (!value.is_empty()).then_some(value)
    };
    (field("name"), field("description"))
}

/// Nom de dossier sûr : minuscules, chiffres, `-` et `_`.
fn slug(name: &str) -> String {
    let slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    slug.trim_matches('-').to_owned()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// Nom du dossier (identique pour toutes les IA).
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub scope: Scope,
    /// IA qui ont ce skill.
    pub ais: Vec<String>,
    /// Dossier du skill, chez la première IA qui l'a.
    pub path: PathBuf,
    /// Lien GitHub d'où FAST l'a installé.
    pub source: Option<String>,
}

/// Skills installés : ceux du projet, puis les généraux. Un même dossier chez
/// plusieurs IA est un seul skill.
pub fn list(project: Option<&Path>) -> Vec<Skill> {
    let mut skills: BTreeMap<(Scope, String), Skill> = BTreeMap::new();
    for scope in [Scope::Project, Scope::Global] {
        if scope == Scope::Project && project.is_none() {
            continue;
        }
        let sources = load_sources(scope, project);
        for ai in AIS {
            let Ok(dir) = root(ai, scope, project) else { continue };
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let id = entry.file_name().to_string_lossy().into_owned();
                // Dossiers internes (`.system` de Codex, `.trash`…).
                if id.starts_with('.') {
                    continue;
                }
                let path = entry.path();
                let Ok(text) = std::fs::read_to_string(path.join("SKILL.md")) else { continue };
                let skill = skills.entry((scope, id.clone())).or_insert_with(|| {
                    let (name, description) = frontmatter(&text);
                    Skill {
                        name: name.unwrap_or_else(|| id.clone()),
                        description,
                        scope,
                        ais: Vec::new(),
                        path: path.clone(),
                        source: sources.get(&id).cloned(),
                        id: id.clone(),
                    }
                });
                skill.ais.push((*ai).to_owned());
            }
        }
    }
    skills.into_values().collect()
}

/// Supprime un skill chez toutes les IA (`scope` : du projet ou général).
pub fn remove(id: &str, scope: Scope, project: Option<&Path>) -> AppResult<()> {
    if slug(id) != id || id.is_empty() {
        return Err(AppError::msg("invalid skill name"));
    }
    for ai in AIS {
        let dir = root(ai, scope, project)?.join(id);
        if dir.join("SKILL.md").is_file() {
            std::fs::remove_dir_all(&dir)?;
        }
    }
    let mut sources = load_sources(scope, project);
    if sources.remove(id).is_some() {
        save_sources(scope, project, &sources);
    }
    Ok(())
}

// --- Origine des skills installés par FAST -----------------------------------

/// `.fast/skills.json` (projet) ou `~/.fast/skills.json` (général) : skill → lien GitHub.
fn sources_path(scope: Scope, project: Option<&Path>) -> Option<PathBuf> {
    match scope {
        Scope::Project => project.map(|p| p.join(".fast").join("skills.json")),
        Scope::Global => platform::home_dir().map(|h| h.join(".fast").join("skills.json")),
    }
}

fn load_sources(scope: Scope, project: Option<&Path>) -> BTreeMap<String, String> {
    sources_path(scope, project)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_sources(scope: Scope, project: Option<&Path>, sources: &BTreeMap<String, String>) {
    let Some(path) = sources_path(scope, project) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(sources) {
        let _ = std::fs::write(path, text);
    }
}

// --- Installation depuis GitHub ----------------------------------------------

/// Lien GitHub décomposé.
#[derive(Debug, PartialEq)]
struct GithubLink {
    owner: String,
    repo: String,
    /// Branche, tag ou commit ; `None` = branche par défaut.
    reference: Option<String>,
    /// Dossier dans le dépôt (`""` = racine).
    path: String,
}

/// `https://github.com/o/r`, `.../tree/<réf>/<dossier>`, `.../blob/<réf>/<dossier>/SKILL.md`,
/// `github.com/o/r.git` ou `o/r`.
fn parse_link(link: &str) -> AppResult<GithubLink> {
    let invalid = || AppError::msg("paste a GitHub link, like https://github.com/owner/repo/tree/main/skills/my-skill");
    let mut rest = link.trim();
    for prefix in ["https://", "http://", "www."] {
        rest = rest.strip_prefix(prefix).unwrap_or(rest);
    }
    let rest = rest.strip_prefix("github.com/").unwrap_or(rest);
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return Err(invalid());
    }
    let (owner, repo) = (parts[0].to_owned(), parts[1].trim_end_matches(".git").to_owned());
    let valid = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !valid(&owner) || !valid(&repo) {
        return Err(invalid());
    }
    let (reference, mut path) = match parts.get(2) {
        Some(&"tree") | Some(&"blob") => (parts.get(3).map(|r| (*r).to_owned()), parts.get(4..).map(|p| p.join("/")).unwrap_or_default()),
        Some(_) => return Err(invalid()),
        None => (None, String::new()),
    };
    // Lien vers le fichier SKILL.md : son dossier.
    if path == "SKILL.md" || path.ends_with("/SKILL.md") {
        path = path.trim_end_matches("SKILL.md").trim_end_matches('/').to_owned();
    }
    Ok(GithubLink { owner, repo, reference, path })
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("FAST/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AppError::msg(e.to_string()))
}

async fn get(client: &reqwest::Client, token: Option<&str>, url: &str) -> AppResult<reqwest::Response> {
    let mut request = client.get(url).header("Accept", "application/vnd.github+json");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|e| AppError::msg(format!("GitHub is unreachable: {e}")))?;
    match response.status().as_u16() {
        200 => Ok(response),
        404 => Err(AppError::msg(if token.is_some() {
            "Not found on GitHub: check the link (repository, branch and folder)."
        } else {
            "Not found on GitHub: check the link. For a private repository, sign in to GitHub first."
        })),
        403 | 429 => Err(AppError::msg(if token.is_some() {
            "GitHub's rate limit is reached. Try again in a few minutes."
        } else {
            "GitHub's rate limit is reached. Sign in to GitHub in FAST to raise it, or try again later."
        })),
        status => Err(AppError::msg(format!("GitHub answered {status}"))),
    }
}

/// Jeton GitHub de FAST s'il est encore accepté ; sinon, accès anonyme (suffisant
/// pour un dépôt public) plutôt qu'un échec.
async fn usable_token(client: &reqwest::Client, github: &GithubState) -> Option<String> {
    let token = github::token(github)?;
    let response = client.get("https://api.github.com/user").bearer_auth(&token).send().await.ok()?;
    (response.status() != reqwest::StatusCode::UNAUTHORIZED).then_some(token)
}

/// Dépôt lu : référence résolue et fichiers (chemin → taille).
struct RepoFiles {
    link: GithubLink,
    reference: String,
    files: Vec<(String, u64)>,
}

async fn repo_files(client: &reqwest::Client, token: Option<&str>, link: GithubLink) -> AppResult<RepoFiles> {
    let api = format!("https://api.github.com/repos/{}/{}", link.owner, link.repo);
    let reference = match &link.reference {
        Some(reference) => reference.clone(),
        None => {
            let repo: Value = get(client, token, &api).await?.json().await.map_err(|e| AppError::msg(e.to_string()))?;
            repo["default_branch"].as_str().unwrap_or("main").to_owned()
        }
    };
    let tree: Value = get(client, token, &format!("{api}/git/trees/{reference}?recursive=1"))
        .await?
        .json()
        .await
        .map_err(|e| AppError::msg(e.to_string()))?;
    let files = tree["tree"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|i| i["type"] == "blob")
                .filter_map(|i| Some((i["path"].as_str()?.to_owned(), i["size"].as_u64().unwrap_or(0))))
                .collect()
        })
        .unwrap_or_default();
    Ok(RepoFiles { link, reference, files })
}

async fn raw(client: &reqwest::Client, token: Option<&str>, repo: &RepoFiles, path: &str) -> AppResult<Vec<u8>> {
    let encoded: Vec<String> = path.split('/').map(|p| urlencode(p)).collect();
    let url = format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        repo.link.owner,
        repo.link.repo,
        urlencode(&repo.reference),
        encoded.join("/")
    );
    let mut request = client.get(url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|e| AppError::msg(format!("GitHub is unreachable: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::msg(format!("could not download {path} ({})", response.status())));
    }
    Ok(response.bytes().await.map_err(|e| AppError::msg(e.to_string()))?.to_vec())
}

fn urlencode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Skill trouvé dans un dépôt.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Dossier du skill dans le dépôt (`""` = racine).
    pub dir: String,
    /// Nom du dossier une fois installé.
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub files: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    /// `owner/repo`.
    pub repo: String,
    pub candidates: Vec<Candidate>,
}

/// Dossiers de skills (contenant un `SKILL.md`) sous le dossier du lien.
fn skill_dirs(repo: &RepoFiles) -> Vec<String> {
    let base = repo.link.path.trim_matches('/');
    repo.files
        .iter()
        .filter_map(|(path, _)| {
            let dir = if path == "SKILL.md" { "" } else { path.strip_suffix("/SKILL.md")? };
            let inside = base.is_empty() || dir == base || dir.starts_with(&format!("{base}/"));
            inside.then(|| dir.to_owned())
        })
        .take(50)
        .collect()
}

/// Fichiers d'un skill : tout ce qui est sous son dossier.
fn skill_files<'a>(repo: &'a RepoFiles, dir: &str) -> Vec<&'a (String, u64)> {
    repo.files
        .iter()
        .filter(|(path, _)| dir.is_empty() || path.starts_with(&format!("{dir}/")))
        .collect()
}

/// Nom d'installation : `name` du SKILL.md, sinon le dossier (ou le dépôt, à la racine).
fn install_id(repo: &RepoFiles, dir: &str, name: Option<&str>) -> String {
    let folder = dir.rsplit('/').next().filter(|f| !f.is_empty()).unwrap_or(&repo.link.repo);
    let id = name.map(slug).filter(|s| !s.is_empty()).unwrap_or_else(|| slug(folder));
    if id.is_empty() { "skill".into() } else { id }
}

/// Lit le lien et rend les skills qu'il contient (sans rien installer).
pub async fn inspect(github: &GithubState, link: &str) -> AppResult<Inspection> {
    let client = client()?;
    let token = usable_token(&client, github).await;
    let repo = repo_files(&client, token.as_deref(), parse_link(link)?).await?;
    let dirs = skill_dirs(&repo);
    if dirs.is_empty() {
        return Err(AppError::msg("No skill here: a skill is a folder with a SKILL.md file."));
    }
    let mut candidates = Vec::new();
    for dir in dirs {
        let skill_md = if dir.is_empty() { "SKILL.md".to_owned() } else { format!("{dir}/SKILL.md") };
        let text = String::from_utf8_lossy(&raw(&client, token.as_deref(), &repo, &skill_md).await?).into_owned();
        let (name, description) = frontmatter(&text);
        let id = install_id(&repo, &dir, name.as_deref());
        candidates.push(Candidate {
            files: skill_files(&repo, &dir).len(),
            name: name.unwrap_or_else(|| id.clone()),
            description,
            dir,
            id,
        });
    }
    Ok(Inspection { repo: format!("{}/{}", repo.link.owner, repo.link.repo), candidates })
}

/// Chemin relatif sûr (pas de `..`, pas de chemin absolu).
fn safe_relative(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    path.components().all(|c| matches!(c, Component::Normal(_))).then(|| path.to_path_buf())
}

/// Installe les skills `dirs` du lien pour les IA `ais`. Un skill déjà installé
/// sous le même nom est remplacé (mise à jour). Rend les noms installés.
pub async fn install(
    github: &GithubState,
    link: &str,
    dirs: &[String],
    scope: Scope,
    project: Option<&Path>,
    ais: &[String],
) -> AppResult<Vec<String>> {
    if ais.is_empty() {
        return Err(AppError::msg("choose at least one AI"));
    }
    let client = client()?;
    let token = usable_token(&client, github).await;
    let repo = repo_files(&client, token.as_deref(), parse_link(link)?).await?;
    let mut sources = load_sources(scope, project);
    let mut installed = Vec::new();

    for dir in dirs {
        let files = skill_files(&repo, dir);
        if !files.iter().any(|(p, _)| p.ends_with("SKILL.md")) {
            return Err(AppError::msg(format!("no SKILL.md in {dir}")));
        }
        if files.len() > MAX_FILES || files.iter().map(|(_, size)| size).sum::<u64>() > MAX_BYTES {
            return Err(AppError::msg(format!("{} is too big to be a skill (over {MAX_FILES} files or 20 MB)", if dir.is_empty() { &repo.link.repo } else { dir })));
        }
        // Téléchargé une fois, écrit ensuite chez chaque IA.
        let mut contents = Vec::new();
        for (path, _) in &files {
            let relative = if dir.is_empty() { path.as_str() } else { &path[dir.len() + 1..] };
            let Some(relative) = safe_relative(relative) else { continue };
            contents.push((relative, raw(&client, token.as_deref(), &repo, path).await?));
        }
        let skill_md = contents.iter().find(|(p, _)| p == Path::new("SKILL.md")).map(|(_, c)| String::from_utf8_lossy(c).into_owned());
        let (name, _) = frontmatter(skill_md.as_deref().unwrap_or_default());
        let id = install_id(&repo, dir, name.as_deref());

        for ai in ais {
            let target = root(ai, scope, project)?.join(&id);
            // Remplacement complet : un fichier retiré de la nouvelle version disparaît.
            if target.exists() {
                std::fs::remove_dir_all(&target)?;
            }
            for (relative, data) in &contents {
                let file = target.join(relative);
                if let Some(parent) = file.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(file, data)?;
            }
        }
        let tree = if dir.is_empty() { String::new() } else { format!("/tree/{}/{dir}", repo.reference) };
        sources.insert(id.clone(), format!("https://github.com/{}/{}{tree}", repo.link.owner, repo.link.repo));
        installed.push(id);
    }
    save_sources(scope, project, &sources);
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_links() {
        let link = parse_link("https://github.com/anthropics/skills/tree/main/skills/pdf").unwrap();
        assert_eq!(
            link,
            GithubLink { owner: "anthropics".into(), repo: "skills".into(), reference: Some("main".into()), path: "skills/pdf".into() }
        );
        let link = parse_link("https://github.com/o/r/blob/dev/a/b/SKILL.md").unwrap();
        assert_eq!((link.reference.as_deref(), link.path.as_str()), (Some("dev"), "a/b"));
        let link = parse_link("github.com/o/r.git").unwrap();
        assert_eq!((link.repo.as_str(), link.reference, link.path.as_str()), ("r", None, ""));
        assert_eq!(parse_link("o/r").unwrap().owner, "o");
        assert!(parse_link("https://github.com/o").is_err());
        assert!(parse_link("https://github.com/o/r/issues/3").is_err());
    }

    #[test]
    fn reads_frontmatter() {
        let text = "---\nname: pdf-tools\ndescription: \"Work with PDF files\"\n---\n# PDF\n";
        assert_eq!(frontmatter(text), (Some("pdf-tools".into()), Some("Work with PDF files".into())));
        let folded = "---\nname: x\ndescription: >\n  first line\n  second line\n---\n";
        assert_eq!(frontmatter(folded).1.as_deref(), Some("first line second line"));
        assert_eq!(frontmatter("# no header"), (None, None));
        assert_eq!(slug("My Skill!"), "my-skill");
        assert!(safe_relative("../evil").is_none() && safe_relative("scripts/run.py").is_some());
    }

    #[test]
    fn finds_skills_in_a_repo() {
        let files = |paths: &[&str]| paths.iter().map(|p| ((*p).to_owned(), 10)).collect();
        let repo = RepoFiles {
            link: parse_link("https://github.com/o/r/tree/main/skills").unwrap(),
            reference: "main".into(),
            files: files(&["README.md", "skills/a/SKILL.md", "skills/a/run.py", "skills/b/SKILL.md", "other/c/SKILL.md"]),
        };
        assert_eq!(skill_dirs(&repo), ["skills/a", "skills/b"]);
        assert_eq!(skill_files(&repo, "skills/a").len(), 2);
        assert_eq!(install_id(&repo, "skills/a", None), "a");
        assert_eq!(install_id(&repo, "skills/a", Some("Alpha Tools")), "alpha-tools");
    }
}

/// Sonde réseau : `cargo test --lib skills_live -- --ignored --nocapture`.
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn skills_live() {
        let github = GithubState::default();
        let found = inspect(&github, "https://github.com/anthropics/skills").await.unwrap();
        println!("REPO {} : {} skills", found.repo, found.candidates.len());
        for c in found.candidates.iter().take(5) {
            println!("  {} ({}) {} files — {:?}", c.id, c.dir, c.files, c.description.as_deref().map(|d| &d[..d.len().min(60)]));
        }
        let pdf = found.candidates.iter().find(|c| c.id == "pdf").expect("pdf skill");
        let project = std::env::temp_dir().join(format!("fast-skills-live-{}", std::process::id()));
        std::fs::create_dir_all(&project).unwrap();
        let ais: Vec<String> = AIS.iter().map(|a| (*a).to_owned()).collect();
        let link = "https://github.com/anthropics/skills/tree/main/skills/pdf";
        let single = inspect(&github, link).await.unwrap();
        println!("SINGLE {:?}", single.candidates.iter().map(|c| &c.id).collect::<Vec<_>>());
        let installed = install(&github, link, &[pdf.dir.clone()], Scope::Project, Some(&project), &ais).await.unwrap();
        println!("INSTALLED {installed:?}");
        for skill in list(Some(&project)).into_iter().filter(|s| s.scope == Scope::Project) {
            println!("LISTED {} {:?} {:?} source={:?}", skill.id, skill.ais, skill.path, skill.source);
        }
        for dir in [".claude/skills/pdf", ".agents/skills/pdf", ".gemini/skills/pdf"] {
            let count = walk(&project.join(dir));
            println!("{dir}: {count} files");
        }
        remove("pdf", Scope::Project, Some(&project)).unwrap();
        println!("AFTER REMOVE {}", list(Some(&project)).iter().filter(|s| s.scope == Scope::Project).count());
        let _ = std::fs::remove_dir_all(&project);
    }

    fn walk(dir: &Path) -> usize {
        std::fs::read_dir(dir).map(|e| e.flatten().map(|e| if e.path().is_dir() { walk(&e.path()) } else { 1 }).sum()).unwrap_or(0)
    }
}
