//! Dépendances JavaScript des dossiers de travail (projet, worktree d'intégration).
//!
//! Un agent qui installe un paquet le fait dans son worktree : npm y remplace le
//! lien vers le `node_modules` du projet par un dossier à lui, et ni le projet ni
//! le worktree d'intégration n'ont le paquet. Le build d'intégration échouait
//! donc, et rien ne l'installait ensuite dans le projet. L'orchestrateur installe
//! désormais lui-même les dépendances quand `package.json` ou le lockfile ont
//! changé depuis la dernière installation du dossier (voir `orchestrator.rs`).

use std::{
    hash::{DefaultHasher, Hash, Hasher},
    path::{Path, PathBuf},
};

use super::{build, run::package_manager};
use crate::error::AppResult;

/// Fichiers qui décrivent les dépendances (à la racine du dossier).
const FILES: &[&str] = &["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

/// Empreinte des fichiers de dépendances de `dir` ; `None` sans `package.json`.
pub fn fingerprint(dir: &Path) -> Option<u64> {
    if !dir.join("package.json").is_file() {
        return None;
    }
    let mut hasher = DefaultHasher::new();
    for file in FILES {
        file.hash(&mut hasher);
        std::fs::read(dir.join(file)).unwrap_or_default().hash(&mut hasher);
    }
    Some(hasher.finish())
}

/// Commande d'installation, d'après le lockfile du dossier.
pub fn install_command(dir: &Path) -> String {
    match package_manager(dir) {
        "npm" => "npm install --no-audit --no-fund".to_owned(),
        pm => format!("{pm} install"),
    }
}

/// Empreinte des dépendances lors de la dernière installation dans le worktree
/// d'intégration (`.fast/integration-deps`).
fn stamp_path(root: &Path) -> PathBuf {
    root.join(".fast").join("integration-deps")
}

fn read_stamp(root: &Path) -> Option<u64> {
    std::fs::read_to_string(stamp_path(root)).ok()?.trim().parse().ok()
}

fn write_stamp(root: &Path, fingerprint: u64) {
    let _ = std::fs::write(stamp_path(root), fingerprint.to_string());
}

/// Installation nécessaire dans le worktree d'intégration ? Sans installation
/// connue, il utilise le `node_modules` du projet : installé pour les fichiers du projet.
pub fn integration_needs_install(root: &Path, integration: &Path) -> Option<String> {
    let current = fingerprint(integration)?;
    let installed = read_stamp(root).or_else(|| fingerprint(root));
    (installed != Some(current)).then(|| install_command(integration))
}

/// Installe les dépendances dans `dir` ; rend (réussite, fin de la sortie).
pub async fn install(dir: &Path, command: &str) -> AppResult<(bool, String)> {
    build::run(dir, command).await
}

/// Installation réussie dans le worktree d'intégration : mémorisée.
pub fn integration_installed(root: &Path, integration: &Path) {
    if let Some(fingerprint) = fingerprint(integration) {
        write_stamp(root, fingerprint);
    }
}

/// Worktree d'un agent remis sur la branche principale : s'il avait son propre
/// `node_modules` (paquet installé par l'agent), il retrouve celui du projet,
/// qui a désormais les mêmes dépendances. Rend `true` si le lien est refait.
pub fn relink_shared(root: &Path, dir: &Path) -> bool {
    let (shared, own) = (root.join("node_modules"), dir.join("node_modules"));
    // Un lien (jonction, lien symbolique) n'est jamais parcouru ni vidé.
    let is_own_dir = std::fs::symlink_metadata(&own).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink());
    if !is_own_dir || !shared.is_dir() || fingerprint(dir).is_none() || fingerprint(dir) != fingerprint(root) {
        return false;
    }
    std::fs::remove_dir_all(&own).is_ok() && crate::platform::link_dir(&shared, &own).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_dependency_changes() {
        let base = std::env::temp_dir().join(format!("fast-deps-{}", std::process::id()));
        let (root, integration) = (base.join("project"), base.join("project").join(".fast").join("integration"));
        std::fs::create_dir_all(&integration).unwrap();
        std::fs::write(root.join("package.json"), r#"{"dependencies":{"react":"19"}}"#).unwrap();
        std::fs::write(integration.join("package.json"), r#"{"dependencies":{"react":"19"}}"#).unwrap();

        // Mêmes dépendances que le projet : le node_modules partagé suffit.
        assert_eq!(integration_needs_install(&root, &integration), None);
        // Un agent a ajouté un framework : installation, avec le gestionnaire du projet.
        std::fs::write(integration.join("package.json"), r#"{"dependencies":{"react":"19","next":"16"}}"#).unwrap();
        std::fs::write(integration.join("pnpm-lock.yaml"), "lock").unwrap();
        assert_eq!(integration_needs_install(&root, &integration).as_deref(), Some("pnpm install"));
        // Installée : plus rien à faire tant que les fichiers ne changent pas.
        integration_installed(&root, &integration);
        assert_eq!(integration_needs_install(&root, &integration), None);
        // Sans package.json : rien à installer.
        assert_eq!(fingerprint(&base), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}

/// Scénario réel (git + npm, réseau) : `cargo test --lib deps_live -- --ignored --nocapture`.
/// Un agent installe un paquet dans son worktree ; l'intégration doit builder, le
/// projet recevoir le paquet, et le worktree retrouver le node_modules du projet.
#[cfg(test)]
mod live {
    use super::*;
    use crate::workspace::git;

    async fn sh(dir: &Path, command: &str) -> bool {
        let (ok, output) = build::run(dir, command).await.unwrap();
        if !ok {
            println!("FAILED `{command}`:\n{output}");
        }
        ok
    }

    #[tokio::test]
    #[ignore]
    async fn deps_live() {
        let base = std::env::temp_dir().join(format!("fast-deps-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        // Le build échoue tant que le paquet `ms` n'est pas installé.
        std::fs::write(root.join("package.json"), r#"{"name":"p","version":"1.0.0","scripts":{"build":"node -e \"require('ms')\""}}"#).unwrap();
        assert!(sh(&root, "npm install --no-audit --no-fund").await);
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@t"], &["config", "user.name", "t"], &["add", "-A"], &["commit", "-qm", "init"]] {
            git::run(&root, args).await.unwrap();
        }
        std::fs::write(root.join(".gitignore"), "node_modules\n.fast\n").unwrap();
        git::run(&root, &["add", "-A"]).await.unwrap();
        git::run(&root, &["commit", "-qm", "ignore"]).await.unwrap();

        // Worktree de l'agent, node_modules relié au projet ; l'agent installe `ms`.
        let wt = root.join(".fast").join("worktrees").join("agent-2");
        git::run(&root, &["worktree", "add", "-q", "-b", "fast/agent-2", &wt.to_string_lossy(), "HEAD"]).await.unwrap();
        crate::platform::link_dir(&root.join("node_modules"), &wt.join("node_modules")).unwrap();
        assert!(sh(&wt, "npm install --no-audit --no-fund ms@2").await);
        let replaced = !std::fs::symlink_metadata(wt.join("node_modules")).unwrap().file_type().is_symlink();
        println!("agent worktree: npm replaced the link with its own node_modules: {replaced}");
        git::run(&wt, &["add", "-A"]).await.unwrap();
        git::run(&wt, &["commit", "-qm", "add ms"]).await.unwrap();

        // Intégration : node_modules du projet, fusion de la branche de l'agent.
        let integration = root.join(".fast").join("integration");
        git::run(&root, &["worktree", "add", "-q", "-b", "fast/integration", &integration.to_string_lossy(), "HEAD"]).await.unwrap();
        crate::platform::link_dir(&root.join("node_modules"), &integration.join("node_modules")).unwrap();
        git::run(&integration, &["merge", "-q", "--no-edit", "fast/agent-2"]).await.unwrap();
        println!("integration build BEFORE install (the old behaviour): {}", sh(&integration, "npm run build").await);
        let command = integration_needs_install(&root, &integration);
        println!("install needed in integration: {command:?}");
        assert!(sh(&integration, &command.unwrap()).await);
        integration_installed(&root, &integration);
        println!("integration build AFTER install: {}", sh(&integration, "npm run build").await);
        assert_eq!(integration_needs_install(&root, &integration), None);

        // La branche principale avance : dépendances changées → installation dans le projet.
        let before = fingerprint(&root);
        git::run(&root, &["merge", "-q", "--ff-only", "fast/integration"]).await.unwrap();
        println!("project dependencies changed by the merge: {}", fingerprint(&root) != before);
        assert!(sh(&root, &install_command(&root)).await);
        println!("project build: {}", sh(&root, "npm run build").await);

        // Worktree de l'agent remis à jour : il retrouve le node_modules du projet.
        git::run(&wt, &["merge", "-q", "--ff-only", "main"]).await.unwrap();
        println!("agent worktree relinked to the project's node_modules: {}", relink_shared(&root, &wt));
        println!("agent worktree build: {}", sh(&wt, "npm run build").await);
        println!("project node_modules intact: {}", root.join("node_modules").join("ms").is_dir());

        // Nettoyage : les liens d'abord, jamais à travers eux.
        for dir in [&wt, &integration] {
            let link = dir.join("node_modules");
            if std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink()) {
                crate::platform::unlink_dir(&link).unwrap();
            }
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
