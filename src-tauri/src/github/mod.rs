//! Compte GitHub : connexion OAuth par « device flow », jeton dans le trousseau
//! du système (Gestionnaire d'identifiants Windows, trousseau macOS) et appels
//! à l'API GitHub (compte, liste et création de dépôts).
//!
//! Sous Windows, le jeton est aussi gardé chiffré (DPAPI, lié au compte Windows)
//! dans le dossier de l'app : si le trousseau le perd, FAST le retrouve. Les
//! événements de connexion sont notés dans `github.log`, au même endroit.
//!
//! Le device flow n'utilise pas de secret : FAST affiche un code, l'utilisateur
//! le valide sur github.com, et FAST récupère le jeton en interrogeant GitHub.

use std::{
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    platform,
};

/// Client ID de l'OAuth App GitHub de FAST (public : le device flow n'a pas de secret).
/// Peut être remplacé à la compilation par la variable `FAST_GITHUB_CLIENT_ID`.
const CLIENT_ID: &str = match option_env!("FAST_GITHUB_CLIENT_ID") {
    Some(id) => id,
    None => "Ov23liT1WFURzDb8xtLL",
};

/// Droits demandés : dépôts publics et privés (push, création) et profil.
const SCOPES: &str = "repo read:user";

const API: &str = "https://api.github.com";
const KEYRING_SERVICE: &str = "FAST";
const KEYRING_USER: &str = "github";

#[derive(Default)]
pub struct GithubState {
    /// Jeton en mémoire : `None` = pas encore lu dans le trousseau.
    token: Mutex<Option<Option<String>>>,
    account: Mutex<Option<Account>>,
    /// Incrémenté à chaque connexion lancée ou annulée : une attente périmée s'arrête.
    login: AtomicU64,
    /// Dossier de l'app : copie chiffrée du jeton et journal.
    dir: OnceLock<PathBuf>,
}

impl GithubState {
    /// Dossier de configuration de l'app (au lancement).
    pub fn set_dir(&self, dir: PathBuf) {
        let _ = self.dir.set(dir);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: u64,
    pub login: String,
    pub name: Option<String>,
    /// `avatar_url` dans l'API GitHub, `avatarUrl` côté interface.
    #[serde(alias = "avatar_url")]
    pub avatar_url: String,
}

impl Account {
    /// Adresse « noreply » de GitHub, pour signer les commits sans exposer d'e-mail.
    pub fn noreply_email(&self) -> String {
        format!("{}+{}@users.noreply.github.com", self.id, self.login)
    }
}

/// Code à saisir sur github.com, renvoyé au début de la connexion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
    /// Numéro de cette connexion, à repasser à [`finish_login`].
    #[serde(default)]
    pub attempt: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub full_name: String,
    pub name: String,
    pub owner: String,
    pub private: bool,
    pub description: Option<String>,
    pub clone_url: String,
    pub html_url: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct ApiRepo {
    full_name: String,
    name: String,
    owner: ApiOwner,
    private: bool,
    description: Option<String>,
    clone_url: String,
    html_url: String,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct ApiOwner {
    login: String,
}

impl From<ApiRepo> for Repo {
    fn from(r: ApiRepo) -> Self {
        Repo {
            full_name: r.full_name,
            name: r.name,
            owner: r.owner.login,
            private: r.private,
            description: r.description,
            clone_url: r.clone_url,
            html_url: r.html_url,
            updated_at: r.updated_at.unwrap_or_default(),
        }
    }
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("FAST/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(http_error)
}

fn http_error(err: reqwest::Error) -> AppError {
    AppError::msg(format!("GitHub is unreachable: {err}"))
}

// --- Jeton ------------------------------------------------------------------

fn keyring_entry() -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| AppError::msg(format!("system keychain unavailable: {e}")))
}

/// Note un événement de connexion dans `github.log` (jamais le jeton lui-même).
fn log(state: &GithubState, event: &str) {
    let Some(dir) = state.dir.get() else { return };
    let path = dir.join("github.log");
    // Journal court : recommencé au-delà de 64 Ko.
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 64 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{secs} {event}");
    }
}

fn backup_path(state: &GithubState) -> Option<PathBuf> {
    state.dir.get().map(|d| d.join("github-token.bin"))
}

