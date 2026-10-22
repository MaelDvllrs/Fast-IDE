//! Terminaux intégrés : un shell dans un pseudo-terminal (ConPTY sous Windows,
//! PTY Unix sur macOS). La sortie est relayée à l'interface par l'événement
//! `terminal://event` ; l'interface renvoie les frappes et la taille.

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    error::{AppError, AppResult},
    platform,
};

pub const EVENT: &str = "terminal://event";

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Les PTY sont des API bloquantes : un Mutex standard suffit.
#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalEvent {
    session_id: String,
    event: EventKind,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
enum EventKind {
    Output(String),
    Exit(Option<u32>),
}

fn pty_error(err: impl std::fmt::Display) -> AppError {
    AppError::msg(format!("terminal: {err}"))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

pub struct StartOptions {
    /// Dossier de départ ; à défaut, le dossier personnel de l'utilisateur.
    pub cwd: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
    /// Message affiché avant la première invite du shell.
    pub banner: Option<String>,
    /// Commande à exécuter à la place du shell interactif (le processus se
    /// termine avec elle) ; utilisée par le bouton Run.
    pub command: Option<String>,
}

pub fn start(app: AppHandle, state: &TerminalState, id: String, opts: StartOptions) -> AppResult<()> {
    let mut sessions = state.sessions.lock().unwrap();
    if sessions.contains_key(&id) {
        return Err(AppError::msg(format!("terminal {id} already exists")));
    }

    let pair = native_pty_system().openpty(size(opts.cols, opts.rows)).map_err(pty_error)?;

    let launch = match &opts.command {
        Some(command) => platform::command_launch(command),
        None => platform::shell_launch(opts.banner.as_deref()),
    };
    let mut cmd = CommandBuilder::new(&launch.program);
    cmd.args(&launch.args);
    if let Some(cwd) = opts.cwd.or_else(platform::home_dir) {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(pty_error)?;
    // Le côté esclave appartient désormais au shell.
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(pty_error)?;
    let writer = pair.master.take_writer().map_err(pty_error)?;

    if let Some(banner) = opts.banner.filter(|_| !launch.prints_banner) {
        emit(&app, &id, EventKind::Output(banner.replace('\n', "\r\n") + "\r\n"));
    }

    let thread_app = app.clone();
    let thread_id = id.clone();
    std::thread::spawn(move || forward_output(thread_app, thread_id, reader));

    sessions.insert(id, Session { master: pair.master, writer, child });
    Ok(())
}

pub fn write(state: &TerminalState, id: &str, data: &str) -> AppResult<()> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(id).ok_or_else(|| AppError::msg(format!("unknown terminal {id}")))?;
    session.writer.write_all(data.as_bytes())?;
    session.writer.flush()?;
    Ok(())
}

pub fn resize(state: &TerminalState, id: &str, cols: u16, rows: u16) -> AppResult<()> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(id).ok_or_else(|| AppError::msg(format!("unknown terminal {id}")))?;
    session.master.resize(size(cols, rows)).map_err(pty_error)
}

/// Arrête tous les shells (fermeture de l'app).
pub fn stop_all(state: &TerminalState) {
    for (_, mut session) in state.sessions.lock().unwrap().drain() {
        let _ = session.child.kill();
    }
}

pub fn stop(state: &TerminalState, id: &str) {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(id) {
        let _ = session.child.kill();
    }
}

/// Lit la sortie du shell jusqu'à sa fermeture. Les octets sont décodés en
/// UTF-8 en gardant de côté un caractère coupé entre deux lectures.
fn forward_output(app: AppHandle, id: String, mut reader: Box<dyn Read + Send>) {
    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();

    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    // Séquence incomplète en fin de tampon : on attend la suite.
                    Err(e) if e.error_len().is_none() => e.valid_up_to(),
                    // Octets invalides : on les remplace plutôt que de bloquer.
                    Err(_) => pending.len(),
                };
                let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                if !text.is_empty() {
                    emit(&app, &id, EventKind::Output(text));
                }
            }
        }
    }

    // Shell terminé : on récupère son code de sortie et on libère la session.
    let session = app.state::<TerminalState>().sessions.lock().unwrap().remove(&id);
    let code = session.and_then(|mut s| s.child.wait().ok()).map(|status| status.exit_code());
    emit(&app, &id, EventKind::Exit(code));
}

fn emit(app: &AppHandle, id: &str, event: EventKind) {
    let payload = TerminalEvent { session_id: id.to_owned(), event };
    if let Err(err) = app.emit(EVENT, payload) {
        eprintln!("failed to emit terminal event: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Le mode commande (bouton Run) exécute la ligne et rend son code de sortie.
    #[test]
    fn runs_a_command_in_a_pty() {
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let launch = platform::command_launch("echo fast-run-ok && exit 3");
        let mut cmd = CommandBuilder::new(&launch.program);
        cmd.args(&launch.args);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        // ConPTY demande la position du curseur avant d'afficher quoi que ce soit ;
        // xterm répond tout seul dans l'app, le test le fait à sa place.
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"[1;1R").unwrap();
        let reading = std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
                if String::from_utf8_lossy(&out).contains("fast-run-ok") {
                    break;
                }
            }
            String::from_utf8_lossy(&out).into_owned()
        });
        let output = reading.join().unwrap();
        let status = child.wait().unwrap();
        drop(writer);
        drop(pair.master);
        assert!(output.contains("fast-run-ok"), "{output:?}");
        assert_eq!(status.exit_code(), 3);
    }
}
