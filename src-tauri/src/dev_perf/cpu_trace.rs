use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime},
};

use chrono::{DateTime, Utc};
use serde_json::Value;
use tauri::{Manager, WebviewWindow};
use tokio::sync::{oneshot, watch};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
};
use windows::core::HSTRING;

const MAX_TRACE_DURATION: Duration = Duration::from_secs(75);
const ENABLE_TIMEOUT: Duration = Duration::from_secs(8);
const START_TIMEOUT: Duration = Duration::from_secs(8);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const DISABLE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROFILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_RETAINED_PROFILES: usize = 5;
const PROFILE_PREFIX: &str = "dev-cpu-profile-";

static NEXT_FILENAME: AtomicU64 = AtomicU64::new(1);
static TRACE_STATE: OnceLock<Mutex<TraceState>> = OnceLock::new();

#[derive(Clone)]
enum Phase {
    Idle,
    Starting {
        generation: u64,
    },
    Recording {
        generation: u64,
    },
    Stopping {
        generation: u64,
        completion: watch::Sender<Option<Result<PathBuf, String>>>,
    },
}

struct TraceState {
    next_generation: u64,
    phase: Phase,
    last_saved: Option<(u64, PathBuf)>,
}

impl Default for TraceState {
    fn default() -> Self {
        Self {
            next_generation: 1,
            phase: Phase::Idle,
            last_saved: None,
        }
    }
}

fn trace_state() -> &'static Mutex<TraceState> {
    TRACE_STATE.get_or_init(|| Mutex::new(TraceState::default()))
}

#[derive(Clone, Copy)]
enum ProfilerCommand {
    Enable,
    Start,
    Stop,
    Disable,
}

impl ProfilerCommand {
    fn method(self) -> &'static str {
        match self {
            Self::Enable => "Profiler.enable",
            Self::Start => "Profiler.start",
            Self::Stop => "Profiler.stop",
            Self::Disable => "Profiler.disable",
        }
    }

    fn timeout(self) -> Duration {
        match self {
            Self::Enable => ENABLE_TIMEOUT,
            Self::Start => START_TIMEOUT,
            Self::Stop => STOP_TIMEOUT,
            Self::Disable => DISABLE_TIMEOUT,
        }
    }
}

fn main_webview(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("CPU tracing is available only in the main window".into());
    }
    Ok(())
}

fn app_log_directory(window: &WebviewWindow) -> Result<PathBuf, String> {
    window
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())
}

fn reserve_start() -> Result<u64, String> {
    let mut state = trace_state()
        .lock()
        .map_err(|_| "CPU trace state is unavailable")?;
    if !matches!(&state.phase, Phase::Idle) {
        return Err("a CPU profile trace is already starting, recording, or stopping".into());
    }
    let generation = state.next_generation;
    state.next_generation = state.next_generation.wrapping_add(1).max(1);
    state.last_saved = None;
    state.phase = Phase::Starting { generation };
    Ok(generation)
}

fn mark_recording(generation: u64) -> Result<(), String> {
    let mut state = trace_state()
        .lock()
        .map_err(|_| "CPU trace state is unavailable")?;
    if !matches!(&state.phase, Phase::Starting { generation: current } if *current == generation) {
        return Err("CPU trace state changed while starting".into());
    }
    state.phase = Phase::Recording { generation };
    Ok(())
}

fn clear_start(generation: u64) {
    if let Ok(mut state) = trace_state().lock() {
        if matches!(&state.phase, Phase::Starting { generation: current } if *current == generation)
        {
            state.phase = Phase::Idle;
        }
    }
}

async fn call_profiler(window: WebviewWindow, command: ProfilerCommand) -> Result<String, String> {
    let (sender, receiver) = oneshot::channel();
    window
        .with_webview(move |webview| {
            let core: ICoreWebView2 = match unsafe { webview.controller().CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    let _ = sender.send(Err(error.to_string()));
                    return;
                }
            };

            let callback_sender = Arc::new(Mutex::new(Some(sender)));
            let callback_sender_for_handler = Arc::clone(&callback_sender);
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |status, response| {
                    let result = status.map(|()| response).map_err(|error| error.to_string());
                    if let Ok(mut sender) = callback_sender_for_handler.lock() {
                        if let Some(sender) = sender.take() {
                            let _ = sender.send(result);
                        }
                    }
                    Ok(())
                },
            ));

            let method = HSTRING::from(command.method());
            let parameters = HSTRING::from("{}");
            let request_result =
                unsafe { core.CallDevToolsProtocolMethod(&method, &parameters, &handler) };
            if let Err(error) = request_result {
                if let Ok(mut sender) = callback_sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Err(error.to_string()));
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;

    match tokio::time::timeout(command.timeout(), receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("WebView2 profiler callback was dropped".into()),
        Err(_) => Err(format!("{} timed out", command.method())),
    }
}

