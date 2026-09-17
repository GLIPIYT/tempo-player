//! yt-dlp as something the app looks after, not something the user installs.
//!
//! YouTube extraction is an arms race: SABR streaming, PO tokens, signature
//! changes, and periodic breakage that yt-dlp answers within days. Nobody
//! downloads a music player in order to then go and install a Python tool and
//! keep it current, so this fetches the standalone build itself and refreshes
//! it when a newer one exists.
//!
//! The build it fetches is the single-file executable, so there is no Python
//! and no JS runtime to go with it.
//!
//! A path the user set by hand always wins and is never touched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::Emitter;

/// Long enough for a search on a slow connection, short enough that a wedged
/// process does not hang the app forever.
const SEARCH_TIMEOUT_SECS: u64 = 60;
const VERSION_TIMEOUT_SECS: u64 = 10;

const RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const DOWNLOAD_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtdlpStatus {
    pub found: bool,
    /// The path actually in use, once one was found.
    pub path: String,
    pub version: Option<String>,
    /// True while the app is fetching or refreshing its own copy.
    pub managed: bool,
    /// Set when a fetch or refresh failed, so the UI can say why.
    pub error: Option<String>,
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

/// The standalone build for this platform, as named in the release assets.
fn asset_name() -> &'static str {
    if cfg!(target_os = "windows") {
        if cfg!(target_arch = "aarch64") {
            "yt-dlp_arm64.exe"
        } else {
            "yt-dlp.exe"
        }
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp_linux"
    }
}

/// The file name of the fetched copy.
fn binary_name() -> &'static str {
    asset_name()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("tempo-player")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// The binary to run: a path the user set by hand if it exists, otherwise the
/// copy the app fetched for itself.
fn binary(configured: &str, bin_dir: &Path) -> Option<PathBuf> {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        let path = PathBuf::from(trimmed);
        if path.is_file() {
            return Some(path);
        }
        // A path was given and it is wrong. Falling back to our own copy would
        // hide the mistake, so nothing is returned and the UI says so.
        return None;
    }
    let managed = bin_dir.join(binary_name());
    if managed.is_file() {
        return Some(managed);
    }
    None
}

fn run(path: &Path, args: &[&str], timeout_secs: u64) -> Result<std::process::Output, String> {
    let mut command = Command::new(path);
    command.args(args);
    command.env("PYTHONIOENCODING", "utf-8");

    let mut child = command
        // A GUI process has no console, so there is no stdin to hand over;
        // passing on an invalid handle is what Python complains about.
        .stdin(std::process::Stdio::null())
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

fn version_of(path: &Path) -> Option<String> {
    match run(path, &["--version"], VERSION_TIMEOUT_SECS) {
        Ok(out) if out.status.success() => {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        _ => None,
    }
}

/// The version GitHub currently publishes.
async fn latest_version() -> Result<String, String> {
    let response = client()
        .get(RELEASE_API)
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status().as_u16()));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("unexpected release response: {e}"))?;
    json.get("tag_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "the release has no version".to_string())
}

