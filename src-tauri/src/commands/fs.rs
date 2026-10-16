use std::path::PathBuf;

use crate::{
    error::AppResult,
    fs::{self, DirEntry},
};

#[tauri::command]
pub async fn fs_read_dir(path: PathBuf) -> AppResult<Vec<DirEntry>> {
    fs::read_dir(&path).await
}

#[tauri::command]
pub async fn fs_read_file(path: PathBuf) -> AppResult<String> {
    fs::read_file(&path).await
}

#[tauri::command]
pub async fn fs_write_file(path: PathBuf, contents: String) -> AppResult<()> {
    fs::write_file(&path, &contents).await
}
