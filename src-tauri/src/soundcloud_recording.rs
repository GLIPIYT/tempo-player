//! Bounded, local WebAudio capture of SoundCloud's normal browser playback.
//!
//! This module never reads DRM keys or CDM state. SoundCloud's own widget and
//! media element feed a MediaStreamDestination; the resulting WebM chunks are
//! streamed to a private temporary directory and joined locally.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

mod join;

const HOST_HTML: &str = include_str!("soundcloud_recording/host.html");
const HOST_JS: &str = include_str!("soundcloud_recording/host.js");
const FRAME_JS: &str = include_str!("soundcloud_recording/frame.js");
const HOST_LABEL_PREFIX: &str = "sc-recording-";
const TEMP_PREFIX: &str = ".tempo-sc-recording-";
const HOST_URL: &str = "tempo-sc-recording://localhost/host.html";
const MAX_TRACK_ID_LEN: usize = 32;
const MAX_DURATION_SECONDS: f64 = 24.0 * 60.0 * 60.0;
const MAX_PARTS: usize = 12;
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const MAX_PULL_BYTES: usize = 2 * 1024 * 1024;
const MAX_PULL_RESPONSE_BYTES: usize = 3 * 1024 * 1024;
const MIN_AVAILABLE_MEMORY: u64 = 768 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
// Encloses the host's 50-second prepare deadline and native polling overhead.
const PREPARE_TIMEOUT: Duration = Duration::from_secs(55);
// Encloses host arm (25 s) + release (15 s) deadlines and polling overhead.
const START_TIMEOUT: Duration = Duration::from_secs(45);
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

static ACTIVE_EPOCH: AtomicU64 = AtomicU64::new(1);
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct ActiveJobs(Mutex<HashMap<String, Arc<AtomicBool>>>);

fn active_jobs() -> &'static ActiveJobs {
    static JOBS: OnceLock<ActiveJobs> = OnceLock::new();
    JOBS.get_or_init(ActiveJobs::default)
}

fn capture_permit() -> &'static Arc<Semaphore> {
    static PERMIT: OnceLock<Arc<Semaphore>> = OnceLock::new();
    PERMIT.get_or_init(|| Arc::new(Semaphore::new(1)))
}

/// Cancels active and queued capture work. Safe to call before the audio actor shuts down.
pub fn cancel_pending() {
    ACTIVE_EPOCH.fetch_add(1, Ordering::AcqRel);
    let jobs = active_jobs()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for cancelled in jobs.values() {
        cancelled.store(true, Ordering::Release);
    }
}

/// Called from the native shutdown worker, never the UI thread. Give owned
/// FFmpeg jobs time to observe cancellation and reap their children before exit.
pub fn wait_for_idle(timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if active_jobs()
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty()
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Cancels captures and closes their isolated SoundCloud widget windows.
pub fn cancel_all(app: &AppHandle) {
    cancel_pending();
    for (label, window) in app.webview_windows() {
        if label.starts_with(HOST_LABEL_PREFIX) {
            let _ = window.close();
        }
    }
}

/// Removes abandoned private capture directories from earlier interrupted runs.
/// Only direct children with this module's reserved prefix are considered.
pub fn cleanup_abandoned(cache_dir: &Path) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(TEMP_PREFIX) && !name.starts_with(".tempo-pcm-join-") {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = fs::remove_dir_all(path);
        }
    }
}

