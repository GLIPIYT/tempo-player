use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

include!(concat!(env!("OUT_DIR"), "/soundcloud_session.rs"));

const TOKEN_ENV: &str = "TEMPO_SOUNDCLOUD_OAUTH_TOKEN";
const LOGIN_WINDOW_LABEL: &str = "sc-session-login";
const LOGIN_URL: &str = "https://soundcloud.com";
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(12);
const VALID_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const UNCERTAIN_CACHE_TTL: Duration = Duration::from_secs(30);
const CACHE_MAX_AGE: Duration = Duration::from_secs(10 * 60);
const CACHE_CAPACITY: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinState {
    Unconfigured,
    Unchecked,
    Valid,
    Expired,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub builtin_configured: bool,
    pub builtin_state: BuiltinState,
    pub personal_available: bool,
    pub login_open: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TokenValidation {
    Unchecked,
    Valid,
    Expired,
}

#[derive(Clone, Copy)]
struct CachedValidation {
    result: TokenValidation,
    checked_at: Instant,
}

fn validation_cache() -> &'static Mutex<HashMap<[u8; 32], CachedValidation>> {
    static CACHE: OnceLock<Mutex<HashMap<[u8; 32], CachedValidation>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn configured_builtin_token() -> Option<String> {
    let value = match std::env::var_os(TOKEN_ENV) {
        Some(value) => value.to_string_lossy().into_owned(),
        None => BUILTIN_OAUTH_TOKEN.to_owned(),
    };
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn token_fingerprint(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn cache_ttl(result: TokenValidation) -> Duration {
    match result {
        TokenValidation::Valid => VALID_CACHE_TTL,
        TokenValidation::Unchecked | TokenValidation::Expired => UNCERTAIN_CACHE_TTL,
    }
}

fn fresh_cached_validation(fingerprint: &[u8; 32]) -> Option<TokenValidation> {
    let cache = validation_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let cached = cache.get(fingerprint)?;
    (cached.checked_at.elapsed() < cache_ttl(cached.result)).then_some(cached.result)
}

fn remember_validation(fingerprint: [u8; 32], result: TokenValidation) {
    let mut cache = validation_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.retain(|_, entry| entry.checked_at.elapsed() < CACHE_MAX_AGE);
    if cache.len() >= CACHE_CAPACITY && !cache.contains_key(&fingerprint) {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.checked_at)
            .map(|(key, _)| *key)
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        fingerprint,
        CachedValidation {
            result,
            checked_at: Instant::now(),
        },
    );
}

async fn validate_token(token: &str) -> TokenValidation {
    let fingerprint = token_fingerprint(token);
    if let Some(result) = fresh_cached_validation(&fingerprint) {
        return result;
    }

    let result = validate_token_with_soundcloud(token).await;
    remember_validation(fingerprint, result);
    result
}

async fn validate_token_with_soundcloud(token: &str) -> TokenValidation {
    let Ok(client_id) = crate::soundcloud::get_client_id().await else {
        return TokenValidation::Unchecked;
    };
    let Ok(mut url) = tauri::Url::parse("https://api-v2.soundcloud.com/me") else {
        return TokenValidation::Unchecked;
    };
    url.query_pairs_mut().append_pair("client_id", &client_id);

    let Ok(authorization) = HeaderValue::from_str(&format!("OAuth {token}")) else {
        return TokenValidation::Unchecked;
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(VALIDATION_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return TokenValidation::Unchecked;
    };
    let Ok(response) = client
        .get(url)
        .header(AUTHORIZATION, authorization)
        .send()
        .await
    else {
        return TokenValidation::Unchecked;
    };

    if response.status().is_success() {
        TokenValidation::Valid
    } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        TokenValidation::Expired
    } else {
        // A forbidden or otherwise unexpected response is not enough evidence
        // to invalidate a token; availability can be retried later.
        TokenValidation::Unchecked
    }
}

fn builtin_state(token: Option<&str>, validation: Option<TokenValidation>) -> BuiltinState {
    match (token, validation) {
        (None, _) => BuiltinState::Unconfigured,
        (Some(_), Some(TokenValidation::Valid)) => BuiltinState::Valid,
        (Some(_), Some(TokenValidation::Expired)) => BuiltinState::Expired,
        (Some(_), Some(TokenValidation::Unchecked) | None) => BuiltinState::Unchecked,
    }
}

fn personal_token_from_main(app: &AppHandle) -> Result<Option<String>, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(None);
    };
    let url = tauri::Url::parse(LOGIN_URL).expect("static SoundCloud URL");
    let cookies = window
        .cookies_for_url(url)
        .map_err(|_| "Could not read the SoundCloud login session.".to_string())?;
    Ok(cookies
        .iter()
        .find(|cookie| cookie.name() == "oauth_token")
        .map(|cookie| cookie.value().trim().to_owned())
        .filter(|token| !token.is_empty()))
}

async fn personal_token(app: AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || personal_token_from_main(&app))
        .await
        .map_err(|_| "Could not read the SoundCloud login session.".to_string())?
}

/// Returns a validated personal WebView token first, otherwise the optional release token.
/// Ambiguous validation failures remain usable; only an HTTP 401 rejects a token.
pub async fn authorization(app: &AppHandle) -> Option<String> {
    if let Ok(Some(token)) = personal_token(app.clone()).await {
        if validate_token(&token).await != TokenValidation::Expired {
            return Some(token);
        }
    }

    let token = configured_builtin_token()?;
    (validate_token(&token).await != TokenValidation::Expired).then_some(token)
}

/// Reports configured/validated state and login-window availability, without credentials.
pub async fn status(app: AppHandle) -> Result<SessionStatus, String> {
    let personal_token = personal_token(app.clone()).await?;
    let builtin_token = configured_builtin_token();
    let personal_validation = async {
        match personal_token.as_deref() {
            Some(token) => Some(validate_token(token).await),
            None => None,
        }
    };
    let builtin_validation = async {
        match builtin_token.as_deref() {
            Some(token) => Some(validate_token(token).await),
            None => None,
        }
    };
    let (personal_validation, builtin_validation) =
        tokio::join!(personal_validation, builtin_validation);

    Ok(SessionStatus {
        builtin_configured: builtin_token.is_some(),
        builtin_state: builtin_state(builtin_token.as_deref(), builtin_validation),
        personal_available: personal_validation == Some(TokenValidation::Valid),
        login_open: app.get_webview_window(LOGIN_WINDOW_LABEL).is_some(),
    })
}

fn is_soundcloud_url(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| host == "soundcloud.com" || host.ends_with(".soundcloud.com"))
}

/// Opens the official login site in a visible app-profile WebView with no IPC capability.
pub fn open_login(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        window
            .show()
            .map_err(|_| "Could not show the SoundCloud login window.".to_string())?;
        window
            .set_focus()
            .map_err(|_| "Could not focus the SoundCloud login window.".to_string())?;
        return Ok(());
    }

    let url = tauri::Url::parse(LOGIN_URL).expect("static SoundCloud URL");
    WebviewWindowBuilder::new(app, LOGIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title("SoundCloud login")
        .inner_size(960.0, 720.0)
        .min_inner_size(640.0, 480.0)
        .visible(true)
        .focused(true)
        .on_navigation(is_soundcloud_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|_| "Could not open the SoundCloud login window.".to_string())?;
    Ok(())
}
