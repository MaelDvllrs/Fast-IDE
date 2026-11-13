//! Messages entre les agents d'un projet.
//!
//! Un agent écrit à un autre (`send_message`) ou annonce un travail partagé
//! (`share_work`, envoyé une fois ce travail sur la branche principale, voir
//! `orchestrator::share_work`). FAST ne l'interrompt jamais : le message
//! s'affiche dans la conversation du destinataire et lui est transmis avec la
//! prochaine demande de l'utilisateur, après la mise à jour de son worktree.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::workspace::{self, AgentEntry, WorkspaceState};

pub const EVENT: &str = "team://message";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Message,
    /// Travail partagé, déjà sur la branche principale.
    Share,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamMessage {
    id: String,
    to_agent_id: String,
    from_agent_id: String,
    from_name: String,
    kind: Kind,
    text: String,
    at: u64,
}

/// Destinataires : tous les autres agents du projet, ou certains, par nom.
pub enum Recipients {
    All,
    Names(Vec<String>),
}

impl Recipients {
    /// `"all"`, `"Nova"` ou `"Nova, Atlas"`.
    pub fn parse(to: &str) -> Self {
        let names: Vec<String> = to.split(',').map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()).collect();
        if names.is_empty() || names.iter().any(|n| n.eq_ignore_ascii_case("all") || n.eq_ignore_ascii_case("everyone")) {
            Recipients::All
        } else {
            Recipients::Names(names)
        }
    }
}

/// Envoie `text` de l'agent `from_id` à ses coéquipiers. Rend les noms des
/// destinataires, ou les noms inconnus (et ceux qui existent) en erreur.
pub fn send<R: Runtime>(app: &AppHandle<R>, root: &Path, from_id: &str, to: &Recipients, kind: Kind, text: &str) -> Result<Vec<String>, String> {
    let state = app.state::<WorkspaceState>();
    let from = workspace::entry(&state, from_id).map(|e| e.name).unwrap_or_else(|| "An agent".into());
    let team: Vec<(String, AgentEntry)> = workspace::agents_in(&state, root).into_iter().filter(|(id, _)| id != from_id).collect();
    let recipients: Vec<&(String, AgentEntry)> = match to {
        Recipients::All => team.iter().collect(),
        Recipients::Names(names) => {
            let unknown: Vec<&String> = names.iter().filter(|n| !team.iter().any(|(_, e)| e.name.eq_ignore_ascii_case(n))).collect();
            if !unknown.is_empty() {
                let known: Vec<&str> = team.iter().map(|(_, e)| e.name.as_str()).collect();
                return Err(format!(
                    "no teammate named {}. Your teammates: {}.",
                    unknown.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(", "),
                    if known.is_empty() { "none (you are the only agent)".to_owned() } else { known.join(", ") }
                ));
            }
            team.iter().filter(|(_, e)| names.iter().any(|n| e.name.eq_ignore_ascii_case(n))).collect()
        }
    };
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default();
    for (to_id, _) in &recipients {
        let message = TeamMessage {
            id: format!("team-{from_id}-{to_id}-{at}"),
            to_agent_id: to_id.clone(),
            from_agent_id: from_id.to_owned(),
            from_name: from.clone(),
            kind,
            text: text.to_owned(),
            at,
        };
        let _ = app.emit(EVENT, message);
    }
    Ok(recipients.iter().map(|(_, e)| e.name.clone()).collect())
}

#[cfg(test)]
mod tests {
    use super::Recipients;

    #[test]
    fn parses_recipients() {
        assert!(matches!(Recipients::parse("all"), Recipients::All));
        assert!(matches!(Recipients::parse(""), Recipients::All));
        match Recipients::parse("Nova, atlas") {
            Recipients::Names(names) => assert_eq!(names, ["Nova", "atlas"]),
            Recipients::All => panic!("expected names"),
        }
    }
}
