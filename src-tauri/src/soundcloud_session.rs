use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::oneshot;

include!(concat!(env!("OUT_DIR"), "/soundcloud_session.rs"));

const TOKEN_ENV: &str = "TEMPO_SOUNDCLOUD_OAUTH_TOKEN";
const LOGIN_WINDOW_LABEL: &str = "sc-session-login";
const AUTO_REFRESH_WINDOW_LABEL: &str = "sc-session-refresh";
const LOGIN_URL: &str = "https://soundcloud.com";
pub const SESSION_CHANGED_EVENT: &str = "soundcloud-session-changed";
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(12);
const AUTO_REFRESH_MAX_ATTEMPT: Duration = Duration::from_secs(60);
const AUTO_REFRESH_TIMEOUT: Duration = Duration::from_secs(35);
const AUTO_REFRESH_POLL_INTERVAL: Duration = Duration::from_secs(1);
const MAX_AUTO_REFRESH_VALIDATIONS: usize = 2;
const AUTO_REFRESH_RETRY_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const VALID_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const UNCERTAIN_CACHE_TTL: Duration = Duration::from_secs(30);
const CACHE_MAX_AGE: Duration = Duration::from_secs(10 * 60);
const CACHE_CAPACITY: usize = 8;
const ELIGIBLE_MARKER: &str = "eligible-v1";
const DISABLED_MARKER: &str = "disabled-v1";

fn refresh_in_flight() -> &'static AtomicBool {
    static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
    &IN_FLIGHT
}

fn periodic_refresh_started() -> &'static AtomicBool {
    static STARTED: AtomicBool = AtomicBool::new(false);
    &STARTED
}

fn logout_generation() -> &'static AtomicU64 {
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    &GENERATION
}

fn session_marker_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinState {
    Unconfigured,
    Unchecked,
    Valid,
    Expired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PersonalState {
    Missing,
    Unchecked,
    Valid,
    Expired,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub builtin_configured: bool,
    pub builtin_state: BuiltinState,
    pub personal_state: PersonalState,
    pub personal_available: bool,
    /// A validated cookie actually present in the shared browser profile.
    pub browser_available: bool,
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

fn personal_state(token: Option<&str>, validation: Option<TokenValidation>) -> PersonalState {
    match (token, validation) {
        (None, _) => PersonalState::Missing,
        (Some(_), Some(TokenValidation::Valid)) => PersonalState::Valid,
        (Some(_), Some(TokenValidation::Expired)) => PersonalState::Expired,
        (Some(_), Some(TokenValidation::Unchecked) | None) => PersonalState::Unchecked,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RefreshEligibility {
    Unknown,
    Eligible,
    Disabled,
}

fn session_marker_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("soundcloud-personal-session"))
}

fn parse_refresh_eligibility(marker: Option<&str>) -> RefreshEligibility {
    match marker.map(str::trim) {
        Some(ELIGIBLE_MARKER) => RefreshEligibility::Eligible,
        Some(DISABLED_MARKER) => RefreshEligibility::Disabled,
        _ => RefreshEligibility::Unknown,
    }
}

fn retry_after_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("soundcloud-session-refresh-retry-after"))
}

fn refresh_eligibility(app: &AppHandle) -> RefreshEligibility {
    let Some(path) = session_marker_path(app) else {
        return RefreshEligibility::Unknown;
    };
    parse_refresh_eligibility(std::fs::read_to_string(path).ok().as_deref())
}

fn write_session_marker(app: &AppHandle, marker: &str) {
    let Some(path) = session_marker_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, marker);
}

fn remember_personal_session(app: &AppHandle, token: &str, observed_generation: u64) {
    if configured_builtin_token()
        .as_deref()
        .is_some_and(|builtin| token_fingerprint(token) == token_fingerprint(builtin))
    {
        return;
    }

    let _guard = session_marker_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if logout_generation().load(Ordering::Acquire) != observed_generation
        || refresh_eligibility(app) != RefreshEligibility::Unknown
    {
        return;
    }
    write_session_marker(app, ELIGIBLE_MARKER);
}

fn clear_refresh_retry_after(app: &AppHandle) {
    if let Some(path) = retry_after_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

fn unix_seconds() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn retry_after_is_active(retry_after: Option<u64>, now: u64) -> bool {
    retry_after.is_some_and(|deadline| now < deadline)
}

fn refresh_retry_deadline(now: u64) -> u64 {
    now.saturating_add(AUTO_REFRESH_RETRY_AFTER.as_secs())
}

fn refresh_backoff_active(app: &AppHandle) -> bool {
    let Some(path) = retry_after_path(app) else {
        return false;
    };
    let retry_after = std::fs::read_to_string(path)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok());
    retry_after_is_active(retry_after, unix_seconds().unwrap_or(0))
}

