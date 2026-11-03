//! Bounded, opt-in clear HLS windows for acoustic analysis.
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_PLAYLIST: usize = 256 * 1024;
const MAX_MEDIA: usize = 1024 * 1024;
const MAX_SEGMENT: usize = 512 * 1024;
const TIMEOUT: Duration = Duration::from_secs(35);
const WINDOW: f64 = 8.0;

struct TempFile {
    path: PathBuf,
    file: Option<File>,
}
impl TempFile {
    fn new(extension: &str) -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for _ in 0..16 {
            let path = std::env::temp_dir().join(format!(
                "tempo-sonara-{}-{stamp}-{}.{extension}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x04000000);
            }
            match options.open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                    })
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("Could not create temporary audio".into()),
            }
        }
        Err("Could not create temporary audio".into())
    }
}
impl Drop for TempFile {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}
pub struct PreviewFiles {
    files: [TempFile; 2],
    _permit: OwnedSemaphorePermit,
}
impl PreviewFiles {
    pub fn paths(&self) -> [&Path; 2] {
        [&self.files[0].path, &self.files[1].path]
    }
}
fn slots() -> &'static Arc<Semaphore> {
    static S: OnceLock<Arc<Semaphore>> = OnceLock::new();
    S.get_or_init(|| Arc::new(Semaphore::new(2)))
}
fn trusted_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url
            .host_str()
            .is_some_and(|h| h == "sndcdn.com" || h.ends_with(".sndcdn.com"))
}
#[derive(Debug)]
struct Segment {
    url: reqwest::Url,
    start: f64,
    duration: f64,
}
fn parse_playlist(base: &reqwest::Url, body: &str, duration: f64) -> Result<Vec<Segment>, String> {
    // At this minimum duration the two 20%/60% windows do not overlap.
    if !trusted_url(base)
        || !body.starts_with("#EXTM3U")
        || !duration.is_finite()
        || duration < 28.0
        || duration > 6.0 * 3600.0
    {
        return Err("Unsupported HLS playlist".into());
    }
    let mut segments = Vec::new();
    let mut pending = None;
    let mut total = 0.0;
    let mut ended = false;
    for line in body.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        if line == "#EXT-X-ENDLIST" {
            ended = true;
            continue;
        }
        if line.starts_with("#EXT-X-KEY:") {
            if line != "#EXT-X-KEY:METHOD=NONE" {
                return Err("Encrypted HLS is unsupported".into());
            }
        } else if line.starts_with("#EXT-X-BYTERANGE")
            || line.starts_with("#EXT-X-MAP")
            || line.starts_with("#EXT-X-DISCONTINUITY")
            || line.starts_with("#EXT-X-STREAM-INF")
            || line.starts_with("#EXT-X-GAP")
        {
            return Err("Unsupported HLS playlist layout".into());
        } else if let Some(value) = line.strip_prefix("#EXTINF:") {
            if pending.is_some() || ended {
                return Err("Invalid HLS playlist".into());
            }
            let d: f64 = value
                .split(',')
                .next()
                .unwrap_or("")
                .parse()
                .map_err(|_| "Invalid segment duration")?;
            if !d.is_finite() || !(0.01..=30.0).contains(&d) {
                return Err("Invalid segment duration".into());
            }
            pending = Some(d);
        } else if !line.starts_with('#') {
            let d = pending.take().ok_or("Missing segment duration")?;
            let url = base.join(line).map_err(|_| "Invalid segment URL")?;
            if !trusted_url(&url) || ended || segments.len() >= 4096 {
                return Err("Unsupported segment URL".into());
            }
            segments.push(Segment {
                url,
                start: total,
                duration: d,
            });
            total += d;
        }
    }
    if !ended
        || pending.is_some()
        || segments.is_empty()
        || (total - duration).abs() > 2.0_f64.max(duration * 0.01)
    {
        return Err("HLS duration mismatch".into());
    }
    Ok(segments)
}
fn window_segments(segments: &[Segment], start: f64) -> Result<(Vec<usize>, f64), String> {
    let ids: Vec<_> = segments
        .iter()
        .enumerate()
        .filter(|(_, s)| s.start + s.duration > start && s.start < start + WINDOW)
        .map(|(i, _)| i)
        .collect();
    let first = *ids.first().ok_or("Missing HLS window")?;
    let last = *ids.last().ok_or("Missing HLS window")?;
    if ids.len() > 12 || segments[last].start + segments[last].duration + 0.001 < start + WINDOW {
        return Err("Incomplete HLS window".into());
    }
    Ok((ids, start - segments[first].start))
}
async fn fetch(
    client: &reqwest::Client,
    url: reqwest::Url,
    limit: usize,
) -> Result<(reqwest::Url, Vec<u8>), String> {
    if !trusted_url(&url) {
        return Err("Untrusted audio host".into());
    }
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Audio request failed")?;
    if !response.status().is_success()
        || !trusted_url(response.url())
        || response.content_length().is_some_and(|n| n > limit as u64)
    {
        return Err("Invalid audio response".into());
    }
    let final_url = response.url().clone();
    let mut bytes = Vec::new();
    while let Some(part) = response
        .chunk()
        .await
        .map_err(|_| "Audio download interrupted")?
    {
        if bytes.len().saturating_add(part.len()) > limit {
            return Err("Audio response too large".into());
        }
        bytes.extend_from_slice(&part);
    }
    Ok((final_url, bytes))
}
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
fn transcode(
    bytes: Vec<u8>,
    seek: f64,
    ffmpeg: &Path,
    cancelled: &AtomicBool,
) -> Result<TempFile, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err("Audio analysis cancelled".into());
    }
    let mut input = TempFile::new("ts")?;
    let inp = input.file.as_mut().ok_or("Temporary file unavailable")?;
    inp.write_all(&bytes)
        .and_then(|_| inp.seek(SeekFrom::Start(0)).map(|_| ()))
        .map_err(|_| "Could not prepare audio")?;
    let mut output = TempFile::new("wav")?;
    let mut command = Command::new(ffmpeg);
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "pipe",
            "-i",
            "pipe:0",
            "-ss",
        ])
        .arg(format!("{seek:.6}"))
        .args([
            "-t",
            "8",
            "-vn",
            "-sn",
            "-dn",
            "-threads",
            "1",
            "-ac",
            "1",
            "-ar",
            "22050",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "pipe:1",
        ])
        .stdin(Stdio::from(
            inp.try_clone().map_err(|_| "Could not read audio")?,
        ))
        .stdout(Stdio::from(
            output
                .file
                .as_ref()
                .ok_or("Temporary file unavailable")?
                .try_clone()
                .map_err(|_| "Could not write audio")?,
        ))
        .stderr(Stdio::null());
    crate::child::quiet(&mut command);
    let mut child = command.spawn().map_err(|_| "Audio decoder unavailable")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return Err("Audio decoder failed".into()),
            Ok(None) => {}
        }
        if cancelled.load(Ordering::Relaxed)
            || Instant::now() >= deadline
            || std::fs::metadata(&output.path)
                .map(|m| m.len() > 512 * 1024)
                .unwrap_or(true)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Audio decoder stopped".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // Streaming WAV headers contain unknown sizes; correct them for file decoders.
    let file = output.file.as_mut().ok_or("Temporary file unavailable")?;
    let size = file.metadata().map_err(|_| "Invalid decoded audio")?.len();
    if size < 352_800 || size > 354_000 {
        return Err("Incomplete audio window".into());
    }
    let mut head = vec![0; size.min(512) as usize];
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.read_exact(&mut head))
        .map_err(|_| "Invalid decoded audio")?;
    if !head.starts_with(b"RIFF") || head.get(8..12) != Some(b"WAVE") {
        return Err("Invalid decoded audio".into());
    }
    let mut at = 12usize;
    let mut data = None;
    while at + 8 <= head.len() {
        let len = u32::from_le_bytes(head[at + 4..at + 8].try_into().unwrap()) as usize;
        if &head[at..at + 4] == b"data" {
            data = Some(at);
            break;
        }
        at = at
            .checked_add(8)
            .and_then(|v| v.checked_add(len + (len & 1)))
            .ok_or("Invalid WAV")?;
    }
    let data = data.ok_or("Invalid WAV")?;
    let samples = size - data as u64 - 8;
    if samples != 352_800 {
        return Err("Incomplete audio window".into());
    }
    file.seek(SeekFrom::Start(4))
        .and_then(|_| file.write_all(&((size - 8) as u32).to_le_bytes()))
        .and_then(|_| file.seek(SeekFrom::Start((data + 4) as u64)))
        .and_then(|_| file.write_all(&(samples as u32).to_le_bytes()))
        .and_then(|_| file.flush())
        .map_err(|_| "Could not finalize audio")?;
    Ok(output)
}
/// The caller must check opt-in. Failure is a normal fallback to metadata-only ranking.
pub async fn download_preview(
    source: &str,
    source_id: &str,
    duration_sec: f64,
    bin_dir: &Path,
) -> Result<PreviewFiles, String> {
    if source != "soundcloud"
        || source_id.is_empty()
        || source_id.len() > 32
        || !source_id.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("Unsupported source".into());
    }
    let ffmpeg = bin_dir.join("audio").join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    });
    if !ffmpeg.is_file() {
        return Err("Audio decoder unavailable".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel_guard = CancelOnDrop(cancelled.clone());
    tokio::time::timeout(TIMEOUT, async {
        let permit = slots()
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Preview queue closed")?;
        let stream = crate::soundcloud::get_clear_hls_stream(source_id).await?;
        let url = reqwest::Url::parse(&stream.url).map_err(|_| "Invalid HLS URL")?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::custom(|a| {
                if a.previous().len() >= 3 || !trusted_url(a.url()) {
                    a.stop()
                } else {
                    a.follow()
                }
            }))
            .timeout(TIMEOUT)
            .user_agent("Tempo/1.0")
            .build()
            .map_err(|_| "Audio client unavailable")?;
        let (playlist_url, body) = fetch(&client, url, MAX_PLAYLIST).await?;
        let segments = parse_playlist(
            &playlist_url,
            std::str::from_utf8(&body).map_err(|_| "Invalid HLS playlist")?,
            duration_sec,
        )?;
        let starts = [(duration_sec - WINDOW) * 0.2, (duration_sec - WINDOW) * 0.6];
        let plans = [
            window_segments(&segments, starts[0])?,
            window_segments(&segments, starts[1])?,
        ];
        let mut windows = [Vec::new(), Vec::new()];
        let mut total = 0usize;
        for (slot, (ids, _)) in plans.iter().enumerate() {
            for id in ids {
                let (_, bytes) = fetch(&client, segments[*id].url.clone(), MAX_SEGMENT).await?;
                total = total.saturating_add(bytes.len());
                if total > MAX_MEDIA {
                    return Err("Audio windows too large".into());
                }
                windows[slot].extend_from_slice(&bytes);
            }
        }
        let flag = cancelled.clone();
        let result = tokio::task::spawn_blocking(move || {
            let [a, b] = windows;
            let first = transcode(a, plans[0].1, &ffmpeg, &flag)?;
            let second = transcode(b, plans[1].1, &ffmpeg, &flag)?;
            Ok::<_, String>(PreviewFiles {
                files: [first, second],
                _permit: permit,
            })
        })
        .await
        .map_err(|_| "Audio decoder stopped")??;
        Ok(result)
    })
    .await
    .map_err(|_| "Audio preview timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn playlist() -> String {
        let mut value = "#EXTM3U\n#EXT-X-VERSION:3\n".to_string();
        for i in 0..10 {
            value.push_str(&format!("#EXTINF:4.0,\n{i}.ts\n"));
        }
        value.push_str("#EXT-X-ENDLIST\n");
        value
    }
    #[test]
    fn selects_two_timed_windows_and_rejects_unsafe_playlists() {
        let base = reqwest::Url::parse("https://cf-media.sndcdn.com/test/audio.m3u8").unwrap();
        let segments = parse_playlist(&base, &playlist(), 40.0).unwrap();
        let first = window_segments(&segments, (40.0 - WINDOW) * 0.2).unwrap();
        let second = window_segments(&segments, (40.0 - WINDOW) * 0.6).unwrap();
        assert_eq!(first.0, vec![1, 2, 3]);
        assert_eq!(second.0, vec![4, 5, 6]);
        assert!((first.1 - 2.4).abs() < 1e-9);
        assert!((second.1 - 3.2).abs() < 1e-9);
        for tag in [
            "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"",
            "#EXT-X-BYTERANGE:123@0",
            "#EXT-X-MAP:URI=\"init\"",
            "#EXT-X-DISCONTINUITY",
        ] {
            assert!(
                parse_playlist(&base, &playlist().replace("#EXT-X-VERSION:3", tag), 40.0).is_err()
            );
        }
        assert!(parse_playlist(
            &base,
            &playlist().replace("0.ts", "https://example.com/0.ts"),
            40.0
        )
        .is_err());
        assert!(parse_playlist(&base, &playlist(), 50.0).is_err());
        assert!(parse_playlist(&base, &playlist().replace("#EXT-X-ENDLIST", ""), 40.0).is_err());
        assert!(!trusted_url(
            &reqwest::Url::parse("https://sndcdn.com.evil.test/a").unwrap()
        ));
    }
    #[test]
    fn decoder_produces_eight_second_wav_and_drop_removes_it() {
        let mut generate = Command::new("ffmpeg");
        generate.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=22050",
            "-t",
            "12",
            "-c:a",
            "aac",
            "-f",
            "mpegts",
            "pipe:1",
        ]);
        crate::child::quiet(&mut generate);
        let output = match generate.output() {
            Ok(output) if output.status.success() => output,
            _ => return,
        };
        let preview = transcode(
            output.stdout,
            2.0,
            Path::new("ffmpeg"),
            &AtomicBool::new(false),
        )
        .unwrap();
        let path = preview.path.clone();
        assert!(path.exists());
        assert!(std::fs::File::open(&path).is_ok());
        drop(preview);
        assert!(!path.exists());
    }
    #[test]
    fn concatenated_hls_segments_decode_as_a_window() {
        let marker = TempFile::new("fixture").unwrap();
        let root = marker.path.clone();
        drop(marker);
        std::fs::create_dir(&root).unwrap();
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _fixture = Fixture(root.clone());
        let mut command = Command::new("ffmpeg");
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=22050:duration=18",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:sample_rate=22050:duration=22",
                "-filter_complex",
                "[0:a][1:a]concat=n=2:v=0:a=1[out]",
                "-map",
                "[out]",
                "-c:a",
                "aac",
                "-f",
                "hls",
                "-hls_time",
                "4",
                "-hls_playlist_type",
                "vod",
                "-hls_segment_filename",
            ])
            .arg(root.join("part-%d.ts"))
            .arg(root.join("stream.m3u8"));
        crate::child::quiet(&mut command);
        match command.output() {
            Ok(result) if result.status.success() => {}
            _ => return,
        }
        let base = reqwest::Url::parse("https://cf-media.sndcdn.com/stream.m3u8").unwrap();
        let body = std::fs::read_to_string(root.join("stream.m3u8")).unwrap();
        let entries = parse_playlist(&base, &body, 40.0).unwrap();
        for (start, expected) in [(6.4, 440.0), (19.2, 880.0)] {
            let (ids, offset) = window_segments(&entries, start).unwrap();
            let mut bytes = Vec::new();
            for id in ids {
                bytes.extend(std::fs::read(root.join(format!("part-{id}.ts"))).unwrap());
            }
            let preview =
                transcode(bytes, offset, Path::new("ffmpeg"), &AtomicBool::new(false)).unwrap();
            let wav = std::fs::read(&preview.path).unwrap();
            let data = wav.windows(4).position(|part| part == b"data").unwrap() + 8;
            let samples: Vec<i16> = wav[data..]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect();
            let crossings = samples
                .windows(2)
                .filter(|pair| pair[0] <= 0 && pair[1] > 0)
                .count() as f64
                / 8.0;
            assert!((crossings - expected).abs() < 35.0, "frequency {crossings}");
        }
    }
    #[test]
    fn cancellation_prevents_decoder_start() {
        assert!(transcode(vec![], 0.0, Path::new("ffmpeg"), &AtomicBool::new(true)).is_err());
    }
    #[tokio::test]
    async fn abort_cleans_both_files() {
        let (send, recv) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let permit = slots().clone().acquire_owned().await.unwrap();
            let files = PreviewFiles {
                files: [TempFile::new("wav").unwrap(), TempFile::new("wav").unwrap()],
                _permit: permit,
            };
            send.send(files.paths().map(Path::to_owned)).unwrap();
            std::future::pending::<()>().await;
            drop(files);
        });
        let paths = recv.await.unwrap();
        assert!(paths
            .iter()
            .all(|p| p.parent() == Some(std::env::temp_dir().as_path()) && p.exists()));
        task.abort();
        let _ = task.await;
        assert!(paths.iter().all(|p| !p.exists()));
    }
}
