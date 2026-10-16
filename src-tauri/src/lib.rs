mod claude;
mod commands;
mod error;
mod fs;
mod platform;
mod settings;
mod terminal;
mod workspace;

use tauri::{Manager, RunEvent};

pub fn run() {
    platform::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(claude::ClaudeState::default())
        .manage(terminal::TerminalState::default())
        .manage(workspace::WorkspaceState::default())
        .invoke_handler(tauri::generate_handler![
            commands::system::platform_info,
            commands::workspace::workspace_pick_folder,
            commands::workspace::workspace_pick_files,
            commands::workspace::agent_workspace_create,
            commands::workspace::agent_workspace_remove,
            commands::workspace::agent_set_busy,
            commands::workspace::agent_task_finished,
            commands::workspace::project_config_get,
            commands::workspace::project_config_set,
            commands::fs::fs_read_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::claude::claude_status,
            commands::claude::claude_start,
            commands::claude::claude_send,
            commands::claude::claude_stop,
            commands::settings::settings_load,
            commands::settings::settings_save,
            commands::terminal::terminal_start,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application")
        .run(|app, event| {
            // Fermeture de l'app : on arrête les shells et Claude Code plutôt
            // que de les laisser tourner en arrière-plan.
            if let RunEvent::Exit = event {
                terminal::stop_all(&app.state::<terminal::TerminalState>());
                claude::stop_all(&app.state::<claude::ClaudeState>());
            }
        });
}