fn read_backup(state: &GithubState) -> Option<String> {
    let data = std::fs::read(backup_path(state)?).ok()?;
    String::from_utf8(platform::unprotect(&data)?).ok()
}

fn write_backup(state: &GithubState, token: &str) -> bool {
    let (Some(path), Some(data)) = (backup_path(state), platform::protect(token.as_bytes())) else { return false };
    path.parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::write(path, data).is_ok()
}

/// Jeton enregistré : trousseau, sinon copie chiffrée. Lu une fois ; une erreur de
/// lecture du trousseau n'est pas mémorisée (nouvel essai au prochain appel).
pub fn token(state: &GithubState) -> Option<String> {
    let mut cached = state.token.lock().unwrap();
    if let Some(token) = cached.as_ref() {
        return token.clone();
    }
    let read = keyring_entry().map(|e| e.get_password());
    let keyring_failed = match &read {
        Ok(Ok(_)) | Ok(Err(keyring::Error::NoEntry)) => false,
        Ok(Err(err)) => {
            log(state, &format!("keychain read failed: {err}"));
            true
        }
        Err(err) => {
            log(state, &format!("keychain unavailable: {err}"));
            true
        }
    };
    let token = match read {
        Ok(Ok(token)) => {
            // Copie chiffrée d'un jeton enregistré avant qu'elle existe.
            if backup_path(state).is_some_and(|p| !p.exists()) {
                write_backup(state, &token);
            }
            Some(token)
        }
        _ => {
            let backup = read_backup(state);
            if let Some(token) = &backup {
                log(state, "token missing from the keychain: restored from the encrypted copy");
                if let Ok(entry) = keyring_entry() {
                    let _ = entry.set_password(token);
                }
            } else if backup_path(state).is_some_and(|p| p.exists()) {
                log(state, "encrypted copy unreadable");
            }
            backup
        }
    };
    if token.is_some() || !keyring_failed {
        *cached = Some(token.clone());
    }
    token
}

fn store_token(state: &GithubState, token: &str) -> AppResult<()> {
    let keyring = keyring_entry().and_then(|e| e.set_password(token).map_err(|e| AppError::msg(e.to_string())));
    let backup = write_backup(state, token);
    match (&keyring, backup) {
        (Ok(()), true) => log(state, "signed in: token saved (keychain + encrypted copy)"),
        (Ok(()), false) => log(state, "signed in: token saved (keychain)"),
        (Err(err), true) => log(state, &format!("signed in: keychain write failed ({err}), token kept in the encrypted copy")),
        (Err(err), false) => {
            log(state, &format!("signed in: token could not be saved: {err}"));
            return Err(AppError::msg(format!("could not save the GitHub token: {err}")));
        }
    }
    *state.token.lock().unwrap() = Some(Some(token.to_owned()));
    Ok(())
}

/// Déconnexion demandée par l'utilisateur : le jeton est oublié partout.
pub fn sign_out(state: &GithubState) {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
    if let Some(path) = backup_path(state) {
        let _ = std::fs::remove_file(path);
    }
    log(state, "signed out by the user");
    *state.token.lock().unwrap() = Some(None);
    *state.account.lock().unwrap() = None;
    state.login.fetch_add(1, Ordering::SeqCst);
}

/// Variables d'environnement qui authentifient `git` auprès de github.com avec
/// le jeton (jamais sur la ligne de commande, visible des autres processus).
/// Le gestionnaire d'identifiants est désactivé pour github.com : pas de fenêtre
/// de connexion surprise si le jeton est refusé. Vide si l'on n'est pas connecté.
pub fn git_env(state: &GithubState) -> Vec<(String, String)> {
    let Some(token) = token(state) else { return vec![] };
    let basic = STANDARD.encode(format!("x-access-token:{token}"));
    [
        ("GIT_CONFIG_COUNT", "2".to_owned()),
        ("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader".to_owned()),
        ("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {basic}")),
        ("GIT_CONFIG_KEY_1", "credential.https://github.com.helper".to_owned()),
        ("GIT_CONFIG_VALUE_1", String::new()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect()
}

// --- Connexion (device flow) ------------------------------------------------

pub async fn start_login(state: &GithubState) -> AppResult<DeviceCode> {
    if CLIENT_ID.is_empty() {
        return Err(AppError::msg(
            "GitHub sign-in isn't configured in this build of FAST (missing OAuth client ID).",
        ));
    }
    let response = client()?
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPES)])
        .send()
        .await
        .map_err(http_error)?;
    let text = response.text().await.map_err(http_error)?;
    let code: ApiDeviceCode = serde_json::from_str(&text).map_err(|_| {
        let reason = serde_json::from_str::<TokenResponse>(&text)
            .ok()
            .and_then(|r| r.error_description.or(r.error))
            .unwrap_or_else(|| text.trim().to_owned());
        AppError::msg(format!("GitHub refused the sign-in request: {reason}"))
    })?;
    Ok(DeviceCode {
        device_code: code.device_code,
        user_code: code.user_code,
        verification_uri: code.verification_uri,
        expires_in: code.expires_in,
        interval: code.interval,
        attempt: state.login.fetch_add(1, Ordering::SeqCst) + 1,
    })
}