async fn disable_profiler(window: WebviewWindow) {
    let _ = call_profiler(window, ProfilerCommand::Disable).await;
}

pub async fn start_trace(window: WebviewWindow) -> Result<(), String> {
    main_webview(&window)?;
    let directory = app_log_directory(&window)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let generation = reserve_start()?;

    let start_result = async {
        call_profiler(window.clone(), ProfilerCommand::Enable).await?;
        call_profiler(window.clone(), ProfilerCommand::Start).await?;
        Ok(())
    }
    .await;

    if let Err(error) = start_result {
        disable_profiler(window.clone()).await;
        clear_start(generation);
        return Err(error);
    }

    if let Err(error) = mark_recording(generation) {
        disable_profiler(window).await;
        clear_start(generation);
        return Err(error);
    }

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(MAX_TRACE_DURATION).await;
        let _ = stop_trace(window, Some(generation)).await;
    });

    Ok(())
}

enum StopAction {
    Initiate {
        generation: u64,
        completion: watch::Sender<Option<Result<PathBuf, String>>>,
    },
    Wait(watch::Receiver<Option<Result<PathBuf, String>>>),
    Saved(PathBuf),
    Noop,
}

fn begin_stop(expected_generation: Option<u64>) -> Result<StopAction, String> {
    let mut state = trace_state()
        .lock()
        .map_err(|_| "CPU trace state is unavailable")?;
    match state.phase.clone() {
        Phase::Recording { generation }
            if expected_generation.map_or(true, |expected| expected == generation) =>
        {
            let (completion, _receiver) = watch::channel(None);
            state.phase = Phase::Stopping {
                generation,
                completion: completion.clone(),
            };
            Ok(StopAction::Initiate {
                generation,
                completion,
            })
        }
        Phase::Stopping {
            generation,
            completion,
        } if expected_generation.map_or(true, |expected| expected == generation) => {
            Ok(StopAction::Wait(completion.subscribe()))
        }
        Phase::Starting { .. } if expected_generation.is_none() => {
            Err("CPU profile trace is still starting".into())
        }
        Phase::Idle if expected_generation.is_none() => match &state.last_saved {
            Some((_, path)) => Ok(StopAction::Saved(path.clone())),
            None => Err("no CPU profile trace is active".into()),
        },
        Phase::Idle => match (&state.last_saved, expected_generation) {
            (Some((generation, path)), Some(expected)) if *generation == expected => {
                Ok(StopAction::Saved(path.clone()))
            }
            _ => Ok(StopAction::Noop),
        },
        _ => Ok(StopAction::Noop),
    }
}

async fn await_stop(
    receiver: watch::Receiver<Option<Result<PathBuf, String>>>,
) -> Result<PathBuf, String> {
    let mut receiver = receiver;
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result;
        }
        receiver
            .changed()
            .await
            .map_err(|_| "CPU profile stop did not complete".to_string())?;
    }
}

async fn stop_trace(
    window: WebviewWindow,
    expected_generation: Option<u64>,
) -> Result<PathBuf, String> {
    main_webview(&window)?;
    let action = begin_stop(expected_generation)?;
    match action {
        StopAction::Initiate {
            generation,
            completion,
        } => {
            let result = finish_trace(window).await;
            completion.send_replace(Some(result.clone()));
            if let Ok(mut state) = trace_state().lock() {
                if matches!(&state.phase, Phase::Stopping { generation: current, .. } if *current == generation)
                {
                    if let Ok(path) = &result {
                        state.last_saved = Some((generation, path.clone()));
                    }
                    state.phase = Phase::Idle;
                }
            }
            result
        }
        StopAction::Wait(receiver) => await_stop(receiver).await,
        StopAction::Saved(path) if path.is_file() => Ok(path),
        StopAction::Saved(_) => Err("the saved CPU profile was removed".into()),
        StopAction::Noop => Ok(PathBuf::new()),
    }
}