fn persist_refresh_backoff(app: &AppHandle) {
    let (Some(path), Some(now)) = (retry_after_path(app), unix_seconds()) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, refresh_retry_deadline(now).to_string());
}

fn cancel_refresh_for_logout(app: &AppHandle) -> u64 {
    let generation = logout_generation()
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    let _guard = session_marker_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    write_session_marker(app, DISABLED_MARKER);
    clear_refresh_retry_after(app);
    generation
}

fn cancel_refresh_for_manual_login(app: &AppHandle) {
    logout_generation().fetch_add(1, Ordering::AcqRel);
    if let Some(refresh) = app.get_webview_window(AUTO_REFRESH_WINDOW_LABEL) {
        let _ = refresh.close();
    }
}

fn allow_refresh_after_manual_login(app: &AppHandle) {
    let _guard = session_marker_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if refresh_eligibility(app) == RefreshEligibility::Disabled {
        if let Some(path) = session_marker_path(app) {
            let _ = std::fs::remove_file(path);
        }
        clear_refresh_retry_after(app);
    }
}

fn refresh_candidate_is_acceptable(
    token: Option<&str>,
    builtin_token: Option<&str>,
    validation: TokenValidation,
) -> bool {
    let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else {
        return false;
    };
    if builtin_token.is_some_and(|builtin| token_fingerprint(token) == token_fingerprint(builtin)) {
        return false;
    }
    validation == TokenValidation::Valid
}

fn is_builtin_cookie_token(token: &str) -> bool {
    configured_builtin_token()
        .as_deref()
        .is_some_and(|builtin| token_fingerprint(token) == token_fingerprint(builtin))
}

fn token_from_window(window: &WebviewWindow) -> Result<Option<String>, String> {
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

fn personal_token_from_main(app: &AppHandle) -> Result<Option<String>, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(None);
    };
    token_from_window(&window)
}

async fn personal_token(app: AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || personal_token_from_main(&app))
        .await
        .map_err(|_| "Could not read the SoundCloud login session.".to_string())?
}

/// Returns a validated personal WebView token first, otherwise the optional release token.
/// Ambiguous validation failures remain usable; only an HTTP 401 rejects a token.
pub async fn authorization(app: &AppHandle) -> Option<String> {
    let observed_generation = logout_generation().load(Ordering::Acquire);
    let personal = personal_token(app.clone()).await.ok().flatten();
    if let Some(token) = personal.as_deref() {
        remember_personal_session(app, token, observed_generation);
    }
    queue_automatic_refresh(app.clone());
    if let Some(token) = personal {
        if validate_token(&token).await != TokenValidation::Expired {
            return Some(token);
        }
    }

    let token = configured_builtin_token()?;
    (validate_token(&token).await != TokenValidation::Expired).then_some(token)
}

/// Reports configured/validated state and login-window availability, without credentials.
pub async fn status(app: AppHandle) -> Result<SessionStatus, String> {
    let observed_generation = logout_generation().load(Ordering::Acquire);
    let personal_token = personal_token(app.clone()).await?;
    if let Some(token) = personal_token.as_deref() {
        remember_personal_session(&app, token, observed_generation);
    }
    queue_automatic_refresh(app.clone());
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
    let browser_available = personal_validation == Some(TokenValidation::Valid);
    let browser_uses_builtin = personal_token
        .as_deref()
        .zip(builtin_token.as_deref())
        .is_some_and(|(cookie, builtin)| token_fingerprint(cookie) == token_fingerprint(builtin));

    Ok(SessionStatus {
        builtin_configured: builtin_token.is_some(),
        builtin_state: builtin_state(builtin_token.as_deref(), builtin_validation),
        personal_state: if browser_uses_builtin {
            PersonalState::Missing
        } else {
            personal_state(personal_token.as_deref(), personal_validation)
        },
        personal_available: browser_available && !browser_uses_builtin,
        browser_available,
        login_open: app.get_webview_window(LOGIN_WINDOW_LABEL).is_some(),
    })
}

fn is_soundcloud_cookie(cookie: &tauri::webview::Cookie<'_>) -> bool {
    cookie.domain().is_some_and(|domain| {
        let domain = domain.trim_start_matches('.');
        domain.eq_ignore_ascii_case("soundcloud.com")
            || domain.to_ascii_lowercase().ends_with(".soundcloud.com")
    })
}

