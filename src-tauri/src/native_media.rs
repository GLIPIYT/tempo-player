//! OS media controls talk to the native sequencer; no renderer round trip.

use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use tauri::{AppHandle, Listener, Manager};

use crate::native_audio;

fn media_state(snapshot: &Value) -> Value {
    let mut state = serde_json::Map::new();
    for key in [
        "currentTrack",
        "position",
        "duration",
        "isPlaying",
        "buffering",
        "preparing",
        "version",
    ] {
        if let Some(value) = snapshot.get(key) {
            state.insert(key.into(), value.clone());
        }
    }
    Value::Object(state)
}

pub fn start(app: &AppHandle) {
    let latest = Arc::new(Mutex::new(Value::Null));
    let incoming = latest.clone();
    let (wake_tx, wake_rx) = mpsc::sync_channel(1);
    app.listen("native-audio://state", move |event| {
        if let Ok(snapshot) = serde_json::from_str::<Value>(event.payload()) {
            let mut current = incoming.lock().unwrap_or_else(|error| error.into_inner());
            if snapshot["version"].as_u64().unwrap_or(0) >= current["version"].as_u64().unwrap_or(0)
            {
                *current = media_state(&snapshot);
            }
            let _ = wake_tx.try_send(());
        }
    });
    let incoming = latest.clone();
    app.listen("native-audio://clock", move |event| {
        if let Ok(clock) = serde_json::from_str::<Value>(event.payload()) {
            let mut snapshot = incoming.lock().unwrap_or_else(|error| error.into_inner());
            if clock["version"].as_u64().unwrap_or(0) < snapshot["version"].as_u64().unwrap_or(0) {
                return;
            }
            if let (Some(state), Some(fields)) = (snapshot.as_object_mut(), clock.as_object()) {
                for key in [
                    "position",
                    "duration",
                    "isPlaying",
                    "buffering",
                    "preparing",
                    "version",
                ] {
                    if let Some(value) = fields.get(key) {
                        state.insert(key.into(), value.clone());
                    }
                }
            }
        }
    });
    let handle = app.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("tempo-media-controls".into())
        .spawn(move || {
            run(handle, latest, wake_rx);
        })
    {
        eprintln!("[tempo native media] could not start controls: {error}");
    }
}

fn run(app: AppHandle, latest: Arc<Mutex<Value>>, wake_rx: mpsc::Receiver<()>) {
    if let Ok(snapshot) = native_audio::snapshot(&app) {
        let mut current = latest.lock().unwrap_or_else(|error| error.into_inner());
        if snapshot["version"].as_u64().unwrap_or(0) >= current["version"].as_u64().unwrap_or(0) {
            *current = media_state(&snapshot);
        }
    }
    #[cfg(windows)]
    let hwnd = {
        use raw_window_handle::HasWindowHandle;
        app.get_webview_window("main").and_then(|window| {
            window
                .window_handle()
                .ok()
                .and_then(|handle| match handle.as_raw() {
                    raw_window_handle::RawWindowHandle::Win32(handle) => {
                        Some(handle.hwnd.get() as *mut std::ffi::c_void)
                    }
                    _ => None,
                })
        })
    };
    #[cfg(not(windows))]
    let hwnd = None;
    let mut controls = match MediaControls::new(PlatformConfig {
        dbus_name: "tempo",
        display_name: "Tempo",
        hwnd,
    }) {
        Ok(controls) => controls,
        Err(error) => {
            eprintln!("[tempo native media] controls unavailable: {error}");
            return;
        }
    };
    let target = app.clone();
    let current = latest.clone();
    if let Err(error) = controls.attach(move |event| {
        let command = match event {
            MediaControlEvent::Play => Some(json!({ "op": "play" })),
            MediaControlEvent::Pause | MediaControlEvent::Stop => Some(json!({ "op": "pause" })),
            MediaControlEvent::Toggle => Some(json!({ "op": "toggle" })),
            MediaControlEvent::Next => Some(json!({ "op": "next" })),
            MediaControlEvent::Previous => Some(json!({ "op": "previous" })),
            MediaControlEvent::SetPosition(MediaPosition(position)) => {
                Some(json!({ "op": "seek", "position": position.as_secs_f64() }))
            }
            MediaControlEvent::Seek(direction) => {
                let snapshot = current.lock().unwrap_or_else(|error| error.into_inner());
                let position = snapshot["position"].as_f64().unwrap_or(0.0);
                let delta = match direction {
                    souvlaki::SeekDirection::Forward => 10.0,
                    souvlaki::SeekDirection::Backward => -10.0,
                };
                Some(json!({ "op": "seek", "position": (position + delta).max(0.0) }))
            }
            MediaControlEvent::Raise => {
                crate::tray::show_main(&target);
                None
            }
            MediaControlEvent::Quit => {
                crate::tray::request_exit(&target);
                None
            }
            _ => None,
        };
        if let Some(command) = command {
            if let Err(error) = native_audio::dispatch(&target, command) {
                eprintln!("[tempo native media] {error}");
            }
        }
    }) {
        eprintln!("[tempo native media] controls could not attach: {error}");
        return;
    }

    let mut metadata_key = String::new();
    loop {
        match wake_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        let snapshot = latest
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if snapshot.is_null() {
            continue;
        }
        let track = &snapshot["currentTrack"];
        let key = format!("{}|{}", track, snapshot["duration"]);
        if key != metadata_key {
            let artist = track["artists"]
                .as_array()
                .map(|artists| {
                    artists
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let artwork = track["coverPath"].as_str().and_then(|path| {
                if path.starts_with("https://") || path.starts_with("http://") {
                    Some(path.to_string())
                } else {
                    reqwest::Url::from_file_path(path)
                        .ok()
                        .map(|url| url.to_string())
                }
            });
            let duration = snapshot["duration"]
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0);
            let _ = controls.set_metadata(MediaMetadata {
                title: track["title"].as_str(),
                artist: (!artist.is_empty()).then_some(artist.as_str()),
                album: track["album"].as_str(),
                cover_url: artwork.as_deref(),
                duration: duration.map(Duration::from_secs_f64),
            });
            metadata_key = key;
        }
        let position = snapshot["position"]
            .as_f64()
            .filter(|value| value.is_finite())
            .unwrap_or(0.0)
            .max(0.0);
        let progress = Some(MediaPosition(Duration::from_secs_f64(position)));
        let playback = if track.is_null() {
            MediaPlayback::Stopped
        } else if snapshot["isPlaying"].as_bool().unwrap_or(false)
            && !snapshot["preparing"].as_bool().unwrap_or(false)
        {
            MediaPlayback::Playing { progress }
        } else {
            MediaPlayback::Paused { progress }
        };
        let _ = controls.set_playback(playback);
    }
}
