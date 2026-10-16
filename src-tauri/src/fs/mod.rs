//! Accès au système de fichiers du workspace.

use std::path::Path;

use serde::Serialize;

use crate::error::AppResult;

/// Entrées masquées dans l'arborescence.
const IGNORED: &[&str] = &[".git", "node_modules", "target", ".DS_Store", "Thumbs.db"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Liste un dossier : sous-dossiers d'abord, puis tri alphabétique insensible à la casse.
pub async fn read_dir(path: &Path) -> AppResult<Vec<DirEntry>> {
    let mut reader = tokio::fs::read_dir(path).await?;
    let mut entries = Vec::new();

    while let Some(entry) = reader.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if IGNORED.contains(&name.as_str()) {
            continue;
        }
        entries.push(DirEntry {
            is_dir: entry.file_type().await?.is_dir(),
            path: entry.path().to_string_lossy().into_owned(),
            name,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub async fn read_file(path: &Path) -> AppResult<String> {
    Ok(tokio::fs::read_to_string(path).await?)
}

pub async fn write_file(path: &Path, contents: &str) -> AppResult<()> {
    Ok(tokio::fs::write(path, contents).await?)
}