fn clear_soundcloud_cookies(app: &AppHandle) -> Result<(), String> {
    let Some(main) = app.get_webview_window("main") else {
        return Err("Could not access the SoundCloud login session.".to_string());
    };
    let cookies = main
        .cookies()
        .map_err(|_| "Could not clear the SoundCloud login session.".to_string())?;

    for cookie in cookies.into_iter().filter(is_soundcloud_cookie) {
        main.delete_cookie(cookie)
            .map_err(|_| "Could not clear the SoundCloud login session.".to_string())?;
    }

    let remaining = main
        .cookies()
        .map_err(|_| "Could not verify the SoundCloud logout.".to_string())?;
    if remaining.iter().any(is_soundcloud_cookie) {
        return Err("Could not clear the SoundCloud login session.".to_string());
    }
    Ok(())
}

/// Signs out of a personal SoundCloud cookie session without affecting the built-in session.
pub async fn logout(app: AppHandle) -> Result<(), String> {
    cancel_refresh_for_logout(&app);
    if let Some(refresh) = app.get_webview_window(AUTO_REFRESH_WINDOW_LABEL) {
        let _ = refresh.close();
    }
    if let Some(login) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = login.close();
    }
    let cookie = personal_token(app.clone()).await?;
    if cookie.is_none() {
        return Err("No personal SoundCloud session is signed in.".to_string());
    }
    if cookie
        .as_deref()
        .zip(configured_builtin_token().as_deref())
        .is_some_and(|(cookie, builtin)| token_fingerprint(cookie) == token_fingerprint(builtin))
    {
        return Err("The built-in SoundCloud session cannot be signed out.".into());
    }

    // Stop work and close every SoundCloud page before removing its shared cookies so no
    // live page can continue using an already-authenticated JavaScript session.
    crate::soundcloud_recording::cancel_all(&app);
    crate::soundcloud_browser::close_all(&app);
    crate::soundcloud_web::close_all(&app);
    if let Some(login) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        login
            .close()
            .map_err(|_| "Could not close the SoundCloud login window.".to_string())?;
    }

    // WebView2 cookie access waits for the UI thread, so keep both enumeration and deletion
    // off the async executor and verify that no SoundCloud-domain cookies remain.
    let app_for_clear = app.clone();
    let clear_result =
        tauri::async_runtime::spawn_blocking(move || clear_soundcloud_cookies(&app_for_clear))
            .await
            .unwrap_or_else(|_| Err("Could not clear the SoundCloud login session.".to_string()));

    validation_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
    // The unit payload is intentionally credential-free; listeners refresh the status.
    let _ = app.emit(SESSION_CHANGED_EVENT, ());
    clear_result
}

enum RefreshAttemptResult {
    Valid,
    Failed,
    Cancelled,
}

struct TemporaryRefreshWindow {
    app: AppHandle,
    cancelled: std::sync::Arc<AtomicBool>,
}

impl Drop for TemporaryRefreshWindow {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(window) = self.app.get_webview_window(AUTO_REFRESH_WINDOW_LABEL) {
            let _ = window.close();
        }
    }
}