/// Serves only the fixed local host assets for the isolated recording webview.
pub fn host_response(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let (body, content_type) = match (request.method().as_str(), request.uri().path()) {
        ("GET" | "HEAD", "/host.html") => (HOST_HTML.as_bytes(), "text/html; charset=utf-8"),
        ("GET" | "HEAD", "/host.js") => (HOST_JS.as_bytes(), "text/javascript; charset=utf-8"),
        ("GET" | "HEAD", "/frame.js") => (FRAME_JS.as_bytes(), "text/javascript; charset=utf-8"),
        _ => {
            return tauri::http::Response::builder()
                .status(404)
                .header("Cache-Control", "no-store")
                .body(Vec::new())
                .expect("static response headers are valid");
        }
    };
    let body = if request.method() == "HEAD" {
        Vec::new()
    } else {
        body.to_vec()
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' https://w.soundcloud.com; frame-src https://w.soundcloud.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
        )
        .body(body)
        .expect("static response headers are valid")
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PartPlan {
    part: usize,
    start: f64,
    end: f64,
    last: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameChunk {
    seq: u64,
    bytes: usize,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartSnapshot {
    part: usize,
    state: String,
    start: f64,
    end: f64,
    media_start: Option<f64>,
    media_end: Option<f64>,
    current_time: Option<f64>,
    finish: Option<f64>,
    paused: Option<bool>,
    total_bytes: u64,
    queued: usize,
    chunks: Vec<FrameChunk>,
    errors: Vec<String>,
    rms: Option<f64>,
}

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn create(parent: &Path) -> Result<Self, String> {
        static NONCE: AtomicU64 = AtomicU64::new(1);
        for _ in 0..16 {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(
                "{TEMP_PREFIX}{}-{stamp:x}-{nonce:x}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "Could not create the capture temporary directory: {error}"
                    ))
                }
            }
        }
        Err("Could not allocate a unique capture temporary directory".into())
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct OutputGuard {
    path: PathBuf,
    keep: bool,
}

impl Drop for OutputGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct JobRegistration {
    label: String,
    cancelled: Arc<AtomicBool>,
}

impl JobRegistration {
    fn new(label: String, cancelled: Arc<AtomicBool>) -> Self {
        active_jobs()
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(label.clone(), cancelled.clone());
        Self { label, cancelled }
    }
}

impl Drop for JobRegistration {
    fn drop(&mut self) {
        active_jobs()
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.label);
        self.cancelled.store(true, Ordering::Release);
    }
}

struct HostWindow {
    window: WebviewWindow,
}

impl Drop for HostWindow {
    fn drop(&mut self) {
        let _ = self.window.close();
    }
}

fn safe_host_url(url: &tauri::Url) -> bool {
    let host_origin = (url.scheme() == "tempo-sc-recording" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tempo-sc-recording.localhost"));
    host_origin
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(url.path(), "/host.html" | "/host.js" | "/frame.js")
}

async fn create_host_window(app: &AppHandle, label: String) -> Result<HostWindow, String> {
    let url = tauri::Url::parse(HOST_URL).expect("static recording host URL");
    let (sender, receiver) = oneshot::channel();
    let build_app = app.clone();
    app.run_on_main_thread(move || {
        let result = WebviewWindowBuilder::new(&build_app, label, WebviewUrl::CustomProtocol(url))
            .title("SoundCloud capture")
            .inner_size(2.0, 2.0)
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .decorations(false)
            .resizable(false)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .initialization_script_for_all_frames(FRAME_JS)
            .on_navigation(safe_host_url)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()
            .map_err(|error| format!("SoundCloud capture browser could not start: {error}"));
        if let Err(Ok(window)) = sender.send(result) {
            let _ = window.close();
        }
    })
    .map_err(|error| format!("SoundCloud capture browser could not start: {error}"))?;
    let window = tokio::time::timeout(STARTUP_TIMEOUT, receiver)
        .await
        .map_err(|_| "SoundCloud capture browser startup timed out".to_string())?
        .map_err(|_| "SoundCloud capture browser startup was interrupted".to_string())??;
    Ok(HostWindow { window })
}

fn callback_json(raw: String) -> Result<Value, String> {
    if raw.len() > MAX_PULL_RESPONSE_BYTES + 4096 {
        return Err("SoundCloud capture browser returned an oversized response".into());
    }
    let value: Value = serde_json::from_str(&raw)
        .map_err(|_| "SoundCloud capture browser returned an invalid response".to_string())?;
    if let Some(inner_json) = value.as_str() {
        serde_json::from_str(inner_json)
            .map_err(|_| "SoundCloud capture browser returned an invalid response".to_string())
    } else {
        Ok(value)
    }
}

async fn eval_once(window: &WebviewWindow, script: String) -> Result<Value, String> {
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    window
        .eval_with_callback(script, move |value| {
            if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                let _ = sender.send(value);
            }
        })
        .map_err(|error| format!("SoundCloud capture browser did not respond: {error}"))?;
    let raw = tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .map_err(|_| "SoundCloud capture browser did not respond".to_string())?
        .map_err(|_| "SoundCloud capture browser was closed".to_string())?;
    callback_json(raw)
}

