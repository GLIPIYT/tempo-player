//! yt-dlp as an external tool the user points at, not something we bundle.
//!
//! YouTube extraction is an arms race: SABR streaming, PO tokens, signature
//! changes, and periodic breakage that yt-dlp answers within days. Bundling it
//! would mean shipping a new build of this app every time the other side moves,
//! and shipping Python plus a JS runtime to do it. So this drives whatever
//! binary the user already has, and says plainly when there is not one.
//!
//! Nothing here is a fallback path: if yt-dlp is missing, YouTube sources are
//! simply unavailable and the UI says so.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Long enough for a search on a slow connection, short enough that a wedged
/// process does not hang the app forever.
const SEARCH_TIMEOUT_SECS: u64 = 60;
const VERSION_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtdlpStatus {
    pub found: bool,
    /// The path actually in use, once one was found.
    pub path: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtSearchHit {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration_ms: i64,
    pub thumbnail_url: Option<String>,
    pub url: String,
}

/// The binary to run: the configured path if it is set and exists, otherwise
/// whatever `yt-dlp` resolves to on PATH.
fn binary(configured: &str) -> Option<PathBuf> {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        let path = PathBuf::from(trimmed);
        if path.is_file() {
            return Some(path);
        }
    }
    // On Windows the executable is `yt-dlp.exe`; `Command` resolves PATHEXT for
    // a bare name, so asking for `yt-dlp` finds either.
    let probe = Command::new("yt-dlp").arg("--version").output();
    match probe {
        Ok(out) if out.status.success() => Some(PathBuf::from("yt-dlp")),
        _ => None,
    }
}

fn run(path: &Path, args: &[&str], timeout_secs: u64) -> Result<std::process::Output, String> {
    let mut command = Command::new(path);
    command.args(args);
    // yt-dlp is chatty on stderr and its progress bars are useless to us.
    command.env("PYTHONIOENCODING", "utf-8");

    let mut child = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("yt-dlp could not be started: {e}"))?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return Err(format!("yt-dlp did not answer within {timeout_secs}s"));
                }
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            Err(e) => return Err(format!("yt-dlp could not be waited on: {e}")),
        }
    }
    child
        .wait_with_output()
        .map_err(|e| format!("yt-dlp output could not be read: {e}"))
}

pub fn status(configured: &str) -> YtdlpStatus {
    let Some(path) = binary(configured) else {
        return YtdlpStatus {
            found: false,
            path: String::new(),
            version: None,
        };
    };
    match run(&path, &["--version"], VERSION_TIMEOUT_SECS) {
        Ok(out) if out.status.success() => YtdlpStatus {
            found: true,
            path: path.to_string_lossy().to_string(),
            version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        },
        _ => YtdlpStatus {
            found: false,
            path: path.to_string_lossy().to_string(),
            version: None,
        },
    }
}

/// Searches YouTube through yt-dlp rather than talking to InnerTube ourselves.
///
/// One more thing the tool already maintains, and it means a search costs one
/// process instead of a reimplementation of YouTube's private API that would
/// break on its own schedule.
pub fn search(configured: &str, query: &str, limit: u32) -> Result<Vec<YtSearchHit>, String> {
    let path = binary(configured).ok_or_else(|| "yt-dlp is not installed".to_string())?;
    let limit = limit.clamp(1, 50);
    let target = format!("ytsearch{limit}:{query}");
    let out = run(
        &path,
        &["--flat-playlist", "--dump-single-json", "--no-warnings", &target],
        SEARCH_TIMEOUT_SECS,
    )?;
    if !out.status.success() {
        return Err(format!(
            "yt-dlp search failed: {}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("no output")
        ));
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("yt-dlp returned something unexpected: {e}"))?;
    let entries = json
        .get("entries")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "yt-dlp search returned no results".to_string())?;

    Ok(entries.iter().filter_map(map_hit).collect())
}

fn map_hit(item: &serde_json::Value) -> Option<YtSearchHit> {
    let id = item.get("id").and_then(|v| v.as_str())?.to_string();
    let title = item.get("title").and_then(|v| v.as_str())?.to_string();
    // A flat search gives the channel, not a separate artist field; for music
    // uploads the channel is the artist often enough to be worth using.
    let artist = item
        .get("uploader")
        .or_else(|| item.get("channel"))
        .and_then(|v| v.as_str())
        .unwrap_or("YouTube")
        .to_string();
    let duration_ms = item
        .get("duration")
        .and_then(|v| v.as_f64())
        .map(|sec| (sec * 1000.0) as i64)
        .unwrap_or(0);
    let thumbnail_url = item
        .get("thumbnails")
        .and_then(|v| v.as_array())
        .and_then(|list| list.last())
        .and_then(|t| t.get("url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(YtSearchHit {
        url: format!("https://www.youtube.com/watch?v={id}"),
        id,
        title,
        artist,
        duration_ms,
        thumbnail_url,
    })
}

/// Downloads one track's audio into the cache.
///
/// `bestaudio` rather than an extracted-and-converted format on purpose: `-x`
/// needs ffmpeg, and a straight stream download does not. The container is
/// whatever YouTube serves (usually m4a), which the player reads fine.
pub fn download(configured: &str, url: &str, destination: &Path) -> Result<PathBuf, String> {
    let path = binary(configured).ok_or_else(|| "yt-dlp is not installed".to_string())?;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cache directory: {e}"))?;
    }
    let template = format!("{}.%(ext)s", destination.to_string_lossy());
    let out = run(
        &path,
        &[
            "--no-playlist",
            "--no-warnings",
            "--no-progress",
            "-f",
            "bestaudio[ext=m4a]/bestaudio",
            "-o",
            &template,
            url,
        ],
        600,
    )?;
    if !out.status.success() {
        return Err(format!(
            "yt-dlp download failed: {}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("no output")
        ));
    }
    // The extension is whatever yt-dlp chose, so the file is found rather than
    // assumed.
    let dir = destination.parent().unwrap_or(Path::new("."));
    let stem = destination
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let found = std::fs::read_dir(dir)
        .map_err(|e| format!("cache directory: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(&stem))
                .unwrap_or(false)
        });
    found.ok_or_else(|| "yt-dlp reported success but wrote no file".to_string())
}
