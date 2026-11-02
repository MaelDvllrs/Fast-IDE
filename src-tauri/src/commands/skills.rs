//! Skills des agents : liste, installation depuis GitHub, suppression.

use std::path::PathBuf;

use tauri::State;

use crate::{
    error::AppResult,
    github::GithubState,
    skills::{self, Inspection, Scope, Skill},
};

/// Skills du projet (`project`) et généraux.
#[tauri::command]
pub fn skills_list(project: Option<PathBuf>) -> Vec<Skill> {
    skills::list(project.as_deref())
}

/// Skills que contient un lien GitHub, avant de les installer.
#[tauri::command]
pub async fn skills_inspect(github: State<'_, GithubState>, link: String) -> AppResult<Inspection> {
    skills::inspect(&github, &link).await
}

#[tauri::command]
pub async fn skills_install(
    github: State<'_, GithubState>,
    link: String,
    dirs: Vec<String>,
    scope: Scope,
    project: Option<PathBuf>,
    ais: Vec<String>,
) -> AppResult<Vec<String>> {
    skills::install(&github, &link, &dirs, scope, project.as_deref(), &ais).await
}

#[tauri::command]
pub fn skills_remove(id: String, scope: Scope, project: Option<PathBuf>) -> AppResult<()> {
    skills::remove(&id, scope, project.as_deref())
}
