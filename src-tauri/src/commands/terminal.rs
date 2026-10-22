use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::{
    error::AppResult,
    terminal::{self, StartOptions, TerminalState},
};

#[tauri::command(async)]
pub fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    cwd: Option<PathBuf>,
    cols: u16,
    rows: u16,
    banner: Option<String>,
    command: Option<String>,
) -> AppResult<()> {
    terminal::start(app, &state, session_id, StartOptions { cwd, cols, rows, banner, command })
}

#[tauri::command(async)]
pub fn terminal_write(state: State<'_, TerminalState>, session_id: String, data: String) -> AppResult<()> {
    terminal::write(&state, &session_id, &data)
}

#[tauri::command(async)]
pub fn terminal_resize(state: State<'_, TerminalState>, session_id: String, cols: u16, rows: u16) -> AppResult<()> {
    terminal::resize(&state, &session_id, cols, rows)
}

#[tauri::command(async)]
pub fn terminal_stop(state: State<'_, TerminalState>, session_id: String) {
    terminal::stop(&state, &session_id);
}
