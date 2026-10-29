//! Pushes des agents : jamais sans l'accord explicite de l'utilisateur.
//!
//! Tout le travail de FAST reste local (commits, intégration sur la branche
//! principale) ; publier sur GitHub est une décision de l'utilisateur. Un agent
//! peut pourtant lancer `git push` lui-même — Codex le fait sans demander. FAST
//! installe donc dans le dépôt un hook `pre-push` : lancé depuis un agent (qui
//! reçoit `FAST_PUSH_APPROVAL_URL` dans son environnement), le push attend la
//! réponse de l'utilisateur, posée dans la conversation de l'agent. Les pushes
//! de l'utilisateur (bouton Push de FAST, terminal) n'ont pas cette variable et
//! ne sont pas concernés. (Un garde-fou contre les erreurs, pas une barrière de
//! sécurité : un agent qui retirerait la variable passerait.)

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};

use serde_json::json;
use tauri::{AppHandle, Runtime};
use tokio::sync::oneshot;

use super::Agent;
use crate::workspace::git;

/// Variable d'environnement des agents : adresse où le hook demande l'accord.
pub const ENV: &str = "FAST_PUSH_APPROVAL_URL";

/// Attente maximale d'une réponse (le hook abandonne aussi : push refusé).
const ANSWER_WAIT: Duration = Duration::from_secs(30 * 60);

/// Ligne qui reconnaît le hook de FAST (mis à jour sans toucher à un hook de l'utilisateur).
const MARKER: &str = "# FAST push approval";

const HOOK: &str = r#"#!/bin/sh
# FAST push approval
# A push started by a FAST agent waits for the user's approval in FAST.
# Pushes by the user (terminal, FAST's Push button) are not affected.
hooks=$(dirname "$0")
refs=$(cat)
if [ -n "$FAST_PUSH_APPROVAL_URL" ]; then
  answer=$(printf '%s\n%s\n%s\n' "$1" "$2" "$refs" | curl -s -m 1800 --data-binary @- "$FAST_PUSH_APPROVAL_URL")
  if [ "$answer" != "allow" ]; then
    echo "FAST: the user did not allow this push. Only push when the user explicitly asks for it." >&2
    exit 1
  fi
fi
# Hook pre-push du projet, s'il y en avait un avant FAST.
if [ -x "$hooks/pre-push.local" ]; then
  printf '%s\n' "$refs" | "$hooks/pre-push.local" "$@"
  exit $?
fi
exit 0
"#;

/// Projets où le hook est en place.
fn hooked() -> &'static Mutex<HashSet<PathBuf>> {
    static HOOKED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    HOOKED.get_or_init(Default::default)
}

/// Demandes en attente : identifiant → (session de l'agent, réponse).
fn pending() -> &'static Mutex<HashMap<String, (String, oneshot::Sender<bool>)>> {
    static PENDING: OnceLock<Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// Adresse d'accord d'un agent, d'après son adresse MCP (même jeton).
pub fn url(mcp_url: &str) -> String {
    mcp_url.replacen("/mcp/", "/push/", 1)
}

/// Installe le hook dans le dépôt `root` (worktrees compris : ils partagent ses hooks).
/// Un hook `pre-push` existant est gardé et appelé ensuite. Rien n'est installé si
/// les hooks sont versionnés dans le projet (Husky…) : ce serait modifier ses fichiers.
pub async fn install_hook(root: &Path) -> bool {
    let Ok(out) = git::run(root, &["rev-parse", "--git-path", "hooks"]).await else { return false };
    if !out.ok {
        return false;
    }
    let dir = root.join(out.stdout.trim());
    if dir.starts_with(root) && !dir.starts_with(root.join(".git")) {
        return false;
    }
    let hook = dir.join("pre-push");
    let installed = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        if let Ok(existing) = std::fs::read_to_string(&hook) {
            if !existing.contains(MARKER) {
                let local = dir.join("pre-push.local");
                if !local.exists() {
                    std::fs::rename(&hook, &local)?;
                }
            }
        }
        std::fs::write(&hook, HOOK)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    })()
    .is_ok();
    if installed {
        hooked().lock().unwrap().insert(root.to_path_buf());
    }
    installed
}

/// Le push de cet agent passe par l'accord de l'utilisateur.
pub fn guarded(root: &Path) -> bool {
    hooked().lock().unwrap().contains(root)
}

/// `refs/heads/main` → `main`.
fn short(reference: &str) -> &str {
    reference.strip_prefix("refs/heads/").or_else(|| reference.strip_prefix("refs/tags/")).unwrap_or(reference)
}