/// Réponse de GitHub (champs en snake_case, contrairement à l'IPC).
#[derive(Deserialize)]
struct ApiDeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

/// Attend que l'utilisateur valide le code sur github.com, puis enregistre le jeton.
pub async fn finish_login(state: &GithubState, code: &DeviceCode) -> AppResult<Account> {
    let client = client()?;
    let mut interval = code.interval.max(1);
    let deadline = std::time::Instant::now() + Duration::from_secs(code.expires_in);
    loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if state.login.load(Ordering::SeqCst) != code.attempt {
            return Err(AppError::msg("Sign-in cancelled."));
        }
        if std::time::Instant::now() > deadline {
            return Err(AppError::msg("The code expired. Start the sign-in again."));
        }
        let response: TokenResponse = client
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", CLIENT_ID),
                ("device_code", code.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(http_error)?
            .json()
            .await
            .map_err(http_error)?;
        if let Some(token) = response.access_token {
            store_token(state, &token)?;
            return account(state).await?.ok_or_else(|| AppError::msg("GitHub rejected the new token."));
        }
        match response.error.as_deref() {
            Some("authorization_pending") => {}
            // GitHub demande d'espacer les requêtes.
            Some("slow_down") => interval = response.interval.unwrap_or(interval + 5),
            Some("expired_token") => return Err(AppError::msg("The code expired. Start the sign-in again.")),
            Some("access_denied") => return Err(AppError::msg("Sign-in was cancelled on GitHub.")),
            Some(other) => {
                return Err(AppError::msg(response.error_description.unwrap_or_else(|| format!("GitHub sign-in failed ({other})."))))
            }
            None => return Err(AppError::msg("Unexpected answer from GitHub.")),
        }
    }
}

pub fn cancel_login(state: &GithubState) {
    state.login.fetch_add(1, Ordering::SeqCst);
}

// --- API --------------------------------------------------------------------

async fn api(state: &GithubState, method: reqwest::Method, path: &str) -> AppResult<reqwest::RequestBuilder> {
    let token = token(state).ok_or_else(|| AppError::msg("Sign in to GitHub first."))?;
    Ok(client()?
        .request(method, format!("{API}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28"))
}

/// Réponse en erreur → message lisible ; 401 = jeton refusé.
async fn check(state: &GithubState, response: reqwest::Response) -> AppResult<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    // Jeton refusé : l'interface affiche FAST déconnecté, mais le jeton n'est pas
    // effacé (un refus passager ne doit pas déconnecter pour de bon) ; il est
    // réessayé au prochain lancement, et remplacé à la prochaine connexion.
    if status == reqwest::StatusCode::UNAUTHORIZED {
        *state.account.lock().unwrap() = None;
        log(state, "GitHub refused the token (401)");
        return Err(AppError::msg("Your GitHub session expired. Sign in again."));
    }
    #[derive(Deserialize)]
    struct ApiError {
        message: Option<String>,
        errors: Option<Vec<ApiErrorItem>>,
    }
    #[derive(Deserialize)]
    struct ApiErrorItem {
        message: Option<String>,
    }
    let text = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<ApiError>(&text)
        .ok()
        .and_then(|e| {
            e.errors
                .and_then(|items| items.into_iter().find_map(|i| i.message))
                .or(e.message)
        })
        .unwrap_or_else(|| format!("GitHub error {status}"));
    Err(AppError::msg(message))
}