async fn refresh_cookie_in_background(app: AppHandle, generation: u64) -> RefreshAttemptResult {
    if logout_generation().load(Ordering::Acquire) != generation {
        return RefreshAttemptResult::Cancelled;
    }

    let initial_token = personal_token(app.clone()).await.ok().flatten();
    let initial_fingerprint = initial_token.as_deref().map(token_fingerprint);
    if logout_generation().load(Ordering::Acquire) != generation {
        return RefreshAttemptResult::Cancelled;
    }

    let (created_tx, created_rx) = oneshot::channel();
    let (loaded_tx, loaded_rx) = oneshot::channel();
    let loaded_tx = std::sync::Arc::new(Mutex::new(Some(loaded_tx)));
    let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    let _window_guard = TemporaryRefreshWindow {
        app: app.clone(),
        cancelled: cancelled.clone(),
    };
    let build_app = app.clone();
    let build_loaded_tx = loaded_tx.clone();
    let build_cancelled = cancelled.clone();
    let build_url = tauri::Url::parse(LOGIN_URL).expect("static SoundCloud URL");
    let build_generation = generation;
    tokio::task::spawn_blocking(move || {
        if build_cancelled.load(Ordering::Acquire)
            || logout_generation().load(Ordering::Acquire) != build_generation
        {
            let _ = created_tx.send(Err("cancelled".to_string()));
            return;
        }

        let result = WebviewWindowBuilder::new(
            &build_app,
            AUTO_REFRESH_WINDOW_LABEL,
            WebviewUrl::External(build_url),
        )
        .title("SoundCloud session refresh")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .decorations(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(is_soundcloud_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished && is_soundcloud_url(payload.url()) {
                if let Some(sender) = build_loaded_tx
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                {
                    let _ = sender.send(());
                }
            }
        })
        .build()
        .map_err(|_| "could not create refresh window".to_string());

        if build_cancelled.load(Ordering::Acquire)
            || logout_generation().load(Ordering::Acquire) != build_generation
        {
            if let Ok(window) = result {
                let _ = window.close();
            }
            let _ = created_tx.send(Err("cancelled".to_string()));
            return;
        }
        if let Err(result) = created_tx.send(result) {
            if let Ok(window) = result {
                let _ = window.close();
            }
        }
    });

    let window = match tokio::time::timeout(Duration::from_secs(8), created_rx).await {
        Ok(Ok(Ok(window))) => window,
        _ if logout_generation().load(Ordering::Acquire) != generation => {
            return RefreshAttemptResult::Cancelled;
        }
        _ => return RefreshAttemptResult::Failed,
    };

    if !matches!(
        tokio::time::timeout(Duration::from_secs(20), loaded_rx).await,
        Ok(Ok(()))
    ) || logout_generation().load(Ordering::Acquire) != generation
    {
        return if logout_generation().load(Ordering::Acquire) == generation {
            RefreshAttemptResult::Failed
        } else {
            RefreshAttemptResult::Cancelled
        };
    }
    let deadline = Instant::now() + AUTO_REFRESH_TIMEOUT;
    let mut validated = std::collections::HashSet::<[u8; 32]>::new();
    let mut validation_count = 0;
    let final_candidate = loop {
        if logout_generation().load(Ordering::Acquire) != generation {
            return RefreshAttemptResult::Cancelled;
        }
        let cookie_window = window.clone();
        let candidate = tokio::task::spawn_blocking(move || token_from_window(&cookie_window))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten();
        if logout_generation().load(Ordering::Acquire) != generation {
            return RefreshAttemptResult::Cancelled;
        }

        let changed = candidate.as_deref().map(token_fingerprint) != initial_fingerprint;
        let fingerprint = candidate.as_deref().map(token_fingerprint);
        let should_validate_changed = changed
            && fingerprint.is_some_and(|fingerprint| !validated.contains(&fingerprint))
            && candidate
                .as_deref()
                .is_some_and(|token| !is_builtin_cookie_token(token))
            && validation_count < MAX_AUTO_REFRESH_VALIDATIONS;
        if should_validate_changed {
            let token = candidate.as_deref().unwrap_or_default();
            let fingerprint = token_fingerprint(token);
            validated.insert(fingerprint);
            validation_count += 1;
            let validation = validate_token_with_soundcloud(token).await;
            if logout_generation().load(Ordering::Acquire) != generation {
                return RefreshAttemptResult::Cancelled;
            }
            if refresh_candidate_is_acceptable(
                Some(token),
                configured_builtin_token().as_deref(),
                validation,
            ) {
                remember_validation(fingerprint, TokenValidation::Valid);
                return RefreshAttemptResult::Valid;
            }
        }

        if Instant::now() >= deadline {
            break candidate;
        }
        tokio::time::sleep(AUTO_REFRESH_POLL_INTERVAL).await;
    };

    // A final fresh validation distinguishes an unchanged but still-usable cookie
    // from a refresh that ended at the login page. No repeated polling requests are sent.
    let Some(candidate) = final_candidate else {
        return RefreshAttemptResult::Failed;
    };
    if is_builtin_cookie_token(&candidate) {
        return RefreshAttemptResult::Failed;
    }
    let fingerprint = token_fingerprint(&candidate);
    if validated.contains(&fingerprint) || validation_count >= MAX_AUTO_REFRESH_VALIDATIONS {
        return RefreshAttemptResult::Failed;
    }
    let validation = validate_token_with_soundcloud(&candidate).await;
    if logout_generation().load(Ordering::Acquire) != generation {
        return RefreshAttemptResult::Cancelled;
    }
    if refresh_candidate_is_acceptable(
        Some(&candidate),
        configured_builtin_token().as_deref(),
        validation,
    ) {
        remember_validation(fingerprint, TokenValidation::Valid);
        RefreshAttemptResult::Valid
    } else {
        RefreshAttemptResult::Failed
    }
}