async fn fetch_binary(destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    let url = format!("{DOWNLOAD_BASE}/{}", asset_name());
    let response = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("download failed with {}", response.status().as_u16()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    // Written beside the target and moved into place, so a download that dies
    // halfway cannot leave a truncated binary that looks installed.
    let temporary = destination.with_extension("part");
    std::fs::write(&temporary, &bytes).map_err(|e| format!("could not write: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&temporary, destination).map_err(|e| format!("could not install: {e}"))?;
    Ok(())
}

/// Makes sure there is a working binary, fetching or refreshing the app's own
/// copy when the user has not pointed at one.
///
/// Never replaces a hand-set path: that one belongs to whoever set it.
pub async fn ensure(configured: &str, bin_dir: &Path) -> YtdlpStatus {
    let hand_set = !configured.trim().is_empty();
    if hand_set {
        return status(configured, bin_dir, false);
    }

    let managed = bin_dir.join(binary_name());
    let current = version_of(&managed);
    let latest = latest_version().await;

    let needs_fetch = match (&current, &latest) {
        // Nothing yet: fetch whatever is current.
        (None, Ok(_)) => true,
        // Present and GitHub is unreachable: keep what we have rather than
        // throwing away a working binary over a failed check.
        (Some(_), Err(_)) => false,
        (Some(have), Ok(want)) => have != want,
        (None, Err(_)) => false,
    };

    let mut error = None;
    if needs_fetch {
        if let Err(e) = fetch_binary(&managed).await {
            error = Some(e);
        }
    } else if current.is_none() {
        error = latest.err();
    }

    let mut result = status(configured, bin_dir, true);
    if result.error.is_none() {
        result.error = error;
    }
    result
}

/// Reads the current state without touching the network.
pub fn status(configured: &str, bin_dir: &Path, managed: bool) -> YtdlpStatus {
    let Some(path) = binary(configured, bin_dir) else {
        return YtdlpStatus {
            found: false,
            path: String::new(),
            version: None,
            managed,
            error: None,
        };
    };
    match version_of(&path) {
        Some(version) => YtdlpStatus {
            found: true,
            path: path.to_string_lossy().to_string(),
            version: Some(version),
            managed,
            error: None,
        },
        None => YtdlpStatus {
            found: false,
            path: path.to_string_lossy().to_string(),
            version: None,
            managed,
            error: Some("the binary is there but will not run".to_string()),
        },
    }
}

/// Percent-encodes a search query for a URL.
fn encode_query(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for byte in query.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Searches YouTube Music, songs only.
///
/// The `#songs` fragment is the section selector the extractor documents, and
/// it is the whole difference between a music search and a list of ordinary
/// videos that happen to match the words.
pub fn search(
    configured: &str,
    bin_dir: &Path,
    query: &str,
    limit: u32,
) -> Result<Vec<YtSearchHit>, String> {
    let path = binary(configured, bin_dir).ok_or_else(|| "yt-dlp is not available".to_string())?;
    let limit = limit.clamp(1, 50);
    let target = format!(
        "https://music.youtube.com/search?q={}#songs",
        encode_query(query)
    );
    let end = limit.to_string();
    let out = run(
        &path,
        &[
            "--flat-playlist",
            "--dump-single-json",
            "--no-warnings",
            "--playlist-end",
            &end,
            &target,
        ],
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
    // A flat search carries no artist at all, so this starts empty rather than
    // guessing - the enrichment pass fills it in a moment later.
    let artist = item
        .get("uploader")
        .or_else(|| item.get("channel"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let duration_ms = item
        .get("duration")
        .and_then(|v| v.as_f64())
        .map(|sec| (sec * 1000.0) as i64)
        .unwrap_or(0);
    // A flat search returns no thumbnails either, but YouTube's image URLs are
    // deterministic from the video id, so the cover costs nothing and needs no
    // extra request.
    let thumbnail_url = item
        .get("thumbnails")
        .and_then(|v| v.as_array())
        .and_then(|list| list.last())
        .and_then(|t| t.get("url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg")));
    Some(YtSearchHit {
        url: format!("https://www.youtube.com/watch?v={id}"),
        id,
        title,
        artist,
        duration_ms,
        thumbnail_url,
    })
}

/// Emitted once per track as its metadata resolves.
pub const ENRICH_EVENT: &str = "ytdlp://enriched";

/// Emitted when an enrichment stops, however it stopped.
///
/// The caller is waiting on one event per track, so without this a run that
/// ends early - a failure, a cancellation, a track yt-dlp skipped - would leave
/// rows waiting forever for something that is never coming.
pub const ENRICH_DONE_EVENT: &str = "ytdlp://enriched-done";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichDone {
    pub job_id: String,
    /// Set when the run failed, so the UI can say why instead of just stopping.
    pub error: Option<String>,
}

/// What a full extraction adds on top of a flat search.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YtEnrichment {
    pub job_id: String,
    pub id: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
}

/// A plain mutex, not tokio's: this is read and written from a blocking task
/// that has no business awaiting anything.
fn running_enrichments() -> &'static Mutex<HashMap<String, u32>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stops an enrichment that is still working through its list.
///
/// Worth having: a batch of twenty takes about half a minute, and typing one
/// more letter would otherwise leave the previous one running to the end
/// alongside the new one.
pub fn cancel_enrichment(job_id: &str) {
    let pid = match running_enrichments().lock() {
        Ok(mut map) => map.remove(job_id),
        Err(_) => None,
    };
    let Some(pid) = pid else { return };
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

/// Resolves metadata for a list of ids, reporting each one as it lands.
///
/// Streaming rather than returning a list, because resolving a track takes
/// about a second and a half: a batch of twenty would sit silent for half a
/// minute and then arrive all at once. yt-dlp prints a line as it finishes each
/// video, so following its output spreads the same work over the same time with
/// results appearing throughout.
pub fn enrich_streaming(
    app: tauri::AppHandle,
    configured: &str,
    bin_dir: &Path,
    job_id: &str,
    ids: &[String],
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }

    // Sent in small batches through the same helper the search uses.
    //
    // The search is the one call that has always worked, and every attempt to
    // give the enrichment its own arrangement - a pipe, then a scratch file -
    // produced a process that exited successfully having said nothing. Rather
    // than keep inventing, this reuses the arrangement that is known to work.
    // Four at a time is a compromise: results appear every few seconds instead
    // of every one, and each batch is small enough that one bad track cannot
    // hold up the rest for long.
    const BATCH: usize = 4;
    // A path set by hand wins here too, exactly as it does everywhere else.
    let path = binary(configured, bin_dir).ok_or_else(|| "yt-dlp is not available".to_string())?;
    let mut produced = 0usize;
    let mut complaint = String::new();

    for chunk in ids.chunks(BATCH) {
        let mut args: Vec<String> = vec![
            "--no-warnings".into(),
            "--ignore-errors".into(),
            "--no-playlist".into(),
            "--skip-download".into(),
            // JSON rather than `--print`.
            //
            // `--print` writes in the system code page, so on a Russian Windows
            // every Cyrillic artist came back as question marks - while titles,
            // which arrive as JSON from the search, were fine. That asymmetry
            // was the whole clue. JSON is UTF-8 and the extraction costs the
            // same either way.
            "--dump-json".into(),
        ];
        for id in chunk {
            args.push(format!("https://www.youtube.com/watch?v={id}"));
        }
        let borrowed: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        match run(&path, &borrowed, 300) {
            Ok(out) => {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    let Some(entry) = parse_json_entry(line.trim(), job_id) else {
                        continue;
                    };
                    produced += 1;
                    let _ = app.emit(ENRICH_EVENT, entry);
                }
                if !out.status.success() && produced == 0 {
                    complaint = String::from_utf8_lossy(&out.stderr).trim().to_string();
                }
            }
            Err(e) => complaint = e,
        }
    }

    let error = if produced == 0 {
        let tail: Vec<&str> = complaint
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("Deprecated Feature"))
            .collect();
        let start = tail.len().saturating_sub(2);
        Some(if tail.is_empty() {
            "yt-dlp read nothing".to_string()
        } else {
            format!("yt-dlp read nothing: {}", tail[start..].join(" | "))
        })
    } else {
        None
    };
    let _ = app.emit(
        ENRICH_DONE_EVENT,
        EnrichDone {
            job_id: job_id.to_string(),
            error,
        },
    );
    Ok(())
}

/// One `--dump-json` line, reduced to what the rows need.
fn parse_json_entry(line: &str, job_id: &str) -> Option<YtEnrichment> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = value.get("id").and_then(|v| v.as_str())?.to_string();

    let text = |v: Option<&serde_json::Value>| -> Option<String> {
        v.and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    // The music-specific field first, then the list, then the channel: a
    // YouTube Music result carries the first two, a plain video only the last.
    let artist = text(value.get("artist"))
        .or_else(|| {
            value
                .get("artists")
                .and_then(|v| v.as_array())
                .and_then(|list| list.first())
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| text(value.get("uploader")))
        .or_else(|| text(value.get("channel")));
    let album = text(value.get("album"));
    let duration_ms = value
        .get("duration")
        .and_then(|v| v.as_f64())
        .map(|sec| (sec * 1000.0) as i64);

    Some(YtEnrichment {
        job_id: job_id.to_string(),
        id,
        artist,
        album,
        duration_ms,
    })
}

/// Downloads one track's audio into the cache.
///
/// `bestaudio` rather than an extracted-and-converted format on purpose: `-x`
/// needs ffmpeg, and a straight stream download does not. The container is
/// whatever YouTube serves (usually m4a), which the player reads fine.
pub fn download(
    configured: &str,
    bin_dir: &Path,
    url: &str,
    destination: &Path,
) -> Result<PathBuf, String> {
    let path = binary(configured, bin_dir).ok_or_else(|| "yt-dlp is not available".to_string())?;
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
    std::fs::read_dir(dir)
        .map_err(|e| format!("cache directory: {e}"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(&stem))
                .unwrap_or(false)
        })
        .ok_or_else(|| "yt-dlp reported success but wrote no file".to_string())
}

