//! Commandes des opérations planifiées : trouvées dans le projet de l'agent
//! (scripts de package.json, outils détectés), et reconnaissance des mêmes
//! opérations lancées directement dans le shell par un agent (refusées).

use std::path::Path;

use super::Kind;
use crate::{
    error::{AppError, AppResult},
    workspace::run::{self, package_manager, read_json},
};

/// Scripts de package.json essayés pour chaque opération, dans cet ordre.
fn scripts_for(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Typecheck => &["typecheck", "type-check", "check-types", "tsc"],
        Kind::Lint => &["lint"],
        Kind::Test => &["test:unit", "test"],
        Kind::IntegrationTest => &["test:integration", "test:int", "integration"],
        Kind::E2e => &["test:e2e", "e2e", "test:playwright", "playwright"],
        Kind::Build => &["build"],
        Kind::Preview => &["dev", "start", "serve", "preview"],
    }
}

/// Outil lancé sans script, d'après les fichiers du projet.
fn tool_for(kind: Kind, dir: &Path) -> Option<&'static str> {
    let has = |names: &[&str]| names.iter().any(|n| dir.join(n).is_file());
    let cargo = has(&["Cargo.toml"]);
    match kind {
        Kind::Typecheck if has(&["tsconfig.json"]) => Some("npx tsc --noEmit"),
        Kind::Typecheck if cargo => Some("cargo check"),
        Kind::Lint if has(&["eslint.config.js", "eslint.config.mjs", "eslint.config.ts", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs"]) => {
            Some("npx eslint .")
        }
        Kind::Lint if cargo => Some("cargo clippy"),
        Kind::Test if cargo => Some("cargo test"),
        Kind::Test if has(&["pytest.ini", "pyproject.toml"]) => Some("python -m pytest"),
        Kind::E2e if has(&["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]) => Some("npx playwright test"),
        Kind::E2e if has(&["cypress.config.ts", "cypress.config.js"]) => Some("npx cypress run"),
        Kind::Build if cargo => Some("cargo build"),
        _ => None,
    }
}

/// Arguments ajoutés par l'agent (fichier de test, filtre…) : sans caractère
/// de shell, ils ne peuvent pas lancer une autre commande.
fn check_args(args: &str) -> AppResult<()> {
    let allowed = |c: char| c.is_alphanumeric() || " _-./\\:=@,+*#~[]".contains(c);
    match args.chars().find(|&c| !allowed(c)) {
        Some(c) => Err(AppError::msg(format!("`args` may not contain `{c}`: pass file names, filters and flags only"))),
        None => Ok(()),
    }
}

/// Commande d'une opération dans `dir` : le script demandé (s'il existe), sinon
/// le premier script connu, sinon l'outil détecté ; `args` est ajouté à la fin.
pub fn resolve(kind: Kind, dir: &Path, script: Option<&str>, args: Option<&str>) -> AppResult<String> {
    let args = args.map(str::trim).filter(|a| !a.is_empty());
    if let Some(args) = args {
        check_args(args)?;
    }
    let scripts = read_json(&dir.join("package.json"))
        .and_then(|pkg| pkg["scripts"].as_object().map(|s| s.keys().cloned().collect::<Vec<_>>()))
        .unwrap_or_default();
    let pm = package_manager(dir);
    let run_script = |name: &str| {
        let base = if pm == "npm" { format!("npm run {name}") } else { format!("{pm} {name}") };
        match args {
            // npm transmet les arguments au script après `--`.
            Some(args) if pm == "npm" => format!("{base} -- {args}"),
            Some(args) => format!("{base} {args}"),
            None => base,
        }
    };

    if let Some(name) = script.map(str::trim).filter(|s| !s.is_empty()) {
        return if scripts.iter().any(|s| s == name) {
            Ok(run_script(name))
        } else {
            Err(AppError::msg(format!("package.json has no `{name}` script (available: {})", scripts.join(", "))))
        };
    }
    if let Some(name) = scripts_for(kind).iter().find(|n| scripts.iter().any(|s| s == *n)) {
        return Ok(run_script(name));
    }
    let tool = match kind {
        // Serveur de dev : même détection que le bouton Run (Next, Vite, Django…).
        Kind::Preview => run::candidates(dir).into_iter().next().map(|c| c.command),
        _ => tool_for(kind, dir).map(str::to_owned),
    };
    match tool {
        Some(tool) => Ok(match args {
            Some(args) => format!("{tool} {args}"),
            None => tool,
        }),
        None => Err(AppError::msg(format!(
            "no {} command found in this project; pass `script` with a package.json script name",
            kind.label()
        ))),
    }
}

/// Opération planifiée qu'une commande de shell lancerait (`npm run dev`, `tsc`…).
/// `None` : commande ordinaire, laissée à l'agent.
pub fn classify(command: &str) -> Option<Kind> {
    let line = command.to_lowercase();
    if line.contains("--version") || line.contains("--help") || line.contains(" -v ") {
        return None;
    }
    // Chaque commande d'un enchaînement (`a && b`, `a; b`, `a | b`).
    let parts = line.split(|c| c == '&' || c == ';' || c == '|' || c == '\n');
    let mut found: Option<Kind> = None;
    for part in parts {
        let words: Vec<&str> = part.split_whitespace().map(|w| w.trim_matches(|c| c == '"' || c == '\'')).collect();
        if let Some(kind) = classify_words(&words) {
            // La plus lourde l'emporte (un serveur plutôt qu'une vérification).
            found = Some(match found {
                Some(prev) if prev.weight() >= kind.weight() => prev,
                _ => kind,
            });
        }
    }
    found
}

fn classify_words(words: &[&str]) -> Option<Kind> {
    let has = |w: &str| words.contains(&w);
    let pair = |a: &str, b: &str| words.windows(2).any(|p| p[0] == a && p[1] == b);
    // Script lancé par un gestionnaire de paquets : `npm run dev`, `pnpm dev`, `yarn test`…
    let script = words.windows(2).find_map(|p| match p[0] {
        "npm" | "pnpm" | "yarn" | "bun" => Some(p[1]),
        _ => None,
    });
    let script = match script {
        Some("run") | Some("run-script") => words.iter().skip_while(|w| **w != "run" && **w != "run-script").nth(1).copied(),
        other => other,
    };
    if let Some(name) = script {
        let kind = match name {
            "dev" | "start" | "serve" | "preview" => Some(Kind::Preview),
            "build" => Some(Kind::Build),
            "lint" => Some(Kind::Lint),
            "typecheck" | "type-check" | "check-types" | "tsc" => Some(Kind::Typecheck),
            "test:e2e" | "e2e" | "test:playwright" => Some(Kind::E2e),
            "test:integration" | "test:int" => Some(Kind::IntegrationTest),
            "test" | "test:unit" | "t" => Some(Kind::Test),
            _ => None,
        };
        if kind.is_some() {
            return kind;
        }
    }
    if pair("next", "dev") || pair("astro", "dev") || pair("nuxt", "dev") || pair("webpack", "serve") || pair("remix", "dev") {
        return Some(Kind::Preview);
    }
    if pair("next", "build") || pair("vite", "build") || pair("astro", "build") || pair("nuxt", "build") {
        return Some(Kind::Build);
    }
    if pair("next", "lint") || has("eslint") {
        return Some(Kind::Lint);
    }
    if pair("playwright", "test") || pair("cypress", "run") {
        return Some(Kind::E2e);
    }
    if has("vitest") || has("jest") || has("mocha") {
        return Some(Kind::Test);
    }
    if has("tsc") || has("vue-tsc") {
        return Some(Kind::Typecheck);
    }
    // `vite` seul (ou `vite dev`) lance le serveur de dev.
    if has("vite") {
        return Some(Kind::Preview);
    }
    if has("cargo") {
        return match words.iter().skip_while(|w| **w != "cargo").nth(1).copied() {
            Some("check") => Some(Kind::Typecheck),
            Some("clippy") => Some(Kind::Lint),
            Some("test") => Some(Kind::Test),
            Some("build") => Some(Kind::Build),
            _ => None,
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{classify, resolve, Kind};

    #[test]
    fn classifies_shell_commands() {
        assert_eq!(classify("npm run dev"), Some(Kind::Preview));
        assert_eq!(classify("cd web && pnpm dev"), Some(Kind::Preview));
        assert_eq!(classify("npx next dev -p 3001"), Some(Kind::Preview));
        assert_eq!(classify("npx tsc --noEmit"), Some(Kind::Typecheck));
        assert_eq!(classify("npx eslint src"), Some(Kind::Lint));
        assert_eq!(classify("npx vitest run src/a.test.ts"), Some(Kind::Test));
        assert_eq!(classify("yarn test"), Some(Kind::Test));
        assert_eq!(classify("npm run build && npm start"), Some(Kind::Preview));
        assert_eq!(classify("npx playwright test"), Some(Kind::E2e));
        assert_eq!(classify("next build"), Some(Kind::Build));
        assert_eq!(classify("cargo test --lib"), Some(Kind::Test));
        assert_eq!(classify("npx tsc --version"), None);
        assert_eq!(classify("npm install zod"), None);
        assert_eq!(classify("git status"), None);
        assert_eq!(classify("ls src/components"), None);
    }

    #[test]
    fn resolves_project_commands() {
        let dir = std::env::temp_dir().join(format!("fast-scheduler-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"next dev","test":"vitest run","lint":"next lint"}}"#).unwrap();
        std::fs::write(dir.join("tsconfig.json"), "{}").unwrap();

        assert_eq!(resolve(Kind::Preview, &dir, None, None).unwrap(), "npm run dev");
        assert_eq!(resolve(Kind::Test, &dir, None, Some("src/a.test.ts")).unwrap(), "npm run test -- src/a.test.ts");
        assert_eq!(resolve(Kind::Typecheck, &dir, None, None).unwrap(), "npx tsc --noEmit");
        assert_eq!(resolve(Kind::Lint, &dir, Some("lint"), None).unwrap(), "npm run lint");
        assert!(resolve(Kind::Test, &dir, None, Some("a && rm -rf /")).is_err());
        assert!(resolve(Kind::Build, &dir, None, None).is_err());
        assert!(resolve(Kind::Lint, &dir, Some("nope"), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
