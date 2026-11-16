use std::collections::VecDeque;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

use ebur128::{EbuR128, Mode};
use rodio::{Decoder, Source};
use rusqlite::{params, OptionalExtension};

use crate::database::Db;

const TARGET_LUFS: f64 = -14.0;
const PEAK_CEILING_DB: f64 = -1.5;
const MAX_BOOST_DB: f64 = 12.0;
const MIN_GAIN_DB: f64 = -30.0;
const FILE_CACHE_SIZE: usize = 128;
// Estimate from consecutive 400 ms gated blocks. Only a full file scan may
// boost audio. A streamed intro cannot predict how loud the rest will get.
const LIVE_INITIAL_MS: usize = 400;
const LIVE_UPDATE_MS: usize = 1_000;
const LIVE_CACHE_MIN_SECONDS: usize = 8;
const DISK_CACHE_LIMIT: i64 = 8192;
const FILE_CHUNK_FRAMES: usize = 4_096;
static FILE_SCANNING: AtomicBool = AtomicBool::new(false);
static FILE_GAINS: OnceLock<Mutex<VecDeque<(FileKey, f32)>>> = OnceLock::new();
static STREAM_GAINS: OnceLock<Mutex<VecDeque<(String, f32)>>> = OnceLock::new();

#[derive(Clone, Eq, PartialEq)]
struct FileKey {
    path: PathBuf,
    byte_len: u64,
    modified: SystemTime,
}

impl FileKey {
    fn read(path: &Path) -> Option<Self> {
        let metadata = path.metadata().ok()?;
        Some(Self {
            path: path.to_owned(),
            byte_len: metadata.len(),
            modified: metadata.modified().ok()?,
        })
    }

    fn cache_key(&self, mode: &str) -> String {
        let modified = match self.modified.duration_since(UNIX_EPOCH) {
            Ok(elapsed) => elapsed.as_nanos() as i128,
            Err(error) => -(error.duration().as_nanos() as i128),
        };
        format!("{mode}:1:{}:{modified}:{}", self.byte_len, self.path.display())
    }
}

pub(super) struct TrackLoudness {
    db: Option<Arc<Db>>,
    enabled: AtomicBool,
    live_gain: AtomicU32,
    file_gain: AtomicU32,
    file: OnceLock<FileKey>,
    stream_key: OnceLock<String>,
    file_attempted: AtomicBool,
}

impl TrackLoudness {
    pub fn new(enabled: bool, db: Option<Arc<Db>>) -> Arc<Self> {
        Arc::new(Self {
            db,
            enabled: AtomicBool::new(enabled),
            live_gain: AtomicU32::new(f32::NAN.to_bits()),
            file_gain: AtomicU32::new(f32::NAN.to_bits()),
            file: OnceLock::new(),
            stream_key: OnceLock::new(),
            file_attempted: AtomicBool::new(false),
        })
    }

    /// Use the file's measured gain from the very first sample on repeat plays.
    /// Called only for formats the playback decoder can read without FFmpeg.
    pub fn set_file(&self, path: &Path) {
        let Some(key) = FileKey::read(path) else {
            return;
        };
        let in_memory = file_gains()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find_map(|(cached, gain)| (*cached == key).then_some(*gain));
        let measured = in_memory.or_else(|| self.read_gain(&key.cache_key("file")));
        if let Some(gain) = measured {
            self.file_gain.store(gain.to_bits(), Ordering::Relaxed);
        }
        #[cfg(debug_assertions)]
        if self.enabled.load(Ordering::Relaxed) {
            eprintln!("[tempo loudness] file_cache_hit={}", measured.is_some());
        }
        let _ = self.file.set(key);
    }

    /// Measure a short prefix off the output thread. The caller rewinds the
    /// decoder so the first audible frame already uses the provisional gain.
    pub fn measure_intro<D>(self: &Arc<Self>, decoder: &mut D) -> bool
    where
        D: Source<Item = f32>,
    {
        if !self.enabled.load(Ordering::Relaxed) || self.has_file_gain() || self.live_gain().is_some() {
            return false;
        }
        let channels = decoder.channels().get() as usize;
        let rate = decoder.sample_rate().get();
        let mut meter = LiveLoudness::new(self.clone(), channels as u32, rate);
        let mut frame = vec![0.0; channels];
        let frames = rate as usize * (LIVE_INITIAL_MS + 10) / 1000;
        let mut consumed = false;
        for _ in 0..frames {
            for sample in &mut frame {
                let Some(value) = decoder.next() else { return consumed };
                *sample = value;
                consumed = true;
            }
            meter.observe(&frame);
        }
        consumed
    }

