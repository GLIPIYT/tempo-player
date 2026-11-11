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
    FrameGap,
    EventLoop,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfEntry {
    kind: EventKind,
    label: String,
    duration_ms: f64,
    at_ms: f64,
}

impl PerfEntry {
    fn normalize(&mut self) -> Result<(), String> {
        if self.label.len() > 96
            || !self.duration_ms.is_finite()
            || !self.at_ms.is_finite()
            || !(0.0..=600_000.0).contains(&self.duration_ms)
            || self.at_ms < 0.0
        {
            return Err("invalid performance sample".into());
        }
        self.label = match self.kind {
            EventKind::React if known_react_area(&self.label) => return Ok(()),
            EventKind::React => return Err("unknown React profiling area".into()),
            EventKind::Longtask => "main-thread",
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
        };
        entry.normalize().unwrap();
        let path = append_entries(dir.path(), &[entry]).unwrap();
        let line = fs::read_to_string(path).unwrap();
        let row: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(row["label"], "main-thread");
        assert_eq!(row["durationMs"], 148.0);
    }
}
