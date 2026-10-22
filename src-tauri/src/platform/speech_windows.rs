//! Dictée vocale sous Windows : `Windows.Media.SpeechRecognition` en
//! reconnaissance continue, dans la langue de reconnaissance vocale du système.
//! Les hypothèses (texte provisoire) et les phrases reconnues sont envoyées à
//! l'interface au fil de l'eau.

use std::sync::Mutex;

use windows::{
    core::HRESULT,
    Foundation::TypedEventHandler,
    Media::SpeechRecognition::{
        SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
        SpeechContinuousRecognitionSession, SpeechRecognitionHypothesisGeneratedEventArgs,
        SpeechRecognitionResultStatus, SpeechRecognizer,
    },
};

use crate::error::{AppError, AppResult};
use crate::speech::SpeechEvent;

/// Reconnaissance en cours (une seule à la fois pour toute l'app).
static ACTIVE: Mutex<Option<SpeechRecognizer>> = Mutex::new(None);

/// Refus de la politique de confidentialité de la reconnaissance vocale.
const PRIVACY_POLICY_NOT_ACCEPTED: HRESULT = HRESULT(0x8004_5509_u32 as i32);
const ACCESS_DENIED: HRESULT = HRESULT(0x8007_0005_u32 as i32);

/// Message lisible pour les erreurs courantes (réglages de confidentialité de Windows).
fn explain(err: windows::core::Error) -> AppError {
    let hint = match err.code() {
        PRIVACY_POLICY_NOT_ACCEPTED => {
            "Turn on \"Online speech recognition\" in Windows Settings → Privacy & security → Speech.".to_owned()
        }
        ACCESS_DENIED => {
            "Allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.".to_owned()
        }
        _ => format!("Voice input failed: {}", err.message()),
    };
    AppError::msg(hint)
}

pub fn start(emit: impl Fn(SpeechEvent) + Send + Sync + Clone + 'static) -> AppResult<()> {
    stop();
    let recognizer = SpeechRecognizer::new().map_err(explain)?;
    // Sans contrainte ajoutée : la grammaire de dictée prédéfinie.
    let compiled = recognizer.CompileConstraintsAsync().map_err(explain)?.join().map_err(explain)?;
    if compiled.Status().map_err(explain)? != SpeechRecognitionResultStatus::Success {
        return Err(AppError::msg("Voice input isn't available for the speech language set in Windows."));
    }

    let on_hypothesis = emit.clone();
    recognizer
        .HypothesisGenerated(&TypedEventHandler::<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>::new(
            move |_, args| {
                if let Some(args) = args.as_ref() {
                    on_hypothesis(SpeechEvent::Partial(args.Hypothesis()?.Text()?.to_string_lossy()));
                }
                Ok(())
            },
        ))
        .map_err(explain)?;

    let session = recognizer.ContinuousRecognitionSession().map_err(explain)?;
    let on_result = emit.clone();
    session
        .ResultGenerated(&TypedEventHandler::<
            SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionResultGeneratedEventArgs,
        >::new(move |_, args| {
            if let Some(args) = args.as_ref() {
                let text = args.Result()?.Text()?.to_string_lossy();
                if !text.trim().is_empty() {
                    on_result(SpeechEvent::Final(text));
                }
            }
            Ok(())
        }))
        .map_err(explain)?;

    let on_end = emit;
    session
        .Completed(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionCompletedEventArgs>::new(
            move |_, args| {
                let status = args.as_ref().and_then(|a| a.Status().ok());
                let error = match status {
                    Some(SpeechRecognitionResultStatus::Success) | Some(SpeechRecognitionResultStatus::UserCanceled) | None => None,
                    Some(SpeechRecognitionResultStatus::MicrophoneUnavailable) => Some("No microphone is available.".to_owned()),
                    Some(SpeechRecognitionResultStatus::TimeoutExceeded) => None,
                    Some(other) => Some(format!("Voice input stopped ({other:?}).")),
                };
                on_end(SpeechEvent::End(error));
                Ok(())
            },
        ))
        .map_err(explain)?;

    session.StartAsync().map_err(explain)?.join().map_err(explain)?;
    *ACTIVE.lock().unwrap() = Some(recognizer);
    Ok(())
}

pub fn stop() {
    let Some(recognizer) = ACTIVE.lock().unwrap().take() else { return };
    if let Ok(session) = recognizer.ContinuousRecognitionSession() {
        // Arrêt « propre » : la dernière phrase en cours est encore reconnue.
        if let Ok(operation) = session.StopAsync() {
            let _ = operation.join();
        }
    }
    let _ = recognizer.Close();
}
