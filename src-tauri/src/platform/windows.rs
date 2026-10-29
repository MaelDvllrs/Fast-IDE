use std::path::PathBuf;

pub const OS: &str = "windows";
pub const HOME_VAR: &str = "USERPROFILE";

/// https://learn.microsoft.com/windows/win32/procthread/process-creation-flags
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Job Object de l'app (handle), gardé pour `release_new_children`.
static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

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
        if configured != 0 && AssignProcessToJobObject(job, GetCurrentProcess()) != 0 {
            let _ = JOB.set(job as usize);
        }
        // Le handle n'est volontairement jamais fermé : c'est sa fermeture
        // automatique, à la fin du processus, qui arrête les enfants.
    }
}

/// Les processus lancés à partir de maintenant sortent du job : ils survivent à
/// l'app (ceux déjà lancés restent arrêtés avec elle). Pour l'installeur d'une
/// mise à jour, lancé juste avant que l'app se ferme pour le laisser remplacer
/// ses fichiers : sans cela, il serait tué avec elle.
pub fn release_new_children() {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    let Some(&job) = JOB.get() else { return };
    // SAFETY : handle du job créé par `init`, jamais fermé ; structure initialisée à zéro.
    unsafe {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        SetInformationJobObject(
            job as _,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
    }
}

/// Chiffre des données pour le compte Windows courant (DPAPI) : seul ce compte,
/// sur cette machine, peut les déchiffrer.
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY : tampons valides pendant l'appel ; la sortie, allouée par Windows, est copiée puis libérée.
    unsafe {
        if CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output) == 0 {
            return None;
        }
        Some(take_blob(output))
    }
}

/// Inverse de [`protect`].
pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY : comme `protect`.
    unsafe {
        if CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output) == 0 {
            return None;
        }
        Some(take_blob(output))
    }
}

/// Copie un résultat de DPAPI et libère la mémoire allouée par Windows.
unsafe fn take_blob(blob: windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let bytes = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
    windows_sys::Win32::Foundation::LocalFree(blob.pbData as _);
    bytes
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

/// Rien à faire : `taskkill /T` suit la parenté des processus.
pub fn own_process_tree(_cmd: &mut tokio::process::Command) {}

/// Job Object propre à une tâche : ses descendants y entrent avec elle et y
/// restent, même quand leur parent s'est terminé.
pub struct ProcessTree {
    job: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
}

// SAFETY : le handle du job n'est utilisé que par des appels Win32 thread-safe.
unsafe impl Send for ProcessTree {}
unsafe impl Sync for ProcessTree {}

impl ProcessTree {
    pub fn attach(child: &tokio::process::Child) -> Option<Self> {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW},
        };
        let (handle, pid) = (child.raw_handle()?, child.id()?);
        // SAFETY : job créé ici ; le handle du processus appartient à `child`, vivant.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            if AssignProcessToJobObject(job, handle as _) == 0 {
                CloseHandle(job);
                return None;
            }
            Some(Self { job, pid })
        }
    }

    /// Sans `force` : `taskkill /T` demande aux programmes de se fermer ; avec,
    /// tout le job est arrêté d'office.
    pub fn stop(&self, force: bool) {
        if force {
            // SAFETY : handle valide jusqu'au `Drop`.
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1) };
        } else {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        // Fermer le handle ne tue rien (pas de « kill on close ») : `stop` le fait.
        // SAFETY : handle créé par `attach`, fermé une seule fois.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job) };
    }
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

/// `cmd.exe` plutôt que PowerShell : `npm`, `pnpm`… y passent par leurs `.cmd`,
/// sans dépendre de la politique d'exécution des scripts PowerShell.
pub fn command_launch(command: &str) -> super::ShellLaunch {
    super::ShellLaunch {
        program: "cmd.exe".into(),
        args: vec!["/D".into(), "/S".into(), "/C".into(), command.into()],
        prints_banner: false,
    }
}

