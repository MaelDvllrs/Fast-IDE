//! Dictée vocale sous macOS : pas encore branchée (SFSpeechRecognizer à venir).

use crate::error::{AppError, AppResult};
use crate::speech::SpeechEvent;

pub fn start(_emit: impl Fn(SpeechEvent) + Send + Sync + Clone + 'static) -> AppResult<()> {
    Err(AppError::msg("Voice input isn't available on macOS yet."))
}

pub fn stop() {}