    pub fn set_stream(&self, key: Option<String>) {
        let Some(key) = key else { return };
        let in_memory = stream_gains()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find_map(|(cached, gain)| (*cached == key).then_some(*gain));
        self.seed_live_gain(in_memory.or_else(|| self.read_gain(&key)));
        let _ = self.stream_key.set(key);
    }

    pub fn set_local_stream(&self, path: &Path) {
        self.set_stream(FileKey::read(path).map(|key| key.cache_key("estimate")));
    }

    fn read_gain(&self, key: &str) -> Option<f32> {
        if !self.enabled.load(Ordering::Relaxed) {
            return None;
        }
        cached_gain(self.db.as_deref()?, key)
    }

    pub fn configure(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    /// Called for the active output only after playback has settled.
    pub fn scan_file_when_idle(self: &Arc<Self>) {
        if !self.enabled.load(Ordering::Relaxed)
            || self.has_file_gain()
            || self.file_attempted.load(Ordering::Relaxed)
        {
            return;
        }
        let Some(key) = self.file.get().cloned() else {
            return;
        };
        if FILE_SCANNING.swap(true, Ordering::AcqRel) {
            return;
        }
        self.file_attempted.store(true, Ordering::Relaxed);
        let target = Arc::downgrade(self);
        let db = self.db.clone();
        if std::thread::Builder::new()
            .name("tempo-file-loudness".into())
            .spawn(move || {
                let _guard = FileScanGuard;
                #[cfg(windows)]
                {
                    use windows::Win32::System::Threading::{
                        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
                    };
                    // The file analysis must yield to playback on busy systems.
                    // The current-thread pseudo-handle stays valid for this call.
                    let _ = unsafe {
                        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL)
                    };
                }
                let cache_key = key.cache_key("file");
                let saved = db.as_deref().and_then(|db| cached_gain(db, &cache_key));
                if let Some(gain) = saved.or_else(|| scan_file(&key, &target)) {
                    if let Some(target) = target.upgrade() {
                        // Keep any late boost for the next play, where it can start
                        // with the correct gain instead of rising mid-track.
                        if gain <= target.linear_gain() {
                            target.file_gain.store(gain.to_bits(), Ordering::Relaxed);
                        }
                    }
                    {
                        let mut cache = file_gains()
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if cache.len() >= FILE_CACHE_SIZE {
                            cache.pop_front();
                        }
                        cache.push_back((key, gain));
                    }
                    if let (None, Some(db)) = (saved, db.as_deref()) {
                        save_cached_gain(db, &cache_key, gain, false);
                    }
                } else if let Some(target) = target.upgrade() {
                    // If the user disables normalization, allow a later toggle
                    // to restart analysis. Invalid files already have live metering.
                    if !target.enabled.load(Ordering::Relaxed) {
                        target.file_attempted.store(false, Ordering::Relaxed);
                    }
                }
            })
            .is_err()
        {
            self.file_attempted.store(false, Ordering::Relaxed);
            FILE_SCANNING.store(false, Ordering::Release);
        }
    }

    pub fn linear_gain(&self) -> f32 {
        if !self.enabled.load(Ordering::Relaxed) {
            return 1.0;
        }
        let file_gain = f32::from_bits(self.file_gain.load(Ordering::Relaxed));
        if file_gain.is_finite() {
            file_gain
        } else {
            self.live_gain().unwrap_or(1.0)
        }
    }

    pub fn live_gain(&self) -> Option<f32> {
        let gain = f32::from_bits(self.live_gain.load(Ordering::Relaxed));
        gain.is_finite().then_some(gain)
    }

    pub fn seed_live_gain(&self, gain: Option<f32>) {
        if let Some(gain) = gain {
            self.lower_live_gain(gain);
        }
    }