async fn native_call(
    window: &WebviewWindow,
    request: Value,
    timeout: Duration,
    max_response_bytes: usize,
    external_cancelled: &AtomicBool,
    local_cancelled: &AtomicBool,
    epoch: u64,
) -> Result<Value, String> {
    let id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let id_text = format!("n{id:x}");
    let mut request = request;
    let response_poll = if matches!(
        request.get("op").and_then(Value::as_str),
        Some("pull" | "ack" | "start")
    ) {
        Duration::from_millis(10)
    } else {
        Duration::from_millis(50)
    };
    let object = request
        .as_object_mut()
        .ok_or_else(|| "Invalid internal capture request".to_string())?;
    object.insert("requestId".into(), Value::String(id_text.clone()));
    let request_json = serde_json::to_string(&request)
        .map_err(|_| "Could not prepare the SoundCloud capture request".to_string())?;
    let accepted = eval_once(
        window,
        format!("window.__tempoRecordingDispatch({request_json})"),
    )
    .await?;
    if accepted != Value::Bool(true) {
        return Err("SoundCloud capture browser rejected a native request".into());
    }

    let deadline = Instant::now() + timeout;
    loop {
        check_cancelled(external_cancelled, local_cancelled, epoch)?;
        if Instant::now() >= deadline {
            return Err("SoundCloud capture browser request timed out".into());
        }
        let id_json = serde_json::to_string(&id_text).expect("request id is JSON-safe");
        match eval_once(
            window,
            format!("window.__tempoRecordingTakeResult({id_json})"),
        )
        .await
        {
            Ok(Value::Null) => {}
            Ok(value) => {
                if max_response_bytes < MAX_PULL_RESPONSE_BYTES
                    && serde_json::to_vec(&value)
                        .map_or(true, |bytes| bytes.len() > max_response_bytes)
                {
                    return Err("SoundCloud capture browser returned an oversized response".into());
                }
                return response_result(value);
            }
            Err(_error) if is_cancelled(external_cancelled, local_cancelled, epoch) => {
                return Err("SoundCloud capture was cancelled".into());
            }
            Err(error) if error.contains("did not respond") => {}
            Err(error) => return Err(error),
        }
        tokio::time::sleep(response_poll).await;
    }
}

fn response_result(value: Value) -> Result<Value, String> {
    let Some(object) = value.as_object() else {
        return Err("SoundCloud capture browser returned an invalid response".into());
    };
    if object.get("ok") == Some(&Value::Bool(true)) {
        return Ok(value);
    }
    let code = object
        .get("error")
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() <= 120
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .unwrap_or("capture-failed");
    Err(format!("SoundCloud capture failed: {code}"))
}

fn is_cancelled(external: &AtomicBool, local: &AtomicBool, epoch: u64) -> bool {
    external.load(Ordering::Acquire)
        || local.load(Ordering::Acquire)
        || ACTIVE_EPOCH.load(Ordering::Acquire) != epoch
}

fn check_cancelled(external: &AtomicBool, local: &AtomicBool, epoch: u64) -> Result<(), String> {
    if is_cancelled(external, local, epoch) {
        Err("SoundCloud capture was cancelled".into())
    } else {
        Ok(())
    }
}

