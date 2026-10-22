use crate::platform::{self, PlatformInfo};

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    platform::info()
}

/// Pages des réglages de Windows que l'app peut ouvrir (confidentialité de la dictée).
const SETTINGS_PAGES: &[&str] = &["ms-settings:privacy-speech", "ms-settings:privacy-microphone"];

/// Adresses locales en http autorisées (application web lancée par le bouton Run).
fn is_local_http(url: &str) -> bool {
    ["http://localhost", "http://127.0.0.1", "http://[::1]"].iter().any(|prefix| {
        url.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
    })
}

/// Ouvre une adresse web dans le navigateur par défaut (https, ou http local),
/// ou une des pages de réglages de Windows listées ci-dessus.
#[tauri::command]
pub fn system_open_url(app: tauri::AppHandle, url: String) -> crate::error::AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://") && !is_local_http(&url) && !SETTINGS_PAGES.contains(&url.as_str()) {
        return Err(crate::error::AppError::msg("only https links can be opened"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| crate::error::AppError::msg(format!("could not open the browser: {e}")))
}

/// Ouvre un dossier dans l'explorateur de fichiers du système.
#[tauri::command]
pub fn system_open_path(app: tauri::AppHandle, path: std::path::PathBuf) -> crate::error::AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    if !path.is_dir() {
        return Err(crate::error::AppError::msg(format!("{} doesn't exist", path.display())));
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| crate::error::AppError::msg(format!("could not open the folder: {e}")))
}
