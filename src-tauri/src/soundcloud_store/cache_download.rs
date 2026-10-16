use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

use crate::soundcloud::StreamInfo;

use super::{emit_track_cache_progress, DESKTOP_UA};

const HTTP_TIMEOUT: Duration = Duration::from_secs(180);
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(180);
const REMOTE_READ_TIMEOUT_MICROS: &str = "15000000";

pub(super) async fn download_stream(
    info: &StreamInfo,
    cache_dir: &Path,
    track_id: &str,
    bin_dir: &Path,
    progress_app: Option<&AppHandle>,
) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(cache_dir)
        .await
        .map_err(|error| format!("Could not create SoundCloud cache directory: {error}"))?;

    match info.format.as_str() {
        "progressive" => download_progressive(&info.url, cache_dir, track_id, progress_app).await,
        "hls" => {
            let cache_dir = cache_dir.to_path_buf();
            let track_id = track_id.to_string();
            let url = info.url.clone();
            let bin_dir = bin_dir.to_path_buf();
            let progress_app = progress_app.cloned();
            tokio::task::spawn_blocking(move || {
                let ffmpeg = crate::native_audio::output::ensure_decoder_helper(&bin_dir)?;
                download_hls(&ffmpeg, &url, &cache_dir, &track_id, progress_app.as_ref())
            })
            .await
            .map_err(|error| format!("HLS cache worker failed: {error}"))?
        }
        format => Err(format!("unsupported SoundCloud stream format: {format}")),
    }
}

async fn download_progressive(
    url: &str,
    cache_dir: &Path,
    track_id: &str,
    progress_app: Option<&AppHandle>,
) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .user_agent(DESKTOP_UA)
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("progressive stream request failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("progressive stream request failed: {error}"))?;
    let total = response.content_length().unwrap_or(0);
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        });

    let stage_path = unique_stage_path(cache_dir, track_id, "download.part");
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage_path)
            .await
            .map_err(|error| format!("Could not create cache staging file: {error}"))?;

        emit_track_cache_progress(progress_app, track_id, 0, total, "running", None);
        let report_step = (total / 100).max(96 * 1024);
        let mut downloaded = 0u64;
        let mut reported = 0u64;
        let mut signature = Vec::with_capacity(16);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("progressive stream download failed: {error}"))?
        {
            if signature.len() < 16 {
                signature.extend_from_slice(&chunk[..chunk.len().min(16 - signature.len())]);
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("Could not write SoundCloud cache file: {error}"))?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded.saturating_sub(reported) >= report_step {
                reported = downloaded;
                emit_track_cache_progress(
                    progress_app,
                    track_id,
                    downloaded,
                    total,
                    "running",
                    None,
                );
            }
        }
        file.flush()
            .await
            .map_err(|error| format!("Could not flush SoundCloud cache file: {error}"))?;
        file.sync_all()
            .await
            .map_err(|error| format!("Could not sync SoundCloud cache file: {error}"))?;
        drop(file);

        if downloaded == 0 {
            return Err("progressive stream returned an empty audio file".into());
        }
        if total > 0 && downloaded != total {
            return Err(format!(
                "progressive stream ended after {downloaded} of {total} bytes"
            ));
        }
        let extension =
            infer_audio_extension(content_type.as_deref(), &signature).ok_or_else(|| {
                "progressive stream did not contain a recognized audio format".to_string()
            })?;
        let final_path = cache_dir.join(format!("{track_id}.{extension}"));
        promote_staged_file(&stage_path, &final_path)?;
        Ok::<PathBuf, String>(final_path)
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&stage_path).await;
    }
    result
}

fn download_hls(
    ffmpeg: &Path,
    url: &str,
    cache_dir: &Path,
    track_id: &str,
    progress_app: Option<&AppHandle>,
) -> Result<PathBuf, String> {
    let stage_path = unique_stage_path(cache_dir, track_id, "mka.part");
    let log_path = unique_stage_path(cache_dir, track_id, "ffmpeg.log");
    let result = (|| {
        let stderr = File::create(&log_path)
            .map_err(|error| format!("Could not create FFmpeg diagnostic log: {error}"))?;
        let mut command = Command::new(ffmpeg);
        command
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-rw_timeout",
                REMOTE_READ_TIMEOUT_MICROS,
                "-i",
                url,
                "-map",
                "0:a:0",
                "-vn",
                "-sn",
                "-dn",
                "-c:a",
                "copy",
                "-f",
                "matroska",
                "-y",
            ])
            .arg(&stage_path);
        crate::child::quiet(&mut command);
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr))
            .spawn()
            .map_err(|error| {
                format!("Could not start the managed HLS cache downloader: {error}")
            })?;

        emit_track_cache_progress(progress_app, track_id, 0, 0, "running", None);
        let deadline = Instant::now() + FFMPEG_TIMEOUT;
        let mut reported_bytes = 0u64;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    if let Ok(bytes) = fs::metadata(&stage_path).map(|metadata| metadata.len()) {
                        if bytes > reported_bytes {
                            reported_bytes = bytes;
                            emit_track_cache_progress(
                                progress_app,
                                track_id,
                                bytes,
                                0,
                                "running",
                                None,
                            );
                        }
                    }
                    thread::sleep(Duration::from_millis(150));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "managed HLS cache download exceeded {} seconds",
                        FFMPEG_TIMEOUT.as_secs()
                    ));
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Could not wait for the HLS cache downloader: {error}"
                    ));
                }
            }
        };
        if !status.success() {
            let detail = read_log_tail(&log_path);
            return Err(if detail.is_empty() {
                format!("managed HLS cache download exited with {status}")
            } else {
                format!("managed HLS cache download failed: {detail}")
            });
        }

        let file = File::open(&stage_path)
            .map_err(|error| format!("FFmpeg did not create the HLS cache file: {error}"))?;
        let size = file
            .metadata()
            .map_err(|error| format!("Could not read HLS cache file metadata: {error}"))?
            .len();
        if size == 0 {
            return Err("HLS stream produced an empty cache file".into());
        }
        let mut signature = [0; 4];
        let read = (&file)
            .take(4)
            .read(&mut signature)
            .map_err(|error| format!("Could not validate the HLS cache container: {error}"))?;
        if read != signature.len() || signature != [0x1a, 0x45, 0xdf, 0xa3] {
            return Err("HLS stream did not produce a valid Matroska audio container".into());
        }

        let final_path = cache_dir.join(format!("{track_id}.mka"));
        promote_staged_file(&stage_path, &final_path)?;
        emit_track_cache_progress(progress_app, track_id, size, size, "running", None);
        Ok(final_path)
    })();

    let _ = fs::remove_file(&log_path);
    if result.is_err() {
        let _ = fs::remove_file(&stage_path);
    }
    result
}