async fn wait_for_cancellation(external: &AtomicBool, local: &AtomicBool, epoch: u64) {
    while !is_cancelled(external, local, epoch) {
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn acquire_capture_permit(
    cancelled: &AtomicBool,
    epoch: u64,
) -> Result<OwnedSemaphorePermit, String> {
    let acquire = capture_permit().clone().acquire_owned();
    tokio::pin!(acquire);
    loop {
        if is_cancelled(cancelled, &AtomicBool::new(false), epoch) {
            return Err("SoundCloud capture was cancelled".into());
        }
        tokio::select! {
            permit = &mut acquire => {
                return permit.map_err(|_| "SoundCloud capture is unavailable".to_string());
            }
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }
    }
}

fn validate_input(
    track_id: &str,
    expected_duration: f64,
    output: &Path,
) -> Result<PathBuf, String> {
    if track_id.is_empty()
        || track_id.len() > MAX_TRACK_ID_LEN
        || !track_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("SoundCloud track ID is invalid".into());
    }
    if !expected_duration.is_finite()
        || expected_duration <= 0.0
        || expected_duration > MAX_DURATION_SECONDS
    {
        return Err("SoundCloud track duration is invalid".into());
    }
    if output.exists() {
        return Err("SoundCloud capture destination already exists".into());
    }
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if !parent.is_dir() {
        return Err("SoundCloud capture destination directory is unavailable".into());
    }
    Ok(parent.to_path_buf())
}

fn make_plans(duration: f64, count: usize) -> Result<Vec<PartPlan>, String> {
    if !(1..=MAX_PARTS).contains(&count) {
        return Err("SoundCloud capture block count is invalid".into());
    }
    Ok((0..count)
        .map(|part| PartPlan {
            part,
            start: (part as f64 * duration / count as f64 - 0.3).max(0.0),
            end: (((part + 1) as f64 * duration / count as f64) + 0.3).min(duration),
            last: part + 1 == count,
        })
        .collect())
}

#[cfg(windows)]
fn available_disk_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let directory: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    // SAFETY: the path is NUL-terminated and the output points to a valid u64.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(directory.as_ptr()), Some(&mut available), None, None) }
        .ok()?;
    Some(available)
}

#[cfg(not(windows))]
fn available_disk_bytes(_: &Path) -> Option<u64> {
    None
}

fn current_coverage(snapshots: &[PartSnapshot], expected_duration: f64) -> f64 {
    let mut ranges = snapshots
        .iter()
        .filter_map(|part| {
            let start = part.media_start?;
            let end = part.current_time?;
            let start = start.clamp(0.0, expected_duration);
            let end = end.clamp(start, expected_duration);
            (end > start).then_some((start, end))
        })
        .collect::<Vec<_>>();
    ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut covered = 0.0;
    let mut active: Option<(f64, f64)> = None;
    for (start, end) in ranges {
        match active {
            Some((left, right)) if start <= right => active = Some((left, right.max(end))),
            Some((left, right)) => {
                covered += right - left;
                active = Some((start, end));
            }
            None => active = Some((start, end)),
        }
    }
    if let Some((left, right)) = active {
        covered += right - left;
    }
    (covered / expected_duration).clamp(0.0, 1.0)
}

fn validate_snapshot(snapshot: &PartSnapshot, plan: PartPlan) -> Result<(), String> {
    if snapshot.part != plan.part
        || (snapshot.start - plan.start).abs() > 0.01
        || (snapshot.end - plan.end).abs() > 0.01
    {
        return Err("SoundCloud capture part markers changed".into());
    }
    if snapshot.errors.len() > 8 || snapshot.errors.iter().any(|error| error.len() > 80) {
        return Err("SoundCloud capture part reported an invalid error".into());
    }
    let byte_budget =
        ((snapshot.end - snapshot.start) * 1024.0 * 1024.0).ceil() as u64 + 2 * 1024 * 1024;
    if snapshot.total_bytes > byte_budget {
        return Err("SoundCloud capture part exceeded its disk budget".into());
    }
    if snapshot.queued < snapshot.chunks.len() || snapshot.queued > 512 {
        return Err("SoundCloud capture part queue is inconsistent".into());
    }
    Ok(())
}

