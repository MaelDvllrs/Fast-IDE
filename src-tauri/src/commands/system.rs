use crate::platform::{self, PlatformInfo};

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    platform::info()
}