async fn finish_trace(window: WebviewWindow) -> Result<PathBuf, String> {
    let profile_result = call_profiler(window.clone(), ProfilerCommand::Stop).await;
    // Always attempt to release the Profiler domain, including after a CDP or
    // validation error, so the next trace is not left behind a wedged state.
    disable_profiler(window.clone()).await;

    let profile_json = profile_result?;
    let directory = app_log_directory(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let profile = extract_profile(&profile_json)?;
        save_profile(&directory, &profile).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn extract_profile(response: &str) -> Result<Vec<u8>, String> {
    if response.len() > MAX_PROFILE_BYTES + 1024 {
        return Err("CPU profile exceeded the 32 MiB limit".into());
    }
    let value: Value = serde_json::from_str(response).map_err(|error| error.to_string())?;
    let profile = value
        .get("profile")
        .filter(|profile| profile.is_object())
        .ok_or_else(|| "Profiler.stop returned no CPU profile".to_string())?;
    profile
        .get("nodes")
        .and_then(Value::as_array)
        .filter(|nodes| !nodes.is_empty())
        .ok_or_else(|| "CPU profile has no samples".to_string())?;
    if profile.get("startTime").and_then(Value::as_f64).is_none()
        || profile.get("endTime").and_then(Value::as_f64).is_none()
    {
        return Err("CPU profile is missing its time range".into());
    }

    let bytes = serde_json::to_vec(profile).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err("CPU profile exceeded the 32 MiB limit".into());
    }
    Ok(bytes)
}

fn save_profile(directory: &Path, profile: &[u8]) -> std::io::Result<PathBuf> {
    if profile.len() > MAX_PROFILE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "CPU profile exceeded the 32 MiB limit",
        ));
    }
    fs::create_dir_all(directory)?;

    let timestamp: DateTime<Utc> = SystemTime::now().into();
    for _ in 0..8 {
        let sequence = NEXT_FILENAME.fetch_add(1, Ordering::Relaxed);
        let stem = format!(
            "{PROFILE_PREFIX}{}-{}-{sequence}",
            timestamp.format("%Y%m%dT%H%M%S%.3fZ"),
            std::process::id()
        );
        let destination = directory.join(format!("{stem}.cpuprofile"));
        let temporary = directory.join(format!("{stem}.cpuprofile.tmp"));
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };

        if let Err(error) = file.write_all(profile).and_then(|()| file.sync_all()) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        drop(file);
        if let Err(error) = fs::rename(&temporary, &destination) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        prune_profiles(directory);
        return Ok(destination);
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not create a unique CPU profile filename",
    ))
}

fn prune_profiles(directory: &Path) {
    let mut paths: Vec<(String, PathBuf)> = match fs::read_dir(directory) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                if !file_type.is_file() {
                    return None;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                (name.starts_with(PROFILE_PREFIX) && name.ends_with(".cpuprofile"))
                    .then(|| (name, entry.path()))
            })
            .collect(),
        Err(_) => return,
    };
    paths.sort_by(|left, right| left.0.cmp(&right.0));
    let excess = paths.len().saturating_sub(MAX_RETAINED_PROFILES);
    for (_, path) in paths.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

pub async fn stop_trace_command(window: WebviewWindow) -> Result<String, String> {
    let path = stop_trace(window, None).await?;
    if path.as_os_str().is_empty() {
        return Err("CPU profile trace is no longer active".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_only_a_valid_chrome_cpu_profile() {
        let bytes = extract_profile(
            r#"{"profile":{"nodes":[{"id":1}],"startTime":10,"endTime":20,"samples":[1],"timeDeltas":[10]}}"#,
        )
        .unwrap();
        let profile: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(profile.get("profile").is_none());
        assert_eq!(profile["nodes"][0]["id"], 1);
        assert_eq!(profile["startTime"], 10);
        assert!(extract_profile(r#"{"result":{}}"#).is_err());
    }

    #[test]
    fn writes_unique_profiles_and_keeps_only_five() {
        let directory = tempfile::tempdir().unwrap();
        let profile = br#"{"nodes":[{"id":1}],"startTime":10,"endTime":20}"#;
        let mut saved = Vec::new();
        for _ in 0..MAX_RETAINED_PROFILES + 2 {
            saved.push(save_profile(directory.path(), profile).unwrap());
        }

        assert_ne!(saved[0], saved[1]);
        let mut retained: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "cpuprofile"))
            .collect();
        retained.sort();
        assert_eq!(retained.len(), MAX_RETAINED_PROFILES);
        assert!(!saved[0].exists());
        assert!(!saved[1].exists());
        assert_eq!(fs::read(&saved[2]).unwrap(), profile);
    }
}
