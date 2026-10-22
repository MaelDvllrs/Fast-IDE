//! Commande pour lancer le projet (bouton Run de la barre du haut) : détectée
//! d'après les fichiers du projet, ou choisie et gardée dans `.fast/config.json`.

use std::path::Path;

use serde::Serialize;

use super::build::{load_config, save_config};
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCandidate {
    /// Libellé court affiché dans le bouton (ex. « dev », « cargo run »).
    pub label: String,
    pub command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOptions {
    /// Commande choisie pour ce projet ; à défaut, la première détectée.
    pub selected: Option<String>,
    pub candidates: Vec<RunCandidate>,
}

/// Scripts npm lancés de préférence, dans cet ordre.
const PREFERRED_SCRIPTS: &[&str] = &["dev", "start", "serve", "preview", "watch"];

#[cfg(target_os = "windows")]
const PYTHON: &str = "python";
#[cfg(not(target_os = "windows"))]
const PYTHON: &str = "python3";

fn candidate(label: impl Into<String>, command: impl Into<String>) -> RunCandidate {
    RunCandidate { label: label.into(), command: command.into() }
}

/// Gestionnaire de paquets JavaScript d'après le fichier de verrouillage.
fn package_manager(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if root.join("yarn.lock").is_file() {
        "yarn"
    } else if root.join("bun.lockb").is_file() || root.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Commandes possibles pour lancer le projet, la plus probable en premier.
pub fn candidates(root: &Path) -> Vec<RunCandidate> {
    let mut list = Vec::new();

    // JavaScript / TypeScript : scripts de package.json.
    if let Some(pkg) = read_json(&root.join("package.json")) {
        if let Some(scripts) = pkg["scripts"].as_object() {
            let pm = package_manager(root);
            let run = |name: &str| if pm == "npm" { format!("npm run {name}") } else { format!("{pm} {name}") };
            // Application Tauri : « tauri dev » lance l'app complète (Rust + interface).
            if scripts.contains_key("tauri") && root.join("src-tauri").is_dir() {
                list.push(candidate("tauri dev", format!("{} dev", run("tauri"))));
            }
            let mut names: Vec<&String> = scripts.keys().collect();
            names.sort_by_key(|name| PREFERRED_SCRIPTS.iter().position(|p| p == name).unwrap_or(usize::MAX));
            for name in names {
                // Scripts de cycle de vie npm : jamais lancés à la main.
                if name.starts_with("pre") || name.starts_with("post") || name == "tauri" {
                    continue;
                }
                list.push(candidate(name.as_str(), run(name)));
            }
        }
    }
    if let Some(deno) = read_json(&root.join("deno.json")).or_else(|| read_json(&root.join("deno.jsonc"))) {
        if let Some(tasks) = deno["tasks"].as_object() {
            for name in tasks.keys() {
                list.push(candidate(format!("deno {name}"), format!("deno task {name}")));
            }
        }
    }

    if root.join("Cargo.toml").is_file() {
        list.push(candidate("cargo run", "cargo run"));
    }
    if root.join("go.mod").is_file() {
        list.push(candidate("go run", "go run ."));
    }
    if root.join("manage.py").is_file() {
        list.push(candidate("runserver", format!("{PYTHON} manage.py runserver")));
    }
    for file in ["main.py", "app.py"] {
        if root.join(file).is_file() {
            list.push(candidate(file, format!("{PYTHON} {file}")));
        }
    }
    if root.join("artisan").is_file() {
        list.push(candidate("artisan serve", "php artisan serve"));
    }
    if root.join("bin").join("rails").is_file() {
        list.push(candidate("rails server", "bin/rails server"));
    }
    if root.join("pubspec.yaml").is_file() {
        list.push(candidate("flutter run", "flutter run"));
    }
    let has_csproj = std::fs::read_dir(root).ok().is_some_and(|entries| {
        entries.flatten().any(|e| e.path().extension().is_some_and(|ext| ext == "csproj" || ext == "fsproj"))
    });
    if has_csproj {
        list.push(candidate("dotnet run", "dotnet run"));
    }
    if root.join("gradlew").is_file() {
        let gradle = if cfg!(target_os = "windows") { "gradlew.bat run" } else { "./gradlew run" };
        list.push(candidate("gradle run", gradle));
    }
    let makefile_run = std::fs::read_to_string(root.join("Makefile"))
        .is_ok_and(|text| text.lines().any(|line| line.starts_with("run:")));
    if makefile_run {
        list.push(candidate("make run", "make run"));
    }
    if ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
        .iter()
        .any(|f| root.join(f).is_file())
    {
        list.push(candidate("compose up", "docker compose up"));
    }
    list
}

pub fn options(root: &Path) -> RunOptions {
    let candidates = candidates(root);
    let selected = load_config(root)
        .run_command
        .filter(|c| !c.trim().is_empty())
        .or_else(|| candidates.first().map(|c| c.command.clone()));
    RunOptions { selected, candidates }
}

/// Garde la commande choisie pour ce projet ; `None` revient à la détection.
pub fn set(root: &Path, command: Option<String>) -> AppResult<()> {
    let mut config = load_config(root);
    config.run_command = command.filter(|c| !c.trim().is_empty());
    save_config(root, &config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_scripts_and_tools() {
        let dir = std::env::temp_dir().join(format!("fast-run-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src-tauri")).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"build":"vite build","prebuild":"x","dev":"vite","tauri":"tauri","start":"node ."}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        std::fs::write(dir.join("Cargo.toml"), "").unwrap();

        let commands: Vec<String> = candidates(&dir).into_iter().map(|c| c.command).collect();
        assert_eq!(commands, ["pnpm tauri dev", "pnpm dev", "pnpm start", "pnpm build", "cargo run"]);

        assert_eq!(options(&dir).selected.as_deref(), Some("pnpm tauri dev"));
        set(&dir, Some("pnpm start".into())).unwrap();
        assert_eq!(options(&dir).selected.as_deref(), Some("pnpm start"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