fn unique_stage_path(cache_dir: &Path, track_id: &str, suffix: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    cache_dir.join(format!(
        ".{track_id}.{}.{}.{}",
        std::process::id(),
        nonce,
        suffix
    ))
}

pub(super) fn unique_stage_base(cache_dir: &Path, track_id: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    cache_dir.join(format!(
        ".{track_id}.{}.{}.ytdlp",
        std::process::id(),
        nonce
    ))
}

pub(super) fn cleanup_staged_base(cache_dir: &Path, base_path: &Path) {
    let Some(prefix) = base_path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix))
        {
            let _ = fs::remove_file(path);
        }
    }
}

pub(super) fn promote_staged_file(stage_path: &Path, final_path: &Path) -> Result<(), String> {
    if final_path.exists() {
        if final_path
            .metadata()
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == 0)
        {
            fs::remove_file(final_path)
                .map_err(|error| format!("Could not replace an empty cache file: {error}"))?;
        } else {
            return Err(format!(
                "a completed cache file already exists at {}",
                final_path.display()
            ));
        }
    }
    fs::rename(stage_path, final_path)
        .map_err(|error| format!("Could not atomically finalize SoundCloud cache file: {error}"))
}

fn infer_audio_extension(content_type: Option<&str>, signature: &[u8]) -> Option<&'static str> {
    if matches!(content_type, Some("audio/aac" | "audio/aacp")) {
        return Some("aac");
    }
    if is_adts_frame(signature) {
        return Some("aac");
    }
    if signature.starts_with(b"ID3") || is_mpeg_frame(signature) {
        return Some("mp3");
    }
    if signature.starts_with(b"fLaC") {
        return Some("flac");
    }
    if signature.starts_with(b"OggS") {
        return match content_type {
            Some("audio/opus" | "audio/x-opus") => Some("opus"),
            _ => Some("ogg"),
        };
    }
    if signature.starts_with(b"RIFF") && signature.get(8..12).is_some_and(|value| value == b"WAVE")
    {
        return Some("wav");
    }
    if signature.get(4..8).is_some_and(|value| value == b"ftyp") {
        return Some("m4a");
    }
    if signature.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some("webm");
    }

    match content_type? {
        "audio/mpeg" | "audio/mp3" | "audio/x-mpeg" => Some("mp3"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "audio/aac" | "audio/aacp" => Some("aac"),
        "audio/flac" | "audio/x-flac" => Some("flac"),
        "audio/ogg" | "application/ogg" => Some("ogg"),
        "audio/opus" | "audio/x-opus" => Some("opus"),
        "audio/wav" | "audio/wave" | "audio/x-wav" => Some("wav"),
        "audio/webm" | "video/webm" => Some("webm"),
        _ => None,
    }
}

fn is_adts_frame(signature: &[u8]) -> bool {
    signature.len() >= 2 && signature[0] == 0xff && signature[1] & 0xf6 == 0xf0
}

fn is_mpeg_frame(signature: &[u8]) -> bool {
    signature.len() >= 2
        && signature[0] == 0xff
        && signature[1] & 0xf0 == 0xf0
        && signature[1] & 0x06 != 0
}

fn read_log_tail(path: &Path) -> String {
    const MAX_LOG_TAIL: u64 = 4096;
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let Ok(size) = file.metadata().map(|metadata| metadata.len()) else {
        return String::new();
    };
    let _ = file.seek(SeekFrom::Start(size.saturating_sub(MAX_LOG_TAIL)));
    let mut buffer = Vec::with_capacity(MAX_LOG_TAIL as usize);
    if file.read_to_end(&mut buffer).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buffer)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .to_string()
}
