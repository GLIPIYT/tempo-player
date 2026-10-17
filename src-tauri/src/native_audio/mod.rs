pub mod listening;
pub mod models;
pub mod output;
pub mod queue;
pub mod resolver;

mod actor;

use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

pub const STATE_EVENT: &str = "native-audio://state";
pub const CLOCK_EVENT: &str = "native-audio://clock";
pub const FFT_EVENT: &str = "native-audio://fft";
pub const ANALYSIS_EVENT: &str = "native-audio://analysis";
pub const CONTINUATION_EVENT: &str = "native-audio://continuation-needed";

pub(crate) enum ActorMessage {
    Command {
        value: Value,
        reply: Sender<Result<(), String>>,
    },
    Prepared(actor::PreparedMessage),
    BrowserPrepared(actor::BrowserPreparedMessage),
    Preloaded(actor::PreloadMessage),
    ReservoirReady(actor::ReservoirMessage),
    GenerationChanged(i64),
    Snapshot(Sender<Result<Value, String>>),
    Shutdown(Sender<Result<(), String>>),
}

/// Managed native command queue. The handle contains no playback state; the
/// actor thread is the sole owner of the queue and output engine.
pub struct NativeAudioHandle {
    sender: Sender<ActorMessage>,
    stop_monitor: Arc<AtomicBool>,
}

pub fn init(app: &AppHandle) -> Result<(), String> {
    if app.try_state::<NativeAudioHandle>().is_some() {
        return Ok(());
    }
    if app.try_state::<crate::commands::AppState>().is_none() {
        return Err("native audio requires the application database state".into());
    }

    let (sender, receiver) = mpsc::channel();
    let stop_monitor = Arc::new(AtomicBool::new(false));
    let app_for_actor = app.clone();
    let actor_sender = sender.clone();
    let monitor_stop = stop_monitor.clone();
    std::thread::Builder::new()
        .name("tempo-native-audio-actor".into())
        .spawn(move || actor::run(app_for_actor, receiver, actor_sender, monitor_stop))
        .map_err(|error| format!("could not start native audio actor: {error}"))?;

    let handle = NativeAudioHandle {
        sender: sender.clone(),
        stop_monitor: stop_monitor.clone(),
    };
    if !app.manage(handle) {
        stop_monitor.store(true, std::sync::atomic::Ordering::Release);
        let (reply, _result) = mpsc::channel::<Result<(), String>>();
        let _ = sender.send(ActorMessage::Shutdown(reply));
        return Err("native audio service was already initialized".into());
    }

    let db = app.state::<crate::commands::AppState>().db.clone();
    let app_for_monitor = app.clone();
    let monitor_thread_stop = stop_monitor.clone();
    let monitor = std::thread::Builder::new()
        .name("tempo-audio-feedback-generation".into())
        .spawn(move || {
            let mut previous = None;
            while !monitor_thread_stop.load(std::sync::atomic::Ordering::Acquire) {
                let generation = db.with_conn(|conn| {
                    conn.query_row(
                        "SELECT generation FROM recommendation_meta WHERE id = 1",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| format!("recommendation database: {error}"))
                });
                if let Ok(generation) = generation {
                    if previous != Some(generation) {
                        previous = Some(generation);
                        let Some(handle) = app_for_monitor.try_state::<NativeAudioHandle>() else {
                            break;
                        };
                        if handle
                            .sender
                            .send(ActorMessage::GenerationChanged(generation))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        });
    if let Err(error) = monitor {
        // Playback remains usable if the optional clear-history watcher cannot
        // start; the actor itself and its native persistence are unaffected.
        eprintln!("[tempo native audio] could not start feedback generation monitor: {error}");
    }

    Ok(())
}

/// Enqueues one raw IPC command and waits for its small actor-side mutation to
/// finish. Source resolution and decoder preparation remain off this thread.
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, command: Value) -> Result<(), String> {
    let operation = command
        .get("op")
        .and_then(Value::as_str)
        .ok_or("native audio command is missing op")?;
    if operation == "shutdown" {
        return shutdown(app);
    }
    let handle = app
        .try_state::<NativeAudioHandle>()
        .ok_or("native audio is not initialized")?;
    let sender = handle.sender.clone();
    let (reply, result) = mpsc::channel();
    sender
        .send(ActorMessage::Command {
            value: command,
            reply,
        })
        .map_err(|error| error.to_string())?;
    result
        .recv_timeout(Duration::from_secs(3))
        .map_err(|error| format!("native audio command timed out: {error}"))?
}

#[allow(dead_code)]
pub fn transport<R: Runtime>(app: &AppHandle<R>, op: &str) {
    if let Err(error) = dispatch(app, json!({ "op": op })) {
        eprintln!("[tempo native audio] transport {op}: {error}");
    }
}

/// Finishes the active listening session, flushes both native stores, stops
/// output/helper resources, and waits for the actor acknowledgement.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    crate::soundcloud_recording::cancel_pending();
    let Some(handle) = app.try_state::<NativeAudioHandle>() else {
        return Ok(());
    };
    handle
        .stop_monitor
        .store(true, std::sync::atomic::Ordering::Release);
    let sender = handle.sender.clone();
    let (reply, result) = mpsc::channel();
    sender
        .send(ActorMessage::Shutdown(reply))
        .map_err(|error| error.to_string())?;
    let shutdown_result = result
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| format!("native audio shutdown timed out: {error}"))?;
    crate::soundcloud_recording::wait_for_idle(Duration::from_secs(1));
    shutdown_result
}

/// Synchronous form for native OS integration threads. Tauri command handlers
/// below move the bounded wait off the webview's main thread.
pub fn snapshot<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    let handle = app
        .try_state::<NativeAudioHandle>()
        .ok_or("native audio is not initialized")?;
    let (reply, result) = mpsc::channel();
    handle
        .sender
        .send(ActorMessage::Snapshot(reply))
        .map_err(|error| error.to_string())?;
    result
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| format!("native audio snapshot timed out: {error}"))?
}

#[tauri::command]
pub async fn native_audio_command(app: AppHandle, command: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, command))
        .await
        .map_err(|error| format!("native audio command task failed: {error}"))?
}

#[tauri::command]
pub async fn native_audio_snapshot(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot(&app))
        .await
        .map_err(|error| format!("native audio snapshot task failed: {error}"))?
}
