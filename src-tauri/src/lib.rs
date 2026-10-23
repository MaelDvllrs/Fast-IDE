mod claude;
mod codex;
mod commands;
mod error;
mod fs;
mod gemini;
mod github;
mod platform;
mod scheduler;
mod scm;
mod settings;
mod speech;
mod terminal;
mod workspace;

use tauri::{Manager, RunEvent};

pub fn run() {
    platform::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Mises à jour : vérifiées au lancement sur les releases GitHub (voir src/lib/updater.ts).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(claude::ClaudeState::default())
        .manage(codex::CodexState::default())
        .manage(gemini::GeminiState::default())
        .manage(scheduler::SchedulerState::default())
        // Serveur MCP du planificateur : les agents y lancent vérifications, builds et previews.
        .setup(|app| {
            scheduler::serve(app.handle().clone());
            #[cfg(debug_assertions)]
            scheduler::debug_probe(app.handle().clone());
            Ok(())
        })
        .manage(terminal::TerminalState::default())
        .manage(workspace::WorkspaceState::default())
        .manage(github::GithubState::default())
        .invoke_handler(tauri::generate_handler![
            commands::system::platform_info,
            commands::system::system_open_url,
            commands::system::system_open_path,
            commands::github::github_account,
            commands::github::github_login_start,
            commands::github::github_login_finish,
            commands::github::github_login_cancel,
            commands::github::github_sign_out,
            commands::github::github_repos,
            commands::scm::scm_status,
            commands::scm::scm_stage,
            commands::scm::scm_unstage,
            commands::scm::scm_commit,
            commands::scm::scm_push,
            commands::scm::scm_pull,
            commands::scm::scm_fetch,
            commands::scm::scm_branches,
            commands::scm::scm_log,
            commands::scm::scm_checkout,
            commands::scm::scm_create_branch,
            commands::scm::scm_init,
            commands::scm::scm_publish,
            commands::scm::scm_clone,
            commands::workspace::workspace_pick_folder,
            commands::workspace::workspace_pick_files,
            commands::workspace::agent_workspace_create,
            commands::workspace::agent_workspace_remove,
            commands::workspace::agent_set_busy,
            commands::workspace::agent_task_finished,
            commands::workspace::project_config_get,
            commands::workspace::project_config_set,
            commands::workspace::project_run_options,
            commands::workspace::project_run_set,
            commands::workspace::attachment_save,
            commands::workspace::project_agents_load,
            commands::workspace::project_agents_save,
            commands::fs::fs_read_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::claude::claude_status,
            commands::claude::claude_logout,
            commands::claude::claude_start,
            commands::claude::claude_send,
            commands::claude::claude_permission,
            commands::claude::claude_quick,
            commands::claude::claude_interrupt,
            commands::claude::codex_status,
            commands::claude::codex_logout,
            commands::claude::codex_models,
            commands::claude::codex_start,
            commands::claude::gemini_status,
            commands::claude::gemini_login,
            commands::claude::gemini_logout,
            commands::claude::gemini_start,
            scheduler::scheduler_tasks,
            scheduler::scheduler_stop,
            commands::claude::claude_stop,
            commands::settings::settings_load,
            commands::settings::settings_save,
            commands::speech::speech_start,
            commands::speech::speech_stop,
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
                codex::stop_all(&app.state::<codex::CodexState>());
                gemini::stop_all(&app.state::<gemini::GeminiState>());
                scheduler::stop_all(app);
            }
        });
}
