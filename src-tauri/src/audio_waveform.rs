use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use rodio::{Decoder, Source};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Semaphore;

use crate::commands::AppState;

const PEAK_COUNT: usize = 144;
const MAX_SCAN_TIME: Duration = Duration::from_secs(3);
static SLOT: Semaphore = Semaphore::const_new(1);
static MEMORY: Mutex<VecDeque<(String, Vec<f32>)>> = Mutex::new(VecDeque::new());

#[derive(serde::Deserialize)]
#[serde(tag = "source", content = "id", rename_all = "lowercase")]
pub enum WaveformTrack {
    Local(i64),
    Youtube(String),
}

#[tauri::command]
pub async fn audio_waveform(
    app: AppHandle,
    state: State<'_, AppState>,
    track: WaveformTrack,
    duration_sec: f64,
    cache_disk: bool,
) -> Result<Vec<f32>, String> {
    let db = state.db.clone();
    let youtube_cache = state.yt_cache_dir.clone();
    let bin_dir = state.bin_dir.clone();
    let (path, key) = tauri::async_runtime::spawn_blocking(move || {
        let path = match track {
            WaveformTrack::Local(id) if id > 0 => db
                .resolve_registered_audio_path(Some(id), None, None)?
                .map(PathBuf::from),
            WaveformTrack::Youtube(id)
                if !id.is_empty()
                    && id.len() <= 128
                    && id.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
                    }) =>
            {
                db.resolve_registered_audio_path(None, Some("youtube"), Some(&id))?
                    .map(PathBuf::from)
                    .or_else(|| {
                        crate::native_audio::resolver::find_youtube_cache(&youtube_cache, &id)
                    })
            }
            _ => return Err("invalid waveform track".to_owned()),
        }
        .ok_or("audio file is unavailable")?;
        let key = file_key(&path).ok_or("file identity is unavailable")?;
        Ok((path, key))
    })
    .await
    .map_err(|error| error.to_string())??;
    let cache_dir = if cache_disk {
        app.path().app_cache_dir().ok()
    } else {
        None
    };
    let _slot = tokio::time::timeout(Duration::from_secs(5), SLOT.acquire())
        .await
        .map_err(|_| "waveform analysis queue timed out")?
        .map_err(|_| "waveform analysis unavailable")?;
    let cached = MEMORY.lock().ok().and_then(|entries| {
        entries
            .iter()
            .find(|(cached_key, _)| *cached_key == key)
            .map(|(_, peaks)| peaks.clone())
    });
    let disk = match &cache_dir {
        Some(dir) => crate::waveform_cache::load(dir, &key).await,
        None => None,
    };
    let peaks = match (disk, cached) {
        (Some(peaks), _) => return Ok(peaks),
        (None, Some(peaks)) => peaks,
        (None, None) => {
            let live_key = key.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let peaks = analyze(&path, duration_sec, &bin_dir)?;
                if file_key(&path).as_deref() != Some(live_key.as_str()) {
                    return Err("audio changed during waveform analysis".into());
                }
                Ok::<_, String>(peaks)
            })
            .await
            .map_err(|error| error.to_string())??
        }
    };
    if let Ok(mut entries) = MEMORY.lock() {
        entries.retain(|(existing, _)| *existing != key);
        if entries.len() >= 32 {
            entries.pop_front();
        }
        entries.push_back((key.clone(), peaks.clone()));
    }
    if let Some(dir) = cache_dir {
        crate::waveform_cache::store(&dir, &key, &peaks).await;
    }
    Ok(peaks)
}

fn file_key(path: &Path) -> Option<String> {
    let metadata = path.metadata().ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    let mut key = Sha256::new();
    key.update(path.as_os_str().as_encoded_bytes());
    key.update(metadata.len().to_le_bytes());
    key.update(modified.as_nanos().to_le_bytes());
    Some(format!("audio-v1:{:x}", key.finalize()))
}

fn open_decoder(path: &Path) -> Result<Decoder<BufReader<File>>, String> {
    let file = File::open(path).map_err(|_| "cannot open waveform audio")?;
    let size = file
        .metadata()
        .map_err(|_| "cannot read waveform audio metadata")?
        .len();
    Decoder::builder()
        .with_data(BufReader::new(file))
        .with_byte_len(size)
        .with_seekable(true)
        .build()
        .map_err(|_| "unsupported waveform audio".to_owned())
}