fn widget_error(snapshot: &PartSnapshot) -> Option<String> {
    if snapshot.state == "failed" {
        let code = snapshot
            .errors
            .first()
            .filter(|value| value.len() <= 80)
            .map(String::as_str)
            .unwrap_or("part-failed");
        return Some(format!("SoundCloud capture part failed: {code}"));
    }
    if !matches!(
        snapshot.state.as_str(),
        "prepared" | "recording" | "stopping" | "complete"
    ) {
        return Some("SoundCloud capture part entered an invalid state".into());
    }
    None
}

/// Records normal SoundCloud widget playback into local WebM chunks, then joins them as Opus.
pub async fn capture(
    app: AppHandle,
    track_id: &str,
    expected_duration: f64,
    output: &Path,
    cancelled: Arc<AtomicBool>,
    progress: Arc<dyn Fn(f64) + Send + Sync>,
) -> Result<(), String> {
    let parent = validate_input(track_id, expected_duration, output)?;
    let epoch = ACTIVE_EPOCH.load(Ordering::Acquire);
    let _permit = acquire_capture_permit(&cancelled, epoch).await?;
    check_cancelled(&cancelled, &AtomicBool::new(false), epoch)?;

    // Do not race the audible player's first media/license requests with up to
    // twelve background Widgets. Existing recordings keep their completed work.
    while crate::soundcloud_browser::startup_waiting() {
        check_cancelled(&cancelled, &AtomicBool::new(false), epoch)?;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let db = app.state::<crate::commands::AppState>().db.clone();
    let block_count = crate::soundcloud_capture_policy::selected_blocks(&db).await;
    let block_count = block_count.clamp(1, MAX_PARTS);
    let attempt = capture_attempt(
        app.clone(),
        track_id,
        expected_duration,
        output,
        cancelled.clone(),
        progress.clone(),
        parent.clone(),
        block_count,
        epoch,
    )
    .await;
    if block_count > 1
        && attempt
            .as_ref()
            .err()
            .is_some_and(|error| error == "SoundCloud capture failed: capture-seek-timeout")
    {
        check_cancelled(&cancelled, &AtomicBool::new(false), epoch)?;
        // Some protected MSE streams never finish seeking to particular remote
        // segments. Retry once from zero, without requiring arbitrary seeks.
        // The failed host, staged pieces and output guard have already dropped.
        #[cfg(debug_assertions)]
        eprintln!(
            "[tempo soundcloud capture] parallel_seek_failed blocks={block_count} retry_blocks=1"
        );
        capture_attempt(
            app,
            track_id,
            expected_duration,
            output,
            cancelled,
            progress,
            parent,
            1,
            epoch,
        )
        .await
    } else {
        attempt
    }
}

async fn capture_attempt(
    app: AppHandle,
    track_id: &str,
    expected_duration: f64,
    output: &Path,
    cancelled: Arc<AtomicBool>,
    progress: Arc<dyn Fn(f64) + Send + Sync>,
    parent: PathBuf,
    block_count: usize,
    epoch: u64,
) -> Result<(), String> {
    check_cancelled(&cancelled, &AtomicBool::new(false), epoch)?;
    if crate::soundcloud_capture_policy::system_available_memory()
        .is_some_and(|available| available < MIN_AVAILABLE_MEMORY)
    {
        return Err("Not enough available memory to capture SoundCloud audio".into());
    }

    let plans = make_plans(expected_duration, block_count)?;
    // PCM capture, decoded parts, joined PCM and validation decode coexist on
    // disk. Reserve all four, their overlaps and a small filesystem margin.
    let staging_bytes = ((expected_duration + block_count as f64 * 0.6) * 48_000.0 * 8.0 * 4.0)
        as u64
        + 64 * 1024 * 1024;
    if available_disk_bytes(&parent).is_some_and(|available| available < staging_bytes) {
        return Err("Not enough free disk space to prepare this SoundCloud cache file".into());
    }
    let job_id = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
    let label = format!("{HOST_LABEL_PREFIX}{job_id:x}");
    let local_cancelled = Arc::new(AtomicBool::new(false));
    let _registration = JobRegistration::new(label.clone(), local_cancelled.clone());
    let _temp_dir = TempDir::create(&parent)?;
    let mut output_guard = OutputGuard {
        path: output.to_path_buf(),
        keep: false,
    };
    let host = create_host_window(&app, label).await?;
    check_cancelled(&cancelled, &local_cancelled, epoch)?;

    let mut files = Vec::with_capacity(block_count);
    let mut paths = Vec::with_capacity(block_count);
    for plan in &plans {
        let path = _temp_dir
            .path
            .join(format!("part-{:02}.webm.part", plan.part));
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
            .map_err(|error| format!("Could not create a SoundCloud capture part: {error}"))?;
        paths.push(path);
        files.push(file);
    }

    wait_host_ready(&host.window, &cancelled, &local_cancelled, epoch).await?;
    let plan_values = serde_json::to_value(&plans)
        .map_err(|_| "Could not prepare SoundCloud capture blocks".to_string())?;
    native_call(
        &host.window,
        json!({
            "op": "init",
            "trackId": track_id,
            "expectedDuration": expected_duration,
            "plans": plan_values,
        }),
        STARTUP_TIMEOUT,
        64 * 1024,
        &cancelled,
        &local_cancelled,
        epoch,
    )
    .await?;

    let prepared = native_call(
        &host.window,
        json!({ "op": "prepare" }),
        PREPARE_TIMEOUT,
        64 * 1024,
        &cancelled,
        &local_cancelled,
        epoch,
    )
    .await?;
    let prepared_parts = parse_snapshots(prepared, block_count)?;
    for (snapshot, plan) in prepared_parts.iter().zip(plans.iter().copied()) {
        validate_snapshot(snapshot, plan)?;
        if snapshot.state != "prepared"
            || snapshot.media_start.is_none()
            || snapshot.media_end.is_some()
        {
            return Err("SoundCloud capture browser could not prepare every audio source".into());
        }
    }

    native_call(
        &host.window,
        json!({ "op": "start" }),
        START_TIMEOUT,
        64 * 1024,
        &cancelled,
        &local_cancelled,
        epoch,
    )
    .await?;

    let capture_budget = Duration::from_secs(
        (expected_duration * 3.0 + 90.0)
            .ceil()
            .clamp(120.0, MAX_DURATION_SECONDS * 3.0) as u64,
    );
    let capture_deadline = Instant::now() + capture_budget;
    let mut last_positions: Vec<Option<f64>> = vec![None; block_count];
    let mut last_position_change = vec![Instant::now(); block_count];
    let mut next_sequences = vec![0u64; block_count];
    let mut pending_acks = Vec::<Value>::new();
    let mut max_capture_progress = 0.0f64;
    let mut signal_observed = false;
    let mut memory_checked_at = Instant::now();

    let snapshots = loop {
        check_cancelled(&cancelled, &local_cancelled, epoch)?;
        if memory_checked_at.elapsed() >= Duration::from_secs(2) {
            memory_checked_at = Instant::now();
            if crate::soundcloud_capture_policy::system_available_memory()
                .is_some_and(|available| available < MIN_AVAILABLE_MEMORY)
            {
                return Err(
                    "SoundCloud caching stopped because available memory is too low".into(),
                );
            }
        }
        if Instant::now() >= capture_deadline {
            return Err("SoundCloud capture exceeded its time budget".into());
        }
        let response = native_call(
            &host.window,
            json!({ "op": "pull", "acks": std::mem::take(&mut pending_acks) }),
            Duration::from_secs(8),
            MAX_PULL_RESPONSE_BYTES,
            &cancelled,
            &local_cancelled,
            epoch,
        )
        .await?;
        let mut snapshots = parse_snapshots(response, block_count)?;
        let mut acknowledgements = Vec::with_capacity(block_count);
        let mut bytes_pulled = 0usize;
        for (snapshot, plan) in snapshots.iter().zip(plans.iter().copied()) {
            validate_snapshot(snapshot, plan)?;
            signal_observed |= snapshot
                .rms
                .is_some_and(|level| level.is_finite() && level > 1.0e-7);
            if let Some(error) = widget_error(snapshot) {
                return Err(error);
            }
        }

        // Every chunk is written and flushed before the host receives its ack.
        for index in 0..block_count {
            let chunks = std::mem::take(&mut snapshots[index].chunks);
            let mut last_written = None;
            for chunk in chunks {
                if chunk.seq != next_sequences[index] {
                    return Err("SoundCloud capture data sequence has a gap".into());
                }
                if chunk.bytes == 0 || chunk.bytes > MAX_CHUNK_BYTES {
                    return Err("SoundCloud capture returned an invalid audio chunk".into());
                }
                bytes_pulled = bytes_pulled.saturating_add(chunk.bytes);
                if bytes_pulled > MAX_PULL_BYTES {
                    return Err("SoundCloud capture pull exceeded its memory limit".into());
                }
                let raw = BASE64
                    .decode(chunk.data.as_bytes())
                    .map_err(|_| "SoundCloud capture returned invalid audio data".to_string())?;
                if raw.len() != chunk.bytes || raw.len() > MAX_CHUNK_BYTES {
                    return Err("SoundCloud capture audio chunk length was invalid".into());
                }
                files[index].write_all(&raw).await.map_err(|error| {
                    format!("Could not write a SoundCloud capture part: {error}")
                })?;
                next_sequences[index] += 1;
                last_written = Some(chunk.seq);
            }
            if let Some(seq) = last_written {
                files[index].flush().await.map_err(|error| {
                    format!("Could not flush a SoundCloud capture part: {error}")
                })?;
                acknowledgements.push(json!({ "part": index, "seq": seq }));
            }
        }
        // Confirm accepted disk writes together with the next pull. Keeping
        // two WebView round trips per batch starved 12 simultaneous sources.
        pending_acks = acknowledgements;

        for (index, snapshot) in snapshots.iter().enumerate() {
            if let Some(position) = snapshot.current_time.filter(|value| value.is_finite()) {
                if last_positions[index]
                    .map_or(true, |previous| (position - previous).abs() >= 0.01)
                {
                    last_positions[index] = Some(position);
                    last_position_change[index] = Instant::now();
                } else if snapshot.state == "recording"
                    && snapshot.paused == Some(false)
                    && last_position_change[index].elapsed() >= STALL_TIMEOUT
                {
                    return Err("SoundCloud playback stopped advancing during capture".into());
                }
            }
            if snapshot.state == "recording" && snapshot.paused == Some(true) {
                return Err("SoundCloud playback paused during capture".into());
            }
        }

        let fraction = current_coverage(&snapshots, expected_duration);
        max_capture_progress = max_capture_progress.max(fraction * 0.9).min(0.9);
        progress(max_capture_progress);
        let all_complete = snapshots
            .iter()
            .all(|part| part.state == "complete" && part.queued == 0);
        if all_complete {
            break snapshots;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    };

    for file in &mut files {
        file.sync_all()
            .await
            .map_err(|error| format!("Could not finish a SoundCloud capture part: {error}"))?;
    }
    if !signal_observed {
        return Err("SoundCloud did not expose an audio signal for caching in this browser".into());
    }
    drop(files);
    let mut pieces = Vec::with_capacity(block_count);
    for (snapshot, plan) in snapshots.iter().zip(plans.iter().copied()) {
        validate_snapshot(snapshot, plan)?;
        let media_start = snapshot
            .media_start
            .filter(|value| value.is_finite())
            .ok_or_else(|| "SoundCloud capture start marker is missing".to_string())?;
        let media_end = snapshot
            .media_end
            .filter(|value| value.is_finite())
            .ok_or_else(|| "SoundCloud capture end marker is missing".to_string())?;
        if (media_start - plan.start).abs() > 0.25
            || (media_end - plan.end).abs() > 0.25
            || (plan.last && snapshot.finish.is_none())
        {
            return Err("SoundCloud capture did not cover the full track interval".into());
        }
        if fs::metadata(&paths[plan.part])
            .map_err(|error| format!("Could not inspect a SoundCloud capture part: {error}"))?
            .len()
            == 0
        {
            return Err("SoundCloud capture produced an empty audio part".into());
        }
        pieces.push(join::Piece {
            path: paths[plan.part].clone(),
            start: plan.start,
            end: plan.end,
            media_start,
            media_end,
        });
    }
    progress(0.9);

    check_cancelled(&cancelled, &local_cancelled, epoch)?;
    let bin_dir = app.state::<crate::commands::AppState>().bin_dir.clone();
    let ffmpeg = tokio::task::spawn_blocking(move || {
        crate::native_audio::output::ensure_decoder_helper(&bin_dir)
    })
    .await
    .map_err(|error| format!("Could not prepare the audio decoder: {error}"))??;
    let join_progress = progress.clone();
    let join_callback: Arc<dyn Fn(f64) + Send + Sync> = Arc::new(move |fraction| {
        join_progress(0.9 + 0.09 * fraction.clamp(0.0, 1.0));
    });
    let join_future = join::join_pieces(
        &pieces,
        expected_duration,
        output,
        &ffmpeg,
        local_cancelled.clone(),
        join_callback,
    );
    tokio::pin!(join_future);
    let join_result = tokio::select! {
        result = &mut join_future => result,
        _ = wait_for_cancellation(&cancelled, &local_cancelled, epoch) => {
            local_cancelled.store(true, Ordering::Release);
            let _ = (&mut join_future).await;
            return Err("SoundCloud capture was cancelled".into());
        }
    };
    join_result?;
    check_cancelled(&cancelled, &local_cancelled, epoch)?;
    output_guard.keep = true;
    progress(0.99);
    Ok(())
}

async fn wait_host_ready(
    window: &WebviewWindow,
    external_cancelled: &AtomicBool,
    local_cancelled: &AtomicBool,
    epoch: u64,
) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        check_cancelled(external_cancelled, local_cancelled, epoch)?;
        if Instant::now() >= deadline {
            return Err("SoundCloud capture host failed to load".into());
        }
        match eval_once(window, "window.__tempoRecordingReady === true".into()).await {
            Ok(Value::Bool(true)) => return Ok(()),
            Ok(_) => {}
            Err(error) if error.contains("did not respond") => {}
            Err(error) => return Err(error),
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn parse_snapshots(mut response: Value, expected: usize) -> Result<Vec<PartSnapshot>, String> {
    let parts = response
        .get_mut("parts")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .ok_or_else(|| "SoundCloud capture browser omitted part state".to_string())?;
    if parts.len() != expected {
        return Err("SoundCloud capture browser returned an incomplete part list".into());
    }
    let mut snapshots = parts
        .into_iter()
        .map(serde_json::from_value::<PartSnapshot>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "SoundCloud capture browser returned invalid part state".to_string())?;
    snapshots.sort_by_key(|part| part.part);
    if snapshots
        .iter()
        .enumerate()
        .any(|(index, part)| part.part != index)
    {
        return Err("SoundCloud capture browser returned duplicate part state".into());
    }
    Ok(snapshots)
}
