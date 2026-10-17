//! Resolve public SoundCloud media in the installed browser engine when the
//! native HTTP client is refused. The temporary webview has no remote IPC
//! capability, never becomes visible, and is destroyed on every exit path.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::{webview::PageLoadEvent, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{oneshot, Semaphore};

use crate::soundcloud::StreamInfo;

const RESOLVE_TIMEOUT: Duration = Duration::from_secs(32);
const SCRIPT: &str = include_str!("soundcloud_web.js");

pub fn close_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("sc-web-fallback-") { let _ = window.close(); }
    }
}

fn permits() -> &'static Semaphore {
    static PERMITS: OnceLock<Semaphore> = OnceLock::new();
    PERMITS.get_or_init(|| Semaphore::new(1))
}

fn site_url(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some("soundcloud.com" | "www.soundcloud.com")
        )
}

fn media_url(url: &str) -> bool {
    let Ok(url) = tauri::Url::parse(url) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| {
            host == "sndcdn.com"
                || host.ends_with(".sndcdn.com")
                || host == "soundcloud.com"
                || host.ends_with(".soundcloud.com")
        })
}

struct TemporaryWindow {
    app: AppHandle,
    label: String,
}

impl Drop for TemporaryWindow {
    fn drop(&mut self) {
        if let Some(window) = self.app.get_webview_window(&self.label) {
            let _ = window.close();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserResult {
    url: Option<String>,
    format: Option<String>,
    error: Option<String>,
    protected_duration: Option<f64>,
}

pub async fn resolve_track(
    app: AppHandle,
    track_id: &str,
    permalink: Option<&str>,
) -> Result<crate::soundcloud::TrackStream, String> {
    if track_id.is_empty() || track_id.len() > 32 || !track_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid SoundCloud track ID".into());
    }
    let _permit = permits()
        .acquire()
        .await
        .map_err(|_| "SoundCloud browser resolver stopped")?;
    let target = permalink
        .and_then(|url| tauri::Url::parse(url).ok())
        .filter(site_url)
        .unwrap_or_else(|| tauri::Url::parse("https://soundcloud.com").expect("static URL"));
    static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);
    let label = format!(
        "sc-web-fallback-{}",
        NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)
    );
    let guard = TemporaryWindow {
        app: app.clone(),
        label: label.clone(),
    };
    let token = crate::soundcloud_session::authorization(&app).await;
    let script = SCRIPT.replace(
        "__TEMPO_TRACK_ID__",
        &serde_json::to_string(track_id).map_err(|e| e.to_string())?,
    ).replace("__TEMPO_AUTH_TOKEN__", &serde_json::to_string(&token).map_err(|e| e.to_string())?);
    let started = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = oneshot::channel();
    let build_app = app.clone();
    app.run_on_main_thread(move || {
        let result = WebviewWindowBuilder::new(&build_app, label, WebviewUrl::External(target))
            .title("SoundCloud")
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .decorations(false)
            .resizable(false)
            .on_navigation(site_url)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_page_load(move |window, payload| {
                if payload.event() == PageLoadEvent::Finished
                    && site_url(payload.url())
                    && !started.swap(true, Ordering::AcqRel)
                {
                    let _ = window.eval(&script);
                }
            })
            .build()
            .map_err(|error| format!("SoundCloud browser could not start: {error}"));
        // If the caller was cancelled while creation was queued, do not leave
        // a hidden browser alive after its RAII guard has already been dropped.
        if let Err(Ok(window)) = sender.send(result) {
            let _ = window.close();
        }
    })
    .map_err(|error| format!("SoundCloud browser could not start: {error}"))?;
    let window = tokio::time::timeout(RESOLVE_TIMEOUT, receiver)
        .await
        .map_err(|_| "SoundCloud browser startup timed out".to_string())?
        .map_err(|_| "SoundCloud browser startup was interrupted".to_string())??;
    let result = tokio::time::timeout(RESOLVE_TIMEOUT, async {
        loop {
            let (sender, receiver) = oneshot::channel();
            let sender = std::sync::Mutex::new(Some(sender));
            window
                .eval_with_callback("window.__tempoScResult || null", move |value| {
                    if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                        let _ = sender.send(value);
                    }
                })
                .map_err(|error| format!("SoundCloud browser response failed: {error}"))?;
            let value = tokio::time::timeout(Duration::from_secs(3), receiver)
                .await
                .map_err(|_| "SoundCloud browser did not respond".to_string())?
                .map_err(|_| "SoundCloud browser closed".to_string())?;
            if value.len() > 32_768 {
                return Err("SoundCloud browser returned an invalid response".into());
            }
            let result = serde_json::from_str::<serde_json::Value>(&value)
                .map_err(|_| "SoundCloud browser returned an invalid response".to_string())?;
            if let Some(json) = result.as_str() {
                let result: BrowserResult = serde_json::from_str(json).map_err(|_| {
                    "SoundCloud browser returned an invalid media response".to_string()
                })?;
                if let Some(error) = result.error {
                    return Err(format!(
                        "SoundCloud browser: {}",
                        error.chars().take(400).collect::<String>()
                    ));
                }
                if let Some(duration) = result.protected_duration.filter(|duration| duration.is_finite() && *duration > 0.0 && *duration <= 604_800.0) {
                    return Ok(crate::soundcloud::TrackStream::Protected { duration });
                }
                let url = result
                    .url
                    .filter(|url| url.len() < 16_384 && media_url(url))
                    .ok_or_else(|| "SoundCloud browser returned no valid audio URL".to_string())?;
                let format = result
                    .format
                    .filter(|format| matches!(format.as_str(), "progressive" | "hls"))
                    .ok_or_else(|| {
                        "SoundCloud browser returned an unsupported audio format".to_string()
                    })?;
                return Ok(crate::soundcloud::TrackStream::Clear(StreamInfo { url, format }));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .map_err(|_| "SoundCloud browser stream resolution timed out".to_string())?;
    drop(guard);
    result
}