    fn lower_live_gain(&self, gain: f32) {
        // Keep the stronger cut if a replacement decoder has already measured
        // its buffer or if a quiet passage skews the integrated estimate.
        let _ = self
            .live_gain
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |bits| {
                let previous = f32::from_bits(bits);
                let next = previous.min(gain).min(1.0);
                (next.to_bits() != bits).then_some(next.to_bits())
            });
    }

    fn has_file_gain(&self) -> bool {
        f32::from_bits(self.file_gain.load(Ordering::Relaxed)).is_finite()
    }
}

struct FileScanGuard;

impl Drop for FileScanGuard {
    fn drop(&mut self) {
        FILE_SCANNING.store(false, Ordering::Release);
    }
}

fn file_gains() -> &'static Mutex<VecDeque<(FileKey, f32)>> {
    FILE_GAINS.get_or_init(|| Mutex::new(VecDeque::with_capacity(FILE_CACHE_SIZE)))
}

fn stream_gains() -> &'static Mutex<VecDeque<(String, f32)>> {
    STREAM_GAINS.get_or_init(|| Mutex::new(VecDeque::with_capacity(FILE_CACHE_SIZE)))
}

fn remember_stream_gain(key: &str, gain: f32) {
    let mut cache = stream_gains()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((_, saved)) = cache.iter_mut().find(|(cached, _)| cached == key) {
        *saved = saved.min(gain);
        return;
    }
    if cache.len() == FILE_CACHE_SIZE {
        cache.pop_front();
    }
    cache.push_back((key.to_owned(), gain));
}

fn cached_gain(db: &Db, key: &str) -> Option<f32> {
    db.with_conn(|conn| {
        conn.query_row("SELECT gain FROM native_loudness_cache WHERE cache_key = ?1", [key], |row| {
            row.get::<_, f32>(0)
        })
        .optional()
        .map_err(|error| error.to_string())
    })
    .ok()
    .flatten()
    .filter(|gain| gain.is_finite() && *gain > 0.0 && *gain <= 4.0)
}

fn save_cached_gain(db: &Db, key: &str, gain: f32, attenuation_only: bool) {
    let _ = db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO native_loudness_cache(cache_key, gain, measured_at) VALUES (?1, ?2, unixepoch())
             ON CONFLICT(cache_key) DO UPDATE SET
                gain = CASE WHEN ?3 THEN MIN(gain, excluded.gain) ELSE excluded.gain END,
                measured_at = excluded.measured_at",
            params![key, gain, attenuation_only],
        ).map_err(|error| error.to_string())?;
        conn.execute(
            "DELETE FROM native_loudness_cache WHERE rowid IN
             (SELECT rowid FROM native_loudness_cache ORDER BY measured_at DESC, rowid DESC LIMIT -1 OFFSET ?1)",
            [DISK_CACHE_LIMIT],
        ).map_err(|error| error.to_string())?;
        Ok(())
    });
}

fn scan_file(key: &FileKey, target: &Weak<TrackLoudness>) -> Option<f32> {
    let file = File::open(&key.path).ok()?;
    let mut decoder = Decoder::builder()
        .with_data(BufReader::with_capacity(64 * 1024, file))
        .with_byte_len(key.byte_len)
        .build()
        .ok()?;
    let channels = decoder.channels().get() as usize;
    let rate = decoder.sample_rate().get();
    let mut meter = EbuR128::new(
        channels as u32,
        rate,
        Mode::I | Mode::TRUE_PEAK | Mode::HISTOGRAM,
    )
    .ok()?;
    let mut chunk = Vec::with_capacity(FILE_CHUNK_FRAMES * channels);
    loop {
        if !target
            .upgrade()
            .is_some_and(|target| target.enabled.load(Ordering::Relaxed))
        {
            return None;
        }
        chunk.clear();
        chunk.extend(decoder.by_ref().take(chunk.capacity()).map(clean_sample));
        chunk.truncate(chunk.len() / channels * channels);
        if chunk.is_empty() {
            break;
        }
        meter.add_frames_f32(&chunk).ok()?;
    }
    let lufs = meter.loudness_global().ok()?;
    let peak = (0..channels)
        .filter_map(|channel| meter.true_peak(channel as u32).ok())
        .fold(0.0, f64::max);
    gain_for_measurement(lufs, peak, MAX_BOOST_DB)
}

