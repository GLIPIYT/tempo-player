#[cfg(windows)]
mod cpu_trace;
#[cfg(windows)]
#[tauri::command]
pub async fn dev_perf_start_trace(window: tauri::WebviewWindow) -> Result<(), String> {
    cpu_trace::start_trace(window).await
}
#[cfg(windows)]
#[tauri::command]
pub async fn dev_perf_stop_trace(window: tauri::WebviewWindow) -> Result<String, String> {
    cpu_trace::stop_trace_command(window).await
}

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

const MAX_BATCH: usize = 64;
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;
static LOG_WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum EventKind {
    React,
    Longtask,
    LongFrame,
    FrameGap,
    EventLoop,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameDetails {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    scripts: Vec<ScriptTiming>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocking_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    render_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    style_and_layout_ms: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptTiming {
    source: String,
    function_name: String,
    duration_ms: f64,
    forced_style_and_layout_ms: f64,
    source_char_position: i64,
}

fn valid_duration(duration: f64) -> bool {
    (0.0..=600_000.0).contains(&duration)
}

fn valid_script(script: &ScriptTiming) -> bool {
    let source = &script.source;
    (source.starts_with("/src/")
        || source.starts_with("/node_modules/.vite/deps/")
        || source == "/@vite/client"
        || source.starts_with("/@vite/client/")
        || source == "/@react-refresh"
        || source.starts_with("/@react-refresh/"))
        && source.len() <= 256
        && !source.split('/').any(|part| part == ".." || part == ".")
        && source.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'.' | b'@')
        })
        && script.function_name.chars().count() <= 96
        && !script.function_name.chars().any(char::is_control)
        && valid_duration(script.duration_ms)
        && valid_duration(script.forced_style_and_layout_ms)
        && (-1..=i64::from(i32::MAX)).contains(&script.source_char_position)
}

impl FrameDetails {
    fn normalize(&mut self) {
        self.scripts.retain(valid_script);
        self.scripts.truncate(5);
        self.blocking_ms = self.blocking_ms.filter(|value| valid_duration(*value));
        self.render_ms = self.render_ms.filter(|value| valid_duration(*value));
        self.style_and_layout_ms = self
            .style_and_layout_ms
            .filter(|value| valid_duration(*value));
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfEntry {
    kind: EventKind,
    label: String,
    duration_ms: f64,
    at_ms: f64,
    #[serde(flatten)]
    frame: FrameDetails,
}

impl PerfEntry {
    fn normalize(&mut self) -> Result<(), String> {
        if self.label.len() > 96
            || !self.at_ms.is_finite()
            || !valid_duration(self.duration_ms)
            || self.at_ms < 0.0
        {
            return Err("invalid performance sample".into());
        }
        if matches!(self.kind, EventKind::LongFrame) {
            self.frame.normalize();
        } else {
            self.frame = FrameDetails::default();
        }
        self.label = match self.kind {
            EventKind::React if known_react_area(&self.label) => return Ok(()),
            EventKind::React => return Err("unknown React profiling area".into()),
            EventKind::Longtask => "main-thread",
            EventKind::LongFrame => "long-animation-frame",
            EventKind::FrameGap => "animation-frame",
            EventKind::EventLoop => "watchdog",
        }
        .into();
        Ok(())
    }
}

fn known_react_area(label: &str) -> bool {
    if matches!(label, "player" | "lyrics" | "updates") {
        return true;
    }
    matches!(
        label.strip_prefix("page:"),
        Some(
            "home"
                | "library"
                | "albums"
                | "artists"
                | "playlists"
                | "profile"
                | "settings"
                | "search"
                | "album"
                | "artist"
                | "local-artist"
                | "playlist"
                | "hour-mix"
                | "sc-playlist"
                | "sc-artist"
                | "yt-collection"
                | "track-details"
        )
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLine<'a> {
    written_at_unix_ms: u64,
    #[serde(flatten)]
    entry: &'a PerfEntry,
}

fn append_entries(directory: &Path, entries: &[PerfEntry]) -> Result<PathBuf, String> {
    let written_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut batch = Vec::new();
    for entry in entries {
        serde_json::to_writer(
            &mut batch,
            &LogLine {
                written_at_unix_ms,
                entry,
            },
        )
        .map_err(|error| error.to_string())?;
        batch.push(b'\n');
    }

    let _guard = LOG_WRITE
        .lock()
        .map_err(|_| "performance log is unavailable")?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let path = directory.join("dev-performance.jsonl");
    let current_size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.to_string()),
    };
    let rotate = current_size.saturating_add(batch.len() as u64) > MAX_LOG_BYTES;
    if rotate {
        fs::copy(&path, directory.join("dev-performance.previous.jsonl"))
            .map_err(|error| error.to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(!rotate)
        .truncate(rotate)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(&batch).map_err(|error| error.to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn dev_perf_append(
    window: WebviewWindow,
    mut entries: Vec<PerfEntry>,
) -> Result<String, String> {
    if window.label() != "main" || entries.is_empty() || entries.len() > MAX_BATCH {
        return Err("invalid performance log batch".into());
    }
    for entry in &mut entries {
        entry.normalize()?;
    }
    let directory = window
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        append_entries(&directory, &entries).map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_only_sanitized_samples() {
        let dir = tempfile::tempdir().unwrap();
        let mut entry = PerfEntry {
            kind: EventKind::Longtask,
            label: "arbitrary attribution".into(),
            duration_ms: 148.0,
            at_ms: 17_421.0,
            frame: FrameDetails::default(),
        };
        entry.normalize().unwrap();
        let path = append_entries(dir.path(), &[entry]).unwrap();
        let line = fs::read_to_string(path).unwrap();
        let row: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(row["label"], "main-thread");
        assert_eq!(row["durationMs"], 148.0);
    }

    #[test]
    fn long_frame_log_preserves_local_attribution_and_drops_other_urls() {
        let directory = tempfile::tempdir().unwrap();
        let make_script = |source: &str| {
            serde_json::json!({
                "source": source,
                "functionName": "buildRecommendations",
                "durationMs": 212.0,
                "forcedStyleAndLayoutMs": 33.0,
                "sourceCharPosition": 172
            })
        };
        let mut entry: PerfEntry = serde_json::from_value(serde_json::json!({
            "kind": "long-frame",
            "label": "Long frame",
            "durationMs": 260.0,
            "atMs": 17_421.0,
            "blockingMs": 210.0,
            "scripts": [
                make_script("https://example.com/app.js?secret=value"),
                make_script("/src/home/runtime.ts"),
            ]
        }))
        .unwrap();
        entry.normalize().unwrap();
        let path = append_entries(directory.path(), &[entry]).unwrap();
        let text = fs::read_to_string(path).unwrap();
        let row: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(row["label"], "long-animation-frame");
        assert_eq!(row["blockingMs"], 210.0);
        assert_eq!(row["scripts"].as_array().unwrap().len(), 1);
        assert_eq!(row["scripts"][0]["source"], "/src/home/runtime.ts");
    }
}
