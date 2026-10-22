//! Panneau Git : état, index, commit, remote, branches, publication, clonage.

use std::path::PathBuf;

use tauri::State;

use crate::{
    error::AppResult,
    github::{GithubState, Repo},
    scm::{self, Branches, Commit, RepoStatus},
};

#[tauri::command]
pub async fn scm_status(root: PathBuf) -> AppResult<RepoStatus> {
    scm::status(&root).await
}

#[tauri::command]
pub async fn scm_stage(root: PathBuf, paths: Vec<String>) -> AppResult<()> {
    scm::stage(&root, &paths).await
}

#[tauri::command]
pub async fn scm_unstage(root: PathBuf, paths: Vec<String>) -> AppResult<()> {
    scm::unstage(&root, &paths).await
}

#[tauri::command]
pub async fn scm_commit(github: State<'_, GithubState>, root: PathBuf, message: String) -> AppResult<String> {
    scm::commit(&github, &root, &message).await
}

#[tauri::command]
pub async fn scm_push(github: State<'_, GithubState>, root: PathBuf) -> AppResult<()> {
    scm::push(&github, &root).await
}

#[tauri::command]
pub async fn scm_pull(github: State<'_, GithubState>, root: PathBuf) -> AppResult<()> {
    scm::pull(&github, &root).await
}

#[tauri::command]
pub async fn scm_fetch(github: State<'_, GithubState>, root: PathBuf) -> AppResult<()> {
    scm::fetch(&github, &root).await
}

/// Derniers commits de la branche courante.
#[tauri::command]
pub async fn scm_log(root: PathBuf, limit: Option<usize>) -> AppResult<Vec<Commit>> {
    scm::log(&root, limit.unwrap_or(50)).await
}

#[tauri::command]
pub async fn scm_branches(root: PathBuf) -> AppResult<Branches> {
    scm::branches(&root).await
}

#[tauri::command]
pub async fn scm_checkout(root: PathBuf, branch: String) -> AppResult<()> {
    scm::checkout(&root, &branch).await
}

#[tauri::command]
pub async fn scm_create_branch(root: PathBuf, name: String) -> AppResult<()> {
    scm::create_branch(&root, &name).await
}

#[tauri::command]
pub async fn scm_init(root: PathBuf) -> AppResult<()> {
    scm::init(&root).await
}

#[tauri::command]
pub async fn scm_publish(
    github: State<'_, GithubState>,
    root: PathBuf,
    name: String,
    private: bool,
    description: Option<String>,
) -> AppResult<Repo> {
    scm::publish(&github, &root, &name, private, description.as_deref()).await
}

#[tauri::command]
pub async fn scm_clone(github: State<'_, GithubState>, url: String, parent: PathBuf, name: String) -> AppResult<String> {
    scm::clone(&github, &url, &parent, &name).await
}