/// Compte connecté, ou `None` si l'on n'est pas connecté.
pub async fn account(state: &GithubState) -> AppResult<Option<Account>> {
    if token(state).is_none() {
        return Ok(None);
    }
    if let Some(account) = state.account.lock().unwrap().clone() {
        return Ok(Some(account));
    }
    let response = api(state, reqwest::Method::GET, "/user").await?.send().await.map_err(http_error)?;
    let account: Account = check(state, response).await?.json().await.map_err(http_error)?;
    *state.account.lock().unwrap() = Some(account.clone());
    Ok(Some(account))
}

/// Compte déjà chargé (sans appel réseau), pour signer les commits.
pub fn cached_account(state: &GithubState) -> Option<Account> {
    state.account.lock().unwrap().clone()
}

/// Dépôts accessibles (propres, collaborations, organisations), les plus récents d'abord.
pub async fn repos(state: &GithubState) -> AppResult<Vec<Repo>> {
    const PER_PAGE: usize = 100;
    const MAX_PAGES: usize = 10;
    let mut all = Vec::new();
    for page in 1..=MAX_PAGES {
        let path = format!(
            "/user/repos?per_page={PER_PAGE}&page={page}&sort=updated&affiliation=owner,collaborator,organization_member"
        );
        let response = api(state, reqwest::Method::GET, &path).await?.send().await.map_err(http_error)?;
        let batch: Vec<ApiRepo> = check(state, response).await?.json().await.map_err(http_error)?;
        let done = batch.len() < PER_PAGE;
        all.extend(batch.into_iter().map(Repo::from));
        if done {
            break;
        }
    }
    Ok(all)
}

pub async fn create_repo(state: &GithubState, name: &str, private: bool, description: Option<&str>) -> AppResult<Repo> {
    let body = serde_json::json!({
        "name": name,
        "private": private,
        "description": description.unwrap_or(""),
        "auto_init": false,
    });
    let response = api(state, reqwest::Method::POST, "/user/repos").await?.json(&body).send().await.map_err(http_error)?;
    let repo: ApiRepo = check(state, response).await?.json().await.map_err(http_error)?;
    Ok(repo.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Les réponses de GitHub (snake_case) se décodent, et l'IPC reste en camelCase.
    #[test]
    fn decodes_github_responses() {
        let user = r#"{"login":"octocat","id":1,"avatar_url":"https://a/u/1","name":null,"type":"User"}"#;
        let account: Account = serde_json::from_str(user).unwrap();
        assert_eq!(account.avatar_url, "https://a/u/1");
        let ipc = serde_json::to_string(&account).unwrap();
        assert!(ipc.contains("\"avatarUrl\""));
        let back: Account = serde_json::from_str(&ipc).unwrap();
        assert_eq!(back.login, "octocat");

        let code = r#"{"device_code":"d","user_code":"0D1B-F50D","verification_uri":"https://github.com/login/device","expires_in":899,"interval":5}"#;
        assert_eq!(serde_json::from_str::<ApiDeviceCode>(code).unwrap().user_code, "0D1B-F50D");

        let token = r#"{"access_token":"gho_x","token_type":"bearer","scope":"repo,read:user"}"#;
        assert_eq!(serde_json::from_str::<TokenResponse>(token).unwrap().access_token.as_deref(), Some("gho_x"));

        let repo = r#"{"full_name":"o/r","name":"r","owner":{"login":"o"},"private":true,"description":null,
            "clone_url":"https://github.com/o/r.git","html_url":"https://github.com/o/r","updated_at":"2026-01-01T00:00:00Z"}"#;
        let repo: Repo = serde_json::from_str::<ApiRepo>(repo).unwrap().into();
        assert!(serde_json::to_string(&repo).unwrap().contains("\"cloneUrl\""));
    }
}


#[cfg(all(test, windows))]
mod backup_tests {
    use super::{read_backup, write_backup, GithubState};

    /// Copie chiffrée du jeton : relue telle quelle, illisible en clair sur le disque.
    #[test]
    fn keeps_an_encrypted_copy() {
        let dir = std::env::temp_dir().join(format!("fast-github-backup-{}", std::process::id()));
        let state = GithubState::default();
        state.set_dir(dir.clone());
        assert!(write_backup(&state, "gho_example_token"));
        let raw = std::fs::read(dir.join("github-token.bin")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("gho_example_token"));
        assert_eq!(read_backup(&state).as_deref(), Some("gho_example_token"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