fn queue_automatic_refresh(app: AppHandle) {
    if refresh_in_flight()
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let generation = logout_generation().load(Ordering::Acquire);
    tauri::async_runtime::spawn(async move {
        struct InFlightReset;
        impl Drop for InFlightReset {
            fn drop(&mut self) {
                refresh_in_flight().store(false, Ordering::Release);
            }
        }
        let _reset = InFlightReset;

        if refresh_eligibility(&app) != RefreshEligibility::Eligible
            || refresh_backoff_active(&app)
            || logout_generation().load(Ordering::Acquire) != generation
            || app.get_webview_window(LOGIN_WINDOW_LABEL).is_some()
        {
            return;
        }

        // A cookie that matches the release token is not a personal session. Never
        // refresh it or treat it as the user's own login.
        let current_token = personal_token(app.clone()).await.ok().flatten();
        if logout_generation().load(Ordering::Acquire) != generation {
            return;
        }
        if let Some(token) = current_token.as_deref() {
            if is_builtin_cookie_token(token) {
                return;
            }
            if validate_token(token).await == TokenValidation::Valid {
                return;
            }
        }
        if logout_generation().load(Ordering::Acquire) != generation {
            return;
        }

        let result = match tokio::time::timeout(
            AUTO_REFRESH_MAX_ATTEMPT,
            refresh_cookie_in_background(app.clone(), generation),
        )
        .await
        {
            Ok(result) => result,
            Err(_) if logout_generation().load(Ordering::Acquire) != generation => {
                RefreshAttemptResult::Cancelled
            }
            Err(_) => RefreshAttemptResult::Failed,
        };
        if logout_generation().load(Ordering::Acquire) != generation {
            return;
        }
        match result {
            RefreshAttemptResult::Valid => {
                clear_refresh_retry_after(&app);
                let _ = app.emit(SESSION_CHANGED_EVENT, ());
            }
            RefreshAttemptResult::Failed => {
                persist_refresh_backoff(&app);
                let retry_app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(AUTO_REFRESH_RETRY_AFTER).await;
                    queue_automatic_refresh(retry_app);
                });
            }
            RefreshAttemptResult::Cancelled => {}
        }
    });
}

/// Schedule a hidden refresh only for a previously observed personal session.
/// The call is single-flight and returns immediately so playback is unaffected.
pub fn start_automatic_refresh(app: AppHandle) {
    if periodic_refresh_started()
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        let observed_generation = logout_generation().load(Ordering::Acquire);
        if let Ok(Some(token)) = personal_token(app.clone()).await {
            remember_personal_session(&app, &token, observed_generation);
        }
        queue_automatic_refresh(app.clone());

        loop {
            tokio::time::sleep(Duration::from_secs(60 * 60)).await;
            let observed_generation = logout_generation().load(Ordering::Acquire);
            if let Ok(Some(token)) = personal_token(app.clone()).await {
                remember_personal_session(&app, &token, observed_generation);
            }
            queue_automatic_refresh(app.clone());
        }
    });
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
    cancel_refresh_for_manual_login(app);
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
        allow_refresh_after_manual_login(app);
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
    allow_refresh_after_manual_login(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_eligibility_requires_a_remembered_personal_session() {
        assert_eq!(parse_refresh_eligibility(None), RefreshEligibility::Unknown);
        assert_eq!(
            parse_refresh_eligibility(Some(ELIGIBLE_MARKER)),
            RefreshEligibility::Eligible
        );
        assert_eq!(
            parse_refresh_eligibility(Some(DISABLED_MARKER)),
            RefreshEligibility::Disabled
        );
        assert_eq!(
            parse_refresh_eligibility(Some("unexpected")),
            RefreshEligibility::Unknown
        );
    }

    #[test]
    fn retry_backoff_expires_at_the_persisted_deadline() {
        let retry_after = refresh_retry_deadline(1_000);
        assert_eq!(retry_after, 1_000 + 24 * 60 * 60);
        assert!(retry_after_is_active(Some(retry_after), retry_after - 1));
        assert!(!retry_after_is_active(Some(retry_after), retry_after));
        assert!(!retry_after_is_active(None, retry_after));
    }

    #[test]
    fn only_a_valid_non_builtin_cookie_can_be_accepted() {
        assert!(refresh_candidate_is_acceptable(
            Some("personal-token"),
            Some("release-token"),
            TokenValidation::Valid,
        ));
        assert!(!refresh_candidate_is_acceptable(
            Some("release-token"),
            Some("release-token"),
            TokenValidation::Valid,
        ));
        assert!(!refresh_candidate_is_acceptable(
            Some("personal-token"),
            Some("release-token"),
            TokenValidation::Expired,
        ));
        assert!(!refresh_candidate_is_acceptable(
            Some("personal-token"),
            Some("release-token"),
            TokenValidation::Unchecked,
        ));
        assert!(!refresh_candidate_is_acceptable(
            None,
            Some("release-token"),
            TokenValidation::Valid,
        ));
    }
}
