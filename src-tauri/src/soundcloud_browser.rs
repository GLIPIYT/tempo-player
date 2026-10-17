//! Hidden SoundCloud Widget transport used for protected tracks.
//!
//! The local host owns the official Widget iframe. JavaScript injected at
//! document start is inert outside SoundCloud's exact player origin. Native
//! code only sends validated, narrow commands to the local host and polls a
//! bounded event queue; the remote frame has no Tauri IPC capability.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

const WINDOW_LABEL_PREFIX: &str = "tempo-soundcloud-playback-";
const HOST_URL: &str = "tempo-sc-playback://localhost/host.html";
const FRAME_INIT: &str = include_str!("soundcloud_browser/frame_init.js");
const START_TIMEOUT: Duration = Duration::from_secs(30);
const HOST_READY_TIMEOUT: Duration = Duration::from_secs(8);
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_PERIOD: Duration = Duration::from_millis(40);
const MAX_CALLBACK_BYTES: usize = 64 * 1024;
const MAX_DURATION_SECONDS: f64 = 604_800.0;

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
static ACTIVE_SESSION: AtomicU64 = AtomicU64::new(0);
static CLOSE_EPOCH: AtomicU64 = AtomicU64::new(0);

fn start_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

#[derive(Clone, Debug)]
pub struct BrowserDescriptor {
    pub track_id: String,
    pub duration: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct BrowserSettings {
    pub volume: f64,
    pub playback_rate: f64,
    pub preserve_pitch: bool,
    pub equalizer_enabled: bool,
    pub equalizer_gains: [f64; 10],
    pub gain_db: f64,
    pub spectrum_enabled: bool,
}

#[derive(Clone, Debug)]
pub enum BrowserEvent {
    Ready {
        duration: f64,
    },
    Clock {
        position: f64,
        duration: f64,
        playing: bool,
        buffering: bool,
    },
    Finished,
    Failed(String),
    Spectrum(Vec<f64>),
    Capabilities {
        equalizer: bool,
        gain: bool,
        spectrum: bool,
        error: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartConfig<'a> {
    track_id: &'a str,
    expected_duration: f64,
    generation: u64,
    nonce: &'a str,
    position: f64,
    playing: bool,
    settings: SettingsPayload,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsPayload {
    volume: f64,
    playback_rate: f64,
    preserve_pitch: bool,
    equalizer_enabled: bool,
    equalizer_gains: [f64; 10],
    gain_db: f64,
    spectrum_enabled: bool,
}

impl BrowserSettings {
    fn validated(self) -> Result<SettingsPayload, String> {
        let scalar_values = [self.volume, self.playback_rate, self.gain_db];
        if scalar_values.iter().any(|value| !value.is_finite())
            || self.equalizer_gains.iter().any(|value| !value.is_finite())
        {
            return Err("SoundCloud playback settings are invalid.".into());
        }
        Ok(SettingsPayload {
            volume: self.volume.clamp(0.0, 1.0),
            playback_rate: self.playback_rate.clamp(0.5, 2.0),
            preserve_pitch: self.preserve_pitch,
            equalizer_enabled: self.equalizer_enabled,
            equalizer_gains: self.equalizer_gains.map(|value| value.clamp(-18.0, 18.0)),
            gain_db: self.gain_db.clamp(-36.0, 36.0),
            spectrum_enabled: self.spectrum_enabled,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandPayload<'a> {
    nonce: &'a str,
    generation: u64,
    track_id: &'a str,
    command: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    settings: Option<SettingsPayload>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HostEvent {
    Ready {
        duration: f64,
    },
    Clock {
        position: f64,
        duration: f64,
        playing: bool,
        buffering: bool,
    },
    Finished,
    Failed {
        code: String,
    },
    Spectrum {
        bins: Vec<f64>,
    },
    Capabilities {
        equalizer: bool,
        gain: bool,
        spectrum: bool,
        error: Option<String>,
    },
}

#[derive(Deserialize)]
struct HostBatch {
    events: Vec<HostEvent>,
}

/// RAII owner for the single hidden Widget webview.
///
/// Commands are scoped to this handle's random nonce, generation and track ID.
/// Dropping the current owner stops playback and closes the hidden webview.
pub struct BrowserPlayback {
    app: AppHandle,
    window: WebviewWindow,
    track_id: String,
    duration: f64,
    generation: u64,
    nonce: String,
    session: u64,
}

impl BrowserPlayback {
    pub fn play(&self) -> Result<(), String> {
        self.send_command("play", None, None)
    }

    pub fn pause(&self) -> Result<(), String> {
        self.send_command("pause", None, None)
    }

    pub fn seek(&self, position: f64) -> Result<(), String> {
        if !position.is_finite() {
            return Err("SoundCloud seek position is invalid.".into());
        }
        self.send_command("seek", Some(position.clamp(0.0, self.duration)), None)
    }

    pub fn configure(&self, settings: BrowserSettings) -> Result<(), String> {
        self.send_command("configure", None, Some(settings.validated()?))
    }

    fn send_command(
        &self,
        command: &'static str,
        position: Option<f64>,
        settings: Option<SettingsPayload>,
    ) -> Result<(), String> {
        if ACTIVE_SESSION.load(Ordering::Acquire) != self.session {
            return Err("SoundCloud playback session is no longer active.".into());
        }
        let payload = CommandPayload {
            nonce: &self.nonce,
            generation: self.generation,
            track_id: &self.track_id,
            command,
            position,
            settings,
        };
        let json = serde_json::to_string(&payload)
            .map_err(|_| "Could not prepare SoundCloud playback command.".to_string())?;
        self.window
            .eval(&format!(
                "window.__tempoHost && window.__tempoHost.command({json});"
            ))
            .map_err(|_| "SoundCloud playback window is unavailable.".to_string())
    }
}

impl Drop for BrowserPlayback {
    fn drop(&mut self) {
        let _ =
            ACTIVE_SESSION.compare_exchange(self.session, 0, Ordering::AcqRel, Ordering::Acquire);
        // Each playback owns a unique label, so an older drop can never close
        // a newer selection even while its native close is still queued.
        stop_window(&self.app, &self.window);
    }
}

/// Start a hidden Widget transport and wait until it has verified the loaded
/// track identity and duration. The returned transport is owned by the caller.
pub async fn start(
    app: AppHandle,
    descriptor: BrowserDescriptor,
    settings: BrowserSettings,
    position: f64,
    playing: bool,
    generation: u64,
    events: std::sync::mpsc::Sender<BrowserEvent>,
) -> Result<BrowserPlayback, String> {
    validate_descriptor(&descriptor)?;
    let settings = settings.validated()?;
    if !position.is_finite() {
        return Err("SoundCloud playback position is invalid.".into());
    }
    // JavaScript transports this value as Number and rejects unsafe integers.
    if generation > 9_007_199_254_740_991 {
        return Err("SoundCloud playback generation is invalid.".into());
    }

    let epoch = CLOSE_EPOCH.load(Ordering::Acquire);
    let _start_guard = start_lock().lock().await;
    if CLOSE_EPOCH.load(Ordering::Acquire) != epoch {
        return Err("SoundCloud playback was cancelled.".into());
    }
    if ACTIVE_SESSION.load(Ordering::Acquire) != 0 {
        return Err("A SoundCloud browser playback session is already active.".into());
    }

    let session = NEXT_SESSION.fetch_add(1, Ordering::Relaxed).max(1);
    ACTIVE_SESSION
        .compare_exchange(0, session, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "A SoundCloud browser playback session is already active.".to_string())?;
    let mut cleanup = StartupCleanup {
        app: app.clone(),
        session,
        label: session_label(session),
        armed: true,
    };

    let window = ensure_window(app.clone(), session, cleanup.label.clone(), epoch).await?;
    check_session(session, epoch)?;
    let nonce = make_nonce(session);
    let config = StartConfig {
        track_id: &descriptor.track_id,
        expected_duration: descriptor.duration,
        generation,
        nonce: &nonce,
        position: position.clamp(0.0, descriptor.duration),
        playing,
        settings,
    };
    let json = serde_json::to_string(&config)
        .map_err(|_| "Could not prepare SoundCloud playback.".to_string())?;
    let started = eval_value::<bool>(
        &window,
        format!("Boolean(window.__tempoHost && window.__tempoHost.start({json}))"),
        HOST_READY_TIMEOUT,
    )
    .await?;
    if !started {
        return Err("SoundCloud playback host rejected the track.".into());
    }
    check_session(session, epoch)?;

    let (ready_tx, ready_rx) = oneshot::channel();
    let poll_window = window.clone();
    let poll_events = events.clone();
    let poll_session = session;
    let poll_epoch = epoch;
    let expected_duration = descriptor.duration;
    tauri::async_runtime::spawn(async move {
        poll_host(
            poll_window,
            poll_events,
            ready_tx,
            expected_duration,
            poll_session,
            poll_epoch,
        )
        .await;
    });

    match tokio::time::timeout(START_TIMEOUT, ready_rx).await {
        Ok(Ok(Ok(actual_duration))) => {
            check_session(session, epoch)?;
            cleanup.armed = false;
            Ok(BrowserPlayback {
                app,
                window,
                track_id: descriptor.track_id,
                duration: actual_duration,
                generation,
                nonce,
                session,
            })
        }
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err("SoundCloud playback startup was interrupted.".into()),
        Err(_) => Err("SoundCloud playback startup timed out.".into()),
    }
}

/// Stop and invalidate the hidden Widget transport, including an in-progress
/// startup. This is intended for session logout and application shutdown.
pub fn close_all(app: &AppHandle) {
    CLOSE_EPOCH.fetch_add(1, Ordering::AcqRel);
    ACTIVE_SESSION.store(0, Ordering::Release);
    for (label, window) in app.webview_windows() {
        if !label.starts_with(WINDOW_LABEL_PREFIX) {
            continue;
        }
        stop_window(app, &window);
    }
}

/// Serve the fixed local host assets registered under `tempo-sc-playback`.
/// Only GET requests to the two embedded paths are accepted.
pub fn host_response(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Method, Response, StatusCode};

    let (status, content_type, body) = if request.method() != Method::GET {
        (
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain; charset=utf-8",
            &b"Method not allowed"[..],
        )
    } else if request.uri().query().is_some() {
        (
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            &b"Not found"[..],
        )
    } else {
        match request.uri().path() {
            "/host.html" => (
                StatusCode::OK,
                "text/html; charset=utf-8",
                include_bytes!("soundcloud_browser/host.html").as_slice(),
            ),
            "/host.js" => (
                StatusCode::OK,
                "text/javascript; charset=utf-8",
                include_bytes!("soundcloud_browser/host.js").as_slice(),
            ),
            _ => (
                StatusCode::NOT_FOUND,
                "text/plain; charset=utf-8",
                &b"Not found"[..],
            ),
        }
    };

    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "strict-origin-when-cross-origin")
        .header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self' https://w.soundcloud.com; style-src 'unsafe-inline'; frame-src https://w.soundcloud.com; connect-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        .body(body.to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn validate_descriptor(descriptor: &BrowserDescriptor) -> Result<(), String> {
    if descriptor.track_id.is_empty()
        || descriptor.track_id.len() > 32
        || !descriptor
            .track_id
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    {
        return Err("SoundCloud track ID is invalid.".into());
    }
    if !descriptor.duration.is_finite()
        || descriptor.duration <= 0.0
        || descriptor.duration > MAX_DURATION_SECONDS
    {
        return Err("SoundCloud track duration is invalid.".into());
    }
    Ok(())
}

fn make_nonce(session: u64) -> String {
    // This is a per-session correlation value, not an authentication secret.
    let random = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{session:x}-{:x}",
        random ^ ((std::process::id() as u128) << 64)
    )
}

fn session_label(session: u64) -> String {
    format!("{WINDOW_LABEL_PREFIX}{session:x}")
}

fn check_session(session: u64, epoch: u64) -> Result<(), String> {
    if ACTIVE_SESSION.load(Ordering::Acquire) != session
        || CLOSE_EPOCH.load(Ordering::Acquire) != epoch
    {
        Err("SoundCloud playback was cancelled.".into())
    } else {
        Ok(())
    }
}

async fn ensure_window(
    app: AppHandle,
    session: u64,
    label: String,
    epoch: u64,
) -> Result<WebviewWindow, String> {
    let (sender, receiver) = oneshot::channel();
    let build_app = app.clone();
    app.run_on_main_thread(move || {
        let result = if ACTIVE_SESSION.load(Ordering::Acquire) != session
            || CLOSE_EPOCH.load(Ordering::Acquire) != epoch
        {
            Err("SoundCloud playback was cancelled.".to_string())
        } else {
            let url = tauri::Url::parse(HOST_URL)
                .map_err(|_| "SoundCloud playback host URL is invalid.".to_string());
            match url {
                Ok(url) => {
                    WebviewWindowBuilder::new(&build_app, label, WebviewUrl::CustomProtocol(url))
                        .title("Tempo SoundCloud playback")
                        .visible(false)
                        .focused(false)
                        .skip_taskbar(true)
                        .decorations(false)
                        .resizable(false)
                        .inner_size(1.0, 1.0)
                        .background_throttling(
                            tauri::utils::config::BackgroundThrottlingPolicy::Disabled,
                        )
                        .initialization_script_for_all_frames(FRAME_INIT)
                        .on_navigation(|url| allowed_host_navigation(url))
                        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                        .build()
                        .map_err(|_| "SoundCloud playback host could not start.".to_string())
                }
                Err(error) => Err(error),
            }
        };
        if let Err(Ok(window)) = sender.send(result) {
            let _ = window.close();
        }
    })
    .map_err(|_| "SoundCloud playback host could not start.".to_string())?;

    let window = tokio::time::timeout(HOST_READY_TIMEOUT, receiver)
        .await
        .map_err(|_| "SoundCloud playback host startup timed out.".to_string())?
        .map_err(|_| "SoundCloud playback host startup was interrupted.".to_string())??;
    if let Err(error) = check_session(session, epoch) {
        let _ = window.close();
        return Err(error);
    }

    if eval_value::<bool>(
        &window,
        "Boolean(window.__tempoHost && window.__tempoHost.ready === true)".into(),
        HOST_READY_TIMEOUT,
    )
    .await
    .unwrap_or(false)
    {
        return Ok(window);
    }

    let deadline = tokio::time::Instant::now() + HOST_READY_TIMEOUT;
    loop {
        check_session(session, epoch)?;
        if tokio::time::Instant::now() >= deadline {
            return Err("SoundCloud playback host did not become ready.".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        if eval_value::<bool>(
            &window,
            "Boolean(window.__tempoHost && window.__tempoHost.ready === true)".into(),
            CALLBACK_TIMEOUT,
        )
        .await
        .unwrap_or(false)
        {
            return Ok(window);
        }
    }
}

fn allowed_host_navigation(url: &tauri::Url) -> bool {
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    match (url.scheme(), url.host_str()) {
        ("tempo-sc-playback", Some("localhost")) => {
            matches!(url.path(), "/host.html" | "/host.js")
        }
        ("http", Some("tempo-sc-playback.localhost")) => {
            matches!(url.path(), "/host.html" | "/host.js")
        }
        _ => false,
    }
}

async fn eval_value<T: for<'de> Deserialize<'de>>(
    window: &WebviewWindow,
    script: String,
    timeout: Duration,
) -> Result<T, String> {
    let (sender, receiver) = oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = sender.clone();
    window
        .eval_with_callback(script, move |value| {
            if let Ok(mut slot) = callback_sender.lock() {
                if let Some(sender) = slot.take() {
                    let _ = sender.send(value);
                }
            }
        })
        .map_err(|_| "SoundCloud playback host did not respond.".to_string())?;
    let raw = tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| "SoundCloud playback host did not respond.".to_string())?
        .map_err(|_| "SoundCloud playback host closed.".to_string())?;
    if raw.len() > MAX_CALLBACK_BYTES {
        return Err("SoundCloud playback host returned an invalid response.".into());
    }
    let outer: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "SoundCloud playback host returned an invalid response.".to_string())?;
    let value = if let Some(inner) = outer.as_str() {
        serde_json::from_str(inner)
            .map_err(|_| "SoundCloud playback host returned an invalid response.".to_string())?
    } else {
        outer
    };
    serde_json::from_value(value)
        .map_err(|_| "SoundCloud playback host returned an invalid response.".to_string())
}

#[allow(clippy::too_many_arguments)]
async fn poll_host(
    window: WebviewWindow,
    events: std::sync::mpsc::Sender<BrowserEvent>,
    ready: oneshot::Sender<Result<f64, String>>,
    expected_duration: f64,
    session: u64,
    epoch: u64,
) {
    let mut ready_sender = Some(ready);
    let mut ready_duration = None;
    let mut finish_sent = false;
    let mut capabilities_last: Option<(bool, bool, bool, Option<String>)> = None;
    let mut failures = 0u8;
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    let mut interval = tokio::time::interval(POLL_PERIOD);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;
        if ACTIVE_SESSION.load(Ordering::Acquire) != session
            || CLOSE_EPOCH.load(Ordering::Acquire) != epoch
        {
            if let Some(sender) = ready_sender.take() {
                let _ = sender.send(Err("SoundCloud playback was cancelled.".into()));
            }
            return;
        }
        if ready_duration.is_none() && tokio::time::Instant::now() >= deadline {
            report_failure(
                &events,
                &mut ready_sender,
                "SoundCloud playback startup timed out.",
            );
            close_session_window(&window, session);
            return;
        }

        let batch = eval_value::<HostBatch>(
            &window,
            "window.__tempoHost ? window.__tempoHost.drain() : {events: []}".into(),
            CALLBACK_TIMEOUT,
        )
        .await;
        let batch = match batch {
            Ok(batch) if batch.events.len() <= 32 => {
                failures = 0;
                batch
            }
            _ => {
                failures = failures.saturating_add(1);
                if failures >= 5 {
                    report_failure(
                        &events,
                        &mut ready_sender,
                        "SoundCloud playback host stopped responding.",
                    );
                    close_session_window(&window, session);
                    return;
                }
                continue;
            }
        };

        for event in batch.events {
            if ACTIVE_SESSION.load(Ordering::Acquire) != session
                || CLOSE_EPOCH.load(Ordering::Acquire) != epoch
            {
                return;
            }
            match event {
                HostEvent::Ready { duration } => {
                    let tolerance = (expected_duration * 0.01).max(2.0);
                    if !duration.is_finite()
                        || duration <= 0.0
                        || duration > MAX_DURATION_SECONDS
                        || (duration - expected_duration).abs() > tolerance
                    {
                        report_failure(
                            &events,
                            &mut ready_sender,
                            "SoundCloud track verification failed.",
                        );
                        close_session_window(&window, session);
                        return;
                    }
                    if ready_duration.is_none() {
                        ready_duration = Some(duration);
                        let _ = events.send(BrowserEvent::Ready { duration });
                        if let Some(sender) = ready_sender.take() {
                            let _ = sender.send(Ok(duration));
                        }
                    }
                }
                HostEvent::Clock {
                    position,
                    duration,
                    playing,
                    buffering,
                } => {
                    if ready_duration.is_none()
                        || !position.is_finite()
                        || !duration.is_finite()
                        || duration <= 0.0
                    {
                        continue;
                    }
                    let duration = duration.clamp(0.0, expected_duration);
                    let position = position.clamp(0.0, duration.max(0.0));
                    let _ = events.send(BrowserEvent::Clock {
                        position,
                        duration,
                        playing,
                        buffering,
                    });
                }
                HostEvent::Finished => {
                    if ready_duration.is_some() && !finish_sent {
                        finish_sent = true;
                        let _ = events.send(BrowserEvent::Finished);
                    }
                }
                HostEvent::Failed { code } => {
                    let message = safe_failure_message(&code);
                    report_failure(&events, &mut ready_sender, message);
                    close_session_window(&window, session);
                    return;
                }
                HostEvent::Spectrum { bins } => {
                    if ready_duration.is_some() && bins.len() == 64 {
                        let bins = bins
                            .into_iter()
                            .map(|bin| {
                                if bin.is_finite() {
                                    bin.clamp(0.0, 1.0)
                                } else {
                                    0.0
                                }
                            })
                            .collect();
                        let _ = events.send(BrowserEvent::Spectrum(bins));
                    }
                }
                HostEvent::Capabilities {
                    equalizer,
                    gain,
                    spectrum,
                    error,
                } => {
                    let error = match error.as_deref() {
                        Some("audio-processing-unavailable") => Some(
                            "SoundCloud playback continues, but audio processing is unavailable."
                                .to_string(),
                        ),
                        Some(_) => Some("SoundCloud audio processing is unavailable.".to_string()),
                        None => None,
                    };
                    let current = (equalizer, gain, spectrum, error.clone());
                    if capabilities_last.as_ref() != Some(&current) {
                        capabilities_last = Some(current);
                        let _ = events.send(BrowserEvent::Capabilities {
                            equalizer,
                            gain,
                            spectrum,
                            error,
                        });
                    }
                }
            }
        }
    }
}

fn safe_failure_message(code: &str) -> &'static str {
    match code {
        "track_id_mismatch" | "duration_mismatch" => "SoundCloud track verification failed.",
        "track_access_failed" => "SoundCloud could not play this track.",
        "widget_api_unavailable" => "SoundCloud playback is unavailable in this browser.",
        "widget_startup_timeout" => "SoundCloud playback did not become ready.",
        _ => "SoundCloud playback failed.",
    }
}

fn report_failure(
    events: &std::sync::mpsc::Sender<BrowserEvent>,
    ready: &mut Option<oneshot::Sender<Result<f64, String>>>,
    message: &str,
) {
    let message = message.to_string();
    let _ = events.send(BrowserEvent::Failed(message.clone()));
    if let Some(sender) = ready.take() {
        let _ = sender.send(Err(message));
    }
}

fn close_session_window(window: &WebviewWindow, session: u64) {
    let _ = ACTIVE_SESSION.compare_exchange(session, 0, Ordering::AcqRel, Ordering::Acquire);
    let _ = window.close();
}

fn stop_window(app: &AppHandle, window: &WebviewWindow) {
    let _ = window.eval("if (window.__tempoHost) window.__tempoHost.prepareForReplacement();");
    let close_on_main = window.clone();
    if app
        .run_on_main_thread(move || {
            let _ = close_on_main.close();
        })
        .is_err()
    {
        let _ = window.close();
    }
}

struct StartupCleanup {
    app: AppHandle,
    session: u64,
    label: String,
    armed: bool,
}

impl Drop for StartupCleanup {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let _ =
            ACTIVE_SESSION.compare_exchange(self.session, 0, Ordering::AcqRel, Ordering::Acquire);
        if let Some(window) = self.app.get_webview_window(&self.label) {
            stop_window(&self.app, &window);
        }
    }
}