fn analyze(path: &Path, duration_hint: f64, bin_dir: &Path) -> Result<Vec<f32>, String> {
    let deadline = Instant::now() + MAX_SCAN_TIME;
    let mut decoder = match open_decoder(path) {
        Ok(decoder) => decoder,
        Err(_) => return analyze_with_helper(path, bin_dir, deadline),
    };
    let duration = decoder
        .total_duration()
        .map(|duration| duration.as_secs_f64())
        .filter(|seconds| *seconds > 0.0)
        .unwrap_or(duration_hint);
    if !duration.is_finite() || !(0.01..=86_400.0).contains(&duration) {
        return Err("unknown waveform audio duration".into());
    }
    let window_sec = (duration / PEAK_COUNT as f64).min(0.06);
    let window_samples =
        (decoder.sample_rate().get() as f64 * decoder.channels().get() as f64 * window_sec)
            .round()
            .clamp(1.0, 24_576.0) as usize;
    let mut peaks = vec![0.0_f32; PEAK_COUNT];
    for (index, peak) in peaks.iter_mut().enumerate() {
        if Instant::now() >= deadline {
            return Err("waveform analysis timed out".into());
        }
        let position = duration * (index as f64 + 0.5) / PEAK_COUNT as f64 - window_sec / 2.0;
        if decoder
            .try_seek(Duration::from_secs_f64(position.max(0.0)))
            .is_err()
        {
            return sequential_peaks(path, duration, deadline);
        }
        *peak = decoder
            .by_ref()
            .take(window_samples)
            .fold(0.0_f32, |max, sample| max.max(sample.abs()));
    }
    Ok(normalize(peaks))
}

// Opus and other files played by the managed helper use the same installed
// binary, without triggering an installation or keeping decoded PCM in memory.
fn analyze_with_helper(path: &Path, bin_dir: &Path, deadline: Instant) -> Result<Vec<f32>, String> {
    const MAX_PCM_BYTES: u64 = 8 * 1024 * 1024;
    let helper = bin_dir.join("audio").join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    });
    if !helper.is_file() {
        return Err("waveform decoder is unavailable".into());
    }
    let mut pcm = tempfile::tempfile().map_err(|error| error.to_string())?;
    let output = pcm.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(helper);
    let mut child = crate::child::quiet(&mut command)
        .args([
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(path)
        .args([
            "-map", "0:a:0", "-ac", "1", "-ar", "2000", "-fs", "8388608", "-f", "s16le", "-",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(output)
        .spawn()
        .map_err(|error| error.to_string())?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err("waveform decoding failed".into()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("waveform decoding did not complete".into());
            }
        }
    }
    let bytes = pcm.metadata().map_err(|error| error.to_string())?.len();
    if !(2..MAX_PCM_BYTES).contains(&bytes) {
        return Err("waveform sample output is outside budget".into());
    }
    pcm.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let samples = bytes as usize / 2;
    let mut reader = BufReader::new(pcm);
    let mut peaks = vec![0.0_f32; PEAK_COUNT];
    let mut sample = [0; 2];
    for index in 0..samples {
        reader
            .read_exact(&mut sample)
            .map_err(|error| error.to_string())?;
        let bin = index * PEAK_COUNT / samples;
        peaks[bin] = peaks[bin].max(i16::from_le_bytes(sample).unsigned_abs() as f32 / 32_768.0);
    }
    Ok(normalize(peaks))
}

fn sequential_peaks(path: &Path, duration: f64, deadline: Instant) -> Result<Vec<f32>, String> {
    let mut decoder = open_decoder(path)?;
    let sample_rate = decoder.sample_rate().get() as f64 * decoder.channels().get() as f64;
    let mut peaks = vec![0.0_f32; PEAK_COUNT];
    let samples_per_peak = (sample_rate * duration / PEAK_COUNT as f64).ceil() as usize;
    for (index, sample) in decoder.by_ref().enumerate() {
        if index % 8192 == 0 && Instant::now() >= deadline {
            return Err("waveform analysis timed out".into());
        }
        let bin = (index / samples_per_peak.max(1)).min(PEAK_COUNT - 1);
        peaks[bin] = peaks[bin].max(sample.abs());
    }
    Ok(normalize(peaks))
}

fn normalize(mut peaks: Vec<f32>) -> Vec<f32> {
    let max = peaks.iter().copied().fold(0.01_f32, f32::max);
    if !max.is_finite() {
        return vec![0.0; peaks.len()];
    }
    for peak in &mut peaks {
        *peak = (*peak / max).clamp(0.0, 1.0);
    }
    peaks
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn waveform_follows_volume_at_different_positions() {
        let mut wave = tempfile::NamedTempFile::new().unwrap();
        let rate = 8_000_u32;
        let frames = rate * 4;
        let bytes = frames * 2;
        wave.write_all(b"RIFF").unwrap();
        wave.write_all(&(bytes + 36).to_le_bytes()).unwrap();
        wave.write_all(b"WAVEfmt ").unwrap();
        wave.write_all(&[16, 0, 0, 0, 1, 0, 1, 0]).unwrap();
        wave.write_all(&rate.to_le_bytes()).unwrap();
        wave.write_all(&(rate * 2).to_le_bytes()).unwrap();
        wave.write_all(&[2, 0, 16, 0]).unwrap();
        wave.write_all(b"data").unwrap();
        wave.write_all(&bytes.to_le_bytes()).unwrap();
        for i in 0..frames {
            let amplitude = if i < rate * 2 { 800_i16 } else { 24_000_i16 };
            wave.write_all(&amplitude.to_le_bytes()).unwrap();
        }
        wave.flush().unwrap();
        let peaks = analyze(wave.path(), 4.0, Path::new("")).unwrap();
        assert_eq!(peaks.len(), PEAK_COUNT);
        assert!(peaks[PEAK_COUNT / 4] < 0.1);
        assert!(peaks[3 * PEAK_COUNT / 4] > 0.95);
    }
}