pub(super) struct LiveLoudness {
    target: Arc<TrackLoudness>,
    meter: Option<EbuR128>,
    channels: u32,
    rate: u32,
    chunk: Vec<f32>,
    until_update: usize,
    observed_frames: usize,
    measured_gain: f32,
}

impl LiveLoudness {
    pub fn new(target: Arc<TrackLoudness>, channels: u32, rate: u32) -> Self {
        Self {
            target,
            meter: None,
            channels,
            rate,
            chunk: Vec::new(),
            until_update: rate as usize * LIVE_INITIAL_MS / 1000,
            observed_frames: 0,
            measured_gain: 1.0,
        }
    }

    pub fn observe(&mut self, frame: &[f32]) {
        if self.target.has_file_gain() {
            if self.chunk.capacity() != 0 {
                self.meter = None;
                self.chunk = Vec::new();
            }
            return;
        }
        if !self.target.enabled.load(Ordering::Relaxed) {
            return;
        }
        if self.chunk.capacity() == 0 {
            self.chunk =
                Vec::with_capacity((self.rate as usize / 100).max(1) * self.channels as usize);
        }
        self.chunk.extend(frame.iter().copied().map(clean_sample));
        if self.chunk.len() < self.chunk.capacity() {
            return;
        }
        let channels = self.channels;
        let rate = self.rate;
        if self.meter.is_none() {
            self.meter = EbuR128::new(
                channels,
                rate,
                Mode::I | Mode::SAMPLE_PEAK | Mode::HISTOGRAM,
            )
            .ok();
        }
        let Some(meter) = self.meter.as_mut() else {
            self.chunk.clear();
            return;
        };
        let frames = self.chunk.len() / channels as usize;
        let result = meter.add_frames_f32(&self.chunk);
        self.chunk.clear();
        if result.is_err() {
            return;
        }
        self.observed_frames += frames;
        self.until_update = self.until_update.saturating_sub(frames);
        if self.until_update != 0 {
            return;
        }
        self.until_update = rate as usize * LIVE_UPDATE_MS / 1000;
        let Ok(lufs) = meter.loudness_global() else {
            return;
        };
        let peak = (0..channels)
            .filter_map(|channel| meter.sample_peak(channel).ok())
            .fold(0.0, f64::max);
        if let Some(gain) = gain_for_measurement(lufs, peak, 0.0) {
            self.measured_gain = self.measured_gain.min(gain);
            self.target.lower_live_gain(gain);
            if self.observed_frames >= self.rate as usize * LIVE_CACHE_MIN_SECONDS && self.measured_gain < 1.0 {
                if let Some(key) = self.target.stream_key.get() {
                    remember_stream_gain(key, self.measured_gain);
                }
            }
        }
    }
}

impl Drop for LiveLoudness {
    fn drop(&mut self) {
        if self.observed_frames < self.rate as usize * LIVE_CACHE_MIN_SECONDS || self.measured_gain >= 1.0 {
            return;
        }
        if let (Some(db), Some(key)) = (self.target.db.clone(), self.target.stream_key.get().cloned()) {
            let gain = self.measured_gain;
            // Decoder shutdown is joined by the audio output. Keep SQL off that path.
            tauri::async_runtime::spawn_blocking(move || save_cached_gain(&db, &key, gain, true));
        }
    }
}

fn clean_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

