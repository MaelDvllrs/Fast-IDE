//! Dictée vocale pour le champ de saisie des agents : la reconnaissance du
//! système (voir `platform`), relayée à l'interface par l'événement `speech://event`.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::{error::AppResult, platform};

pub const EVENT: &str = "speech://event";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum SpeechEvent {
    /// Texte provisoire de la phrase en cours (remplacé au fil de la parole).
    Partial(String),
    /// Phrase reconnue, définitive.
    Final(String),
    /// Fin de la reconnaissance, avec un message si elle s'est arrêtée sur une erreur.
    End(Option<String>),
}

pub fn start(app: AppHandle) -> AppResult<()> {
    platform::speech_start(move |event| {
        let _ = app.emit(EVENT, event);
    })
}

pub fn stop() {
    platform::speech_stop();
}
