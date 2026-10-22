//! Compte GitHub : connexion, compte, dépôts.

use tauri::State;

use crate::{
    error::AppResult,
    github::{self, Account, DeviceCode, GithubState, Repo},
};

#[tauri::command]
pub async fn github_account(state: State<'_, GithubState>) -> AppResult<Option<Account>> {
    github::account(&state).await
}

/// Début de la connexion : code à saisir sur github.com.
#[tauri::command]
pub async fn github_login_start(state: State<'_, GithubState>) -> AppResult<DeviceCode> {
    github::start_login(&state).await
}

/// Attend la validation du code sur github.com.
#[tauri::command]
pub async fn github_login_finish(state: State<'_, GithubState>, code: DeviceCode) -> AppResult<Account> {
    github::finish_login(&state, &code).await
}

#[tauri::command]
pub fn github_login_cancel(state: State<'_, GithubState>) {
    github::cancel_login(&state);
}

#[tauri::command]
pub fn github_sign_out(state: State<'_, GithubState>) {
    github::sign_out(&state);
}

#[tauri::command]
pub async fn github_repos(state: State<'_, GithubState>) -> AppResult<Vec<Repo>> {
    github::repos(&state).await
}