fn gain_for_measurement(lufs: f64, peak: f64, max_boost: f64) -> Option<f32> {
    if !lufs.is_finite() || !peak.is_finite() || peak <= 0.0 {
        return None;
    }
    let peak_gain = PEAK_CEILING_DB - 20.0 * peak.log10();
    let gain_db = (TARGET_LUFS - lufs)
        .clamp(MIN_GAIN_DB, max_boost)
        .min(peak_gain);
    Some(10.0_f64.powf(gain_db / 20.0) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const RATE: u32 = 48_000;
    const FILE_DURATION: u32 = 2;

    fn tone_sample(frame: u32, amplitude: f32) -> f32 {
        let phase = std::f32::consts::TAU * (frame % 48) as f32 / 48.0;
        amplitude * phase.sin()
    }

    fn test_tone_file(amplitude: f32) -> tempfile::NamedTempFile {
        let mut file = tempfile::Builder::new().suffix(".wav").tempfile().unwrap();
        let len = RATE * FILE_DURATION * 2 * 2;
        let mut wave = Vec::new();
        wave.extend(b"RIFF");
        wave.extend((len + 36).to_le_bytes());
        wave.extend(b"WAVEfmt ");
        wave.extend(16u32.to_le_bytes());
        wave.extend(1u16.to_le_bytes()); // PCM
        wave.extend(2u16.to_le_bytes()); // stereo
        wave.extend(RATE.to_le_bytes());
        wave.extend((RATE * 4).to_le_bytes());
        wave.extend(4u16.to_le_bytes());
        wave.extend(16u16.to_le_bytes());
        wave.extend(b"data");
        wave.extend(len.to_le_bytes());
        for frame in 0..RATE * FILE_DURATION {
            let value = (tone_sample(frame, amplitude) * f32::from(i16::MAX)) as i16;
            wave.extend(value.to_le_bytes());
            wave.extend(value.to_le_bytes());
        }
        file.write_all(&wave).unwrap();
        file
    }

    #[test]
    fn local_files_at_different_volumes_match_after_normalization() {
        let quiet = test_tone_file(0.06);
        let loud = test_tone_file(0.9);
        let analyze = |file: &tempfile::NamedTempFile, target: &Arc<TrackLoudness>| {
            scan_file(
                &FileKey::read(file.path()).unwrap(),
                &Arc::downgrade(target),
            )
            .unwrap()
        };
        let target = TrackLoudness::new(true, None);
        let quiet_gain = analyze(&quiet, &target);
        let loud_gain = analyze(&loud, &target);
        assert!(quiet_gain > 1.0);
        assert!(loud_gain < 1.0);
        let difference_db = 20.0 * (quiet_gain * 0.06 / (loud_gain * 0.9)).log10();
        assert!(difference_db.abs() < 0.1, "{difference_db:.3} dB");
    }

    #[test]
    fn a_new_playback_uses_the_persisted_file_gain_and_rejects_changed_files() {
        let file = test_tone_file(0.7);
        let directory = tempfile::tempdir().unwrap();
        let db_path = directory.path().join("loudness.db");
        let key = FileKey::read(file.path()).unwrap().cache_key("file");
        {
            let db = Db::open_at(&db_path).unwrap();
            save_cached_gain(&db, &key, 0.6, false);
        }
        let db = Arc::new(Db::open_at(&db_path).unwrap());
        let first = TrackLoudness::new(true, Some(db.clone()));
        first.set_file(file.path());
        assert_eq!(first.linear_gain(), 0.6);
        assert!(!first.file_attempted.load(Ordering::Relaxed));

        std::fs::OpenOptions::new().append(true).open(file.path()).unwrap().write_all(b"change").unwrap();
        let changed = TrackLoudness::new(true, Some(db));
        changed.set_file(file.path());
        assert_eq!(changed.linear_gain(), 1.0);
    }

    #[test]
    fn cold_loud_intro_is_normalized_before_the_first_playback_sample() {
        let file = test_tone_file(0.9);
        let mut decoder = Decoder::builder()
            .with_data(BufReader::new(File::open(file.path()).unwrap()))
            .with_byte_len(file.as_file().metadata().unwrap().len())
            .with_seekable(true)
            .build()
            .unwrap();
        let target = TrackLoudness::new(true, None);
        let start = std::time::Duration::ZERO;
        let opening = decoder.by_ref().take(16).collect::<Vec<_>>();
        decoder.try_seek(start).unwrap();
        target.set_file(file.path());
        assert_eq!(target.linear_gain(), 1.0);

        assert!(target.measure_intro(&mut decoder));
        assert!(target.linear_gain() < 0.5);
        assert!(!target.has_file_gain());
        decoder.try_seek(start).unwrap();
        assert_eq!(decoder.by_ref().take(16).collect::<Vec<_>>(), opening);
    }

    #[test]
    fn stream_cache_reuses_attenuation_and_never_replaces_it_with_a_boost() {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(Db::open_at(&directory.path().join("stream.db")).unwrap());
        let key = String::from("stream:1:soundcloud:123:90");
        let first = TrackLoudness::new(true, Some(db.clone()));
        first.set_stream(Some(key.clone()));
        let mut meter = LiveLoudness::new(first.clone(), 2, RATE);
        for frame in 0..RATE * 9 {
            let sample = tone_sample(frame, 0.9);
            meter.observe(&[sample, sample]);
        }
        let measured = first.linear_gain();
        drop(meter);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while cached_gain(&db, &key).is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(cached_gain(&db, &key), Some(measured));
        save_cached_gain(&db, &key, 1.0, true);
        assert_eq!(cached_gain(&db, &key), Some(measured));

        let next = TrackLoudness::new(true, Some(db));
        next.set_stream(Some(key));
        assert!(measured < 1.0);
        assert_eq!(next.linear_gain(), measured);
    }

    #[test]
    fn preparing_a_file_does_not_start_a_second_decoder_and_meter_releases_storage() {
        let file = test_tone_file(0.7);
        let target = TrackLoudness::new(false, None);
        target.set_file(file.path());
        let mut meter = LiveLoudness::new(target.clone(), 2, RATE);
        meter.observe(&[0.5, 0.5]);
        assert_eq!(meter.chunk.capacity(), 0);

        target.configure(true);
        assert!(!target.file_attempted.load(Ordering::Relaxed));
        for frame in 0..RATE {
            let sample = tone_sample(frame, 0.7);
            meter.observe(&[sample, sample]);
        }
        assert!(meter.meter.is_some());
        target.file_gain.store(0.4_f32.to_bits(), Ordering::Relaxed);
        meter.observe(&[0.5, 0.5]);
        assert!(meter.meter.is_none());
        assert_eq!(meter.chunk.capacity(), 0);
    }

    #[test]
    fn streams_cut_loud_audio_without_a_delayed_boost() {
        let quiet = TrackLoudness::new(true, None);
        let loud = TrackLoudness::new(true, None);
        let mut quiet_meter = LiveLoudness::new(quiet.clone(), 2, RATE);
        let mut loud_meter = LiveLoudness::new(loud.clone(), 2, RATE);
        for frame in 0..RATE * 10 {
            let quiet_sample = tone_sample(frame, 0.06);
            let loud_sample = tone_sample(frame, 0.9);
            quiet_meter.observe(&[quiet_sample, quiet_sample]);
            loud_meter.observe(&[loud_sample, loud_sample]);
            if frame >= RATE {
                assert!(loud.linear_gain() < 0.5);
            }
            assert_eq!(quiet.linear_gain(), 1.0);
        }
        let gain = loud.linear_gain();
        loud.configure(false);
        assert_eq!(loud.linear_gain(), 1.0);
        loud.configure(true);
        assert_eq!(loud.linear_gain(), gain);
    }

    #[test]
    fn stream_never_releases_attenuation_when_audio_quiets_or_decoder_restarts() {
        let track = TrackLoudness::new(true, None);
        let mut meter = LiveLoudness::new(track.clone(), 2, RATE);
        for frame in 0..RATE {
            let sample = tone_sample(frame, 0.8);
            meter.observe(&[sample, sample]);
        }
        let initial_gain = track.linear_gain();
        assert!(initial_gain < 0.5);
        for frame in 0..RATE * 10 {
            let sample = tone_sample(frame, 0.2);
            meter.observe(&[sample, sample]);
            assert!(track.linear_gain() <= initial_gain);
        }
        let replacement = TrackLoudness::new(true, None);
        replacement.lower_live_gain(0.8);
        replacement.seed_live_gain(track.live_gain());
        assert_eq!(replacement.linear_gain(), track.linear_gain());
        replacement.lower_live_gain(0.8);
        assert_eq!(replacement.linear_gain(), track.linear_gain());
    }

    #[test]
    fn ceiling_takes_precedence_over_target_for_high_crest_tracks() {
        let peak = 1.12;
        let gain = gain_for_measurement(-27.0, peak, MAX_BOOST_DB).unwrap();
        let normalized_peak_db = 20.0 * (peak * f64::from(gain)).log10();
        assert!((PEAK_CEILING_DB - normalized_peak_db).abs() < 0.001);
        assert!(gain_for_measurement(f64::NEG_INFINITY, 0.0, MAX_BOOST_DB).is_none());
    }
}