/// Demande du hook (`remote`, `url`, puis une ligne par référence poussée) :
/// posée dans la conversation de l'agent, attend la réponse de l'utilisateur.
pub(super) async fn request<R: Runtime>(app: &AppHandle<R>, agent: &Agent, body: &str) -> bool {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let mut lines = body.lines();
    let remote = lines.next().unwrap_or("origin").trim().to_owned();
    let url = lines.next().unwrap_or_default().trim().to_owned();
    // `<réf locale> <sha> <réf distante> <sha>` ; une suppression a `(delete)` en local.
    let refs: Vec<String> = lines
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            match parts.as_slice() {
                ["(delete)", _, remote_ref, _] => Some(format!("delete {}", short(remote_ref))),
                [local, _, remote_ref, _] if short(local) == short(remote_ref) => Some(short(local).to_owned()),
                [local, _, remote_ref, _] => Some(format!("{} → {}", short(local), short(remote_ref))),
                _ => None,
            }
        })
        .collect();

    let id = format!("fast-push-{}", NEXT.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = oneshot::channel();
    pending().lock().unwrap().insert(id.clone(), (agent.session.clone(), tx));
    crate::claude::emit_message(
        app,
        &agent.session,
        json!({
            "type": "control_request",
            "request_id": id,
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "GitPush",
                "input": {
                    "remote": remote,
                    "url": url,
                    "refs": refs,
                    "command": format!("git push {remote} {}", refs.join(" ")).trim().to_owned(),
                },
            },
        }),
    );
    let allowed = matches!(tokio::time::timeout(ANSWER_WAIT, rx).await, Ok(Ok(true)));
    pending().lock().unwrap().remove(&id);
    allowed
}

/// Réponse de l'utilisateur. `false` si la demande n'est pas un push (autre autorisation).
pub fn answer(request_id: &str, allow: bool) -> bool {
    if !request_id.starts_with("fast-push-") {
        return false;
    }
    if let Some((_, tx)) = pending().lock().unwrap().remove(request_id) {
        let _ = tx.send(allow);
    }
    true
}

/// Fin du tour ou de la session : les pushes en attente de cet agent sont refusés.
pub fn deny_session(session: &str) {
    pending().lock().unwrap().retain(|_, (s, _)| s != session);
}

/// Commande de shell qui n'est qu'un `git push` (sans autre commande enchaînée).
pub fn is_plain_push(command: &str) -> bool {
    let command = command.trim();
    let words: Vec<&str> = command.split_whitespace().collect();
    words.len() >= 2 && words[0] == "git" && words[1] == "push" && !command.contains(['&', ';', '|', '`', '$', '>', '<', '\n'])
}

#[cfg(test)]
mod tests {
    use super::{guarded, hooked, install_hook, is_plain_push, short, MARKER};

    /// Hook pre-push que le projet avait avant FAST.
    const PROJECT_HOOK: &str = "#!/bin/sh\nexit 0\n";

    #[tokio::test]
    async fn installs_the_hook_and_keeps_the_project_one() {
        let dir = std::env::temp_dir().join(format!("fast-push-hook-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::workspace::git::run(&dir, &["init", "-q"]).await.unwrap();
        let hooks = dir.join(".git").join("hooks");
        std::fs::write(hooks.join("pre-push"), PROJECT_HOOK).unwrap();

        assert!(install_hook(&dir).await && guarded(&dir));
        assert!(std::fs::read_to_string(hooks.join("pre-push")).unwrap().contains(MARKER));
        assert_eq!(std::fs::read_to_string(hooks.join("pre-push.local")).unwrap(), PROJECT_HOOK);
        // Réinstallation (nouveau lancement) : le hook du projet n'est pas écrasé.
        assert!(install_hook(&dir).await);
        assert_eq!(std::fs::read_to_string(hooks.join("pre-push.local")).unwrap(), PROJECT_HOOK);

        // Hooks versionnés dans le projet (Husky) : on n'y touche pas.
        crate::workspace::git::run(&dir, &["config", "core.hooksPath", ".husky"]).await.unwrap();
        hooked().lock().unwrap().clear();
        assert!(!install_hook(&dir).await && !guarded(&dir));
        assert!(!dir.join(".husky").join("pre-push").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recognizes_plain_pushes() {
        assert!(is_plain_push("git push"));
        assert!(is_plain_push("git push -u origin fast/agent-2"));
        assert!(!is_plain_push("git push && rm -rf build"));
        assert!(!is_plain_push("git pull"));
        assert_eq!(short("refs/heads/main"), "main");
    }
}
