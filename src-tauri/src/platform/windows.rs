use std::path::PathBuf;

pub const OS: &str = "windows";
pub const HOME_VAR: &str = "USERPROFILE";

/// https://learn.microsoft.com/windows/win32/procthread/process-creation-flags
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Place l'app dans un Job Object « tuer à la fermeture » : tous ses processus
/// enfants (shells du terminal, Claude Code, WebView2) héritent du job et sont
/// arrêtés par Windows quand l'app se termine, même sur un plantage.
pub fn init() {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY : appels Win32 sur un handle créé ici ; la structure est
    // initialisée à zéro puis seul le drapeau voulu est positionné.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured != 0 {
            AssignProcessToJobObject(job, GetCurrentProcess());
        }
        // Le handle n'est volontairement jamais fermé : c'est sa fermeture
        // automatique, à la fin du processus, qui arrête les enfants.
    }
}

/// Numéro de build de Windows, lu dans le registre (`GetVersionEx` ment selon
/// le manifeste de l'exécutable).
pub fn windows_build() -> Option<u32> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let key = wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let value = wide("CurrentBuildNumber");
    let mut buf = [0u16; 32];
    let mut size = std::mem::size_of_val(&buf) as u32;

    // SAFETY : tampon et taille cohérents, chaînes terminées par un zéro.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len]).trim().parse().ok()
}

/// Installeur officiel, pour PowerShell.
pub const CLAUDE_INSTALL_COMMAND: &str = "irm https://claude.ai/install.ps1 | iex";

/// `& 'chemin' auth login --claudeai` (apostrophes doublées dans le chemin).
pub fn claude_login_command(program: &std::path::Path) -> String {
    let path = program.to_string_lossy().replace('\'', "''");
    format!("& '{path}' auth login --claudeai")
}

/// Ligne de shell via `cmd /C` (qui trouve `npm.cmd`, `cargo.exe`…).
pub fn shell_command(line: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("cmd");
    cmd.args(["/C", line]);
    cmd
}

/// Jonction NTFS (`mklink /J`) : contrairement aux liens symboliques, elle ne
/// demande ni droits administrateur ni mode développeur.
pub fn link_dir(target: &std::path::Path, link: &std::path::Path) -> crate::error::AppResult<()> {
    use std::os::windows::process::CommandExt;
    let status = std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(crate::error::AppError::msg(format!("could not link {}", link.display())))
    }
}

/// `remove_dir` sur une jonction supprime le lien seul, jamais le contenu de la cible.
pub fn unlink_dir(link: &std::path::Path) -> crate::error::AppResult<()> {
    Ok(std::fs::remove_dir(link)?)
}

/// Empêche l'apparition d'une fenêtre console pour chaque processus enfant.
pub fn configure_command(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// PowerShell 7 (`pwsh`) s'il est installé, sinon Windows PowerShell.
///
/// ConPTY efface l'écran au démarrage du shell : un message écrit avant serait
/// perdu. Le message d'accueil est donc affiché par PowerShell lui-même, via un
/// script passé en `-EncodedCommand` (UTF-16LE en base64, sans souci d'échappement).
pub fn shell_launch(banner: Option<&str>) -> super::ShellLaunch {
    let program = if which::which("pwsh").is_ok() { "pwsh.exe" } else { "powershell.exe" };
    let mut args = vec!["-NoLogo".to_string()];

    if let Some(text) = banner {
        let script = format!(
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Host '{}'",
            // Chaîne entre apostrophes en PowerShell : on double les apostrophes.
            text.replace('\'', "''")
        );
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        args.extend(["-NoExit".into(), "-EncodedCommand".into(), base64(&utf16)]);
    }

    super::ShellLaunch { program: program.into(), args, prints_banner: banner.is_some() }
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn claude_fallback_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = super::home_dir() {
        // Installeur natif.
        paths.push(home.join(".local").join("bin").join("claude.exe"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        // Installation via `npm install -g`.
        paths.push(PathBuf::from(appdata).join("npm").join("claude.cmd"));
    }
    paths
}
