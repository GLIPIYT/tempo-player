use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rodio::source::SeekError;
use rodio::{Decoder, Source};
use rtrb::{Consumer, Producer, RingBuffer};

use super::{OutputSettings, SourceSpec};

const REMOTE_SAMPLE_RATE: u32 = 48_000;
const REMOTE_RING_SECONDS: usize = 8;
const REMOTE_READ_TIMEOUT_MICROS: &str = "15000000";
const LOCAL_MAX_CHANNELS: usize = 2;
// A quarter-second keeps local decode comfortably ahead while making a seek's
// stale-frame discard strictly bounded on Rodio's source thread.
const LOCAL_RING_FRAMES: usize = REMOTE_SAMPLE_RATE as usize / 4;
const FFMPEG_STDERR_LIMIT: usize = 16 * 1024;

fn log_startup_timing(stage: &str, source: &str, started: Instant) {
    #[cfg(debug_assertions)]
    eprintln!(
        "[tempo startup] stage={stage} source={source} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    #[cfg(not(debug_assertions))]
    let _ = (stage, source, started);
}

pub(super) type AudioSource = Box<dyn Source<Item = f32> + Send + 'static>;

pub struct PreparedAudio {
    pub(super) spec: SourceSpec,
    pub(super) settings: OutputSettings,
    pub(super) source: Option<AudioSource>,
    pub(super) clock: Arc<PositionClock>,
    pub(super) duration_sec: Option<f64>,
    pub(super) bin_dir: PathBuf,
    pub(super) remote: Option<RemoteControl>,
    pub(super) local: Option<LocalControl>,
    pub(super) buffering: Option<Arc<AtomicBool>>,
}

impl PreparedAudio {
    pub fn shutdown(&mut self) {
        if let Some(remote) = self.remote.as_mut() {
            remote.stop();
        }
        if let Some(local) = self.local.as_mut() {
            local.stop();
        }
        self.source.take();
    }
}

impl Drop for PreparedAudio {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(super) fn prepare_input(
    spec: SourceSpec,
    position: f64,
    settings: OutputSettings,
    bin_dir: PathBuf,
) -> Result<PreparedAudio, String> {
    let prepare_started = Instant::now();
    let position = if position.is_finite() {
        position.max(0.0)
    } else {
        0.0
    };
    let mut remote = None;
    let mut local = None;
    let buffering;

    let source: AudioSource;
    let duration_sec;
    if let Some(url) = remote_url(&spec.location)? {
        let helper_started = Instant::now();
        let ffmpeg = ensure_ffmpeg(&bin_dir)?;
        log_startup_timing("ffmpeg_ready", "remote", helper_started);
        let decoder_started = Instant::now();
        let (remote_source, control, status) =
            open_decoder_input(&ffmpeg, OsStr::new(&url), position, spec.duration_sec)?;
        log_startup_timing("decoder_start", "remote", decoder_started);
        duration_sec = valid_duration(spec.duration_sec);
        source = Box::new(remote_source);
        buffering = Some(status.buffering.clone());
        remote = Some(control);
    } else {
        let path = PathBuf::from(&spec.location);
        let open_started = Instant::now();
        let file = File::open(&path)
            .map_err(|error| format!("Could not open audio file '{}': {error}", path.display()))?;
        let byte_len = file
            .metadata()
            .map_err(|error| format!("Could not read audio file metadata: {error}"))?
            .len();
        log_startup_timing("local_open_and_metadata", "local", open_started);
        let decoder_started = Instant::now();
        let decoder = Decoder::builder()
            .with_data(BufReader::with_capacity(64 * 1024, file))
            .with_byte_len(byte_len)
            .with_seekable(true)
            .build();
        log_startup_timing("decoder_build", "local", decoder_started);
        match decoder {
            Ok(mut decoder) => {
                let duration_started = Instant::now();
                let decoder_duration = decoder
                    .total_duration()
                    .map(|duration| duration.as_secs_f64());
                log_startup_timing("decoder_duration", "local", duration_started);
                // Check seek support before handing the decoder to its worker,
                // including at zero so later UI seeks do not discover an
                // unsupported decoder only after playback has started.
                let seek_started = Instant::now();
                let seek_result = decoder.try_seek(Duration::from_secs_f64(position));
                log_startup_timing("decoder_initial_seek", "local", seek_started);
                if seek_result.is_ok() && decoder.channels().get() as usize <= LOCAL_MAX_CHANNELS {
                    duration_sec = valid_duration(spec.duration_sec).or(decoder_duration);
                    let worker_started = Instant::now();
                    let (local_source, control, status) = open_local_buffered(decoder, position)?;
                    log_startup_timing("local_worker_start", "local", worker_started);
                    source = Box::new(local_source);
                    buffering = Some(status.buffering.clone());
                    local = Some(control);
                } else {
                    let helper_started = Instant::now();
                    let ffmpeg = ensure_ffmpeg(&bin_dir).map_err(|error| {
                        format!("Could not prepare local audio with the native decoder and the managed decoder is unavailable: {error}")
                    })?;
                    log_startup_timing("ffmpeg_ready", "local", helper_started);
                    let decoder_started = Instant::now();
                    let (remote_source, control, status) =
                        open_decoder_input(&ffmpeg, path.as_os_str(), position, spec.duration_sec)?;
                    log_startup_timing("decoder_start", "local_ffmpeg", decoder_started);
                    duration_sec = valid_duration(spec.duration_sec).or(decoder_duration);
                    source = Box::new(remote_source);
                    buffering = Some(status.buffering.clone());
                    remote = Some(control);
                }
            }
            Err(decode_error) => {
                let helper_started = Instant::now();
                let ffmpeg = ensure_ffmpeg(&bin_dir).map_err(|error| {
                    format!(
                        "Could not decode '{}' ({decode_error}); the managed decoder is unavailable: {error}",
                        path.display()
                    )
                })?;
                log_startup_timing("ffmpeg_ready", "local", helper_started);
                let decoder_started = Instant::now();
                let (remote_source, control, status) =
                    open_decoder_input(&ffmpeg, path.as_os_str(), position, spec.duration_sec)?;
                log_startup_timing("decoder_start", "local_ffmpeg", decoder_started);
                duration_sec = valid_duration(spec.duration_sec);
                source = Box::new(remote_source);
                buffering = Some(status.buffering.clone());
                remote = Some(control);
            }
        }
    }

    let source_rate = source.sample_rate().get();
    let source_channels = source.channels().get();
    if source_rate == 0 || source_channels == 0 {
        return Err("Audio source reported an invalid sample format".into());
    }
    let source_kind = if remote.is_some() { "ffmpeg" } else { "local" };
    log_startup_timing("input_prepare_total", source_kind, prepare_started);
    let clock = Arc::new(PositionClock::new(position, source_rate, source_channels));
    Ok(PreparedAudio {
        spec,
        settings,
        source: Some(source),
        clock,
        duration_sec,
        bin_dir,
        remote,
        local,
        buffering,
    })
}

fn valid_duration(duration: Option<f64>) -> Option<f64> {
    duration.filter(|value| value.is_finite() && *value > 0.0)
}

fn remote_url(location: &str) -> Result<Option<String>, String> {
    if !location.contains("://") {
        return Ok(None);
    }
    let parsed = reqwest::Url::parse(location).map_err(|_| "Invalid audio URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => Ok(Some(parsed.to_string())),
        _ => Err("Audio streams must use an HTTP or HTTPS URL".into()),
    }
}

fn ffmpeg_mutex() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FfmpegSignature {
    byte_len: u64,
    modified: SystemTime,
}

fn ffmpeg_validation_cache() -> &'static Mutex<HashMap<PathBuf, FfmpegSignature>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, FfmpegSignature>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ffmpeg_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

pub(super) fn ensure_ffmpeg(bin_dir: &Path) -> Result<PathBuf, String> {
    let _guard = ffmpeg_mutex()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let install_dir = bin_dir.join("audio");
    fs::create_dir_all(&install_dir)
        .map_err(|error| format!("Could not create audio helper directory: {error}"))?;
    let final_path = install_dir.join(ffmpeg_name());
    let validation_started = Instant::now();
    let already_installed = is_usable_ffmpeg(&final_path);
    log_startup_timing("ffmpeg_existing_validation", "helper", validation_started);
    if already_installed {
        return Ok(final_path);
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let stage = install_dir.join(format!(".ffmpeg-stage-{}-{nonce}", std::process::id()));
    let download_dir = stage.join("download");
    let extract_dir = stage.join("extract");
    fs::create_dir_all(&download_dir)
        .and_then(|()| fs::create_dir_all(&extract_dir))
        .map_err(|error| format!("Could not create FFmpeg staging directory: {error}"))?;

    let install_started = Instant::now();
    let install = (|| {
        let url = ffmpeg_sidecar::download::ffmpeg_download_url().map_err(|error| {
            format!("No FFmpeg download is available for this platform: {error}")
        })?;
        let archive = ffmpeg_sidecar::download::download_ffmpeg_package(url, &download_dir)
            .map_err(|error| format!("Could not download the managed FFmpeg helper: {error}"))?;
        ffmpeg_sidecar::download::unpack_ffmpeg_without_extras(&archive, &extract_dir)
            .map_err(|error| format!("Could not unpack the managed FFmpeg helper: {error}"))?;
        let unpacked = find_ffmpeg(&extract_dir)
            .ok_or_else(|| "The FFmpeg package did not contain an executable".to_string())?;
        let part_path = install_dir.join(format!("{}.part", ffmpeg_name()));
        if part_path.exists() {
            fs::remove_file(&part_path).map_err(|error| {
                format!("Could not remove an incomplete FFmpeg helper: {error}")
            })?;
        }
        fs::copy(&unpacked, &part_path)
            .map_err(|error| format!("Could not stage the FFmpeg helper: {error}"))?;
        copy_permissions(&unpacked, &part_path)?;
        if !is_usable_ffmpeg(&part_path) {
            let _ = fs::remove_file(&part_path);
            return Err("The downloaded FFmpeg helper did not pass its version check".into());
        }
        if final_path.exists() {
            fs::remove_file(&final_path)
                .map_err(|error| format!("Could not replace an invalid FFmpeg helper: {error}"))?;
        }
        fs::rename(&part_path, &final_path)
            .map_err(|error| format!("Could not install the FFmpeg helper: {error}"))?;
        if !is_usable_ffmpeg(&final_path) {
            let _ = fs::remove_file(&final_path);
            return Err("The installed FFmpeg helper did not pass its version check".into());
        }
        Ok(final_path.clone())
    })();
    let _ = fs::remove_dir_all(&stage);
    log_startup_timing("ffmpeg_install", "helper", install_started);
    install
}

fn find_ffmpeg(root: &Path) -> Option<PathBuf> {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = pending.pop() {
        let entries = fs::read_dir(directory).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy();
            if name.eq_ignore_ascii_case("ffmpeg") || name.eq_ignore_ascii_case("ffmpeg.exe") {
                if path.is_file() {
                    return Some(path);
                }
            } else if depth < 4 && path.is_dir() {
                pending.push((path, depth + 1));
            }
        }
    }
    None
}

#[cfg(unix)]
fn copy_permissions(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(source)
        .map_err(|error| format!("Could not read FFmpeg permissions: {error}"))?
        .permissions()
        .mode();
    fs::set_permissions(destination, fs::Permissions::from_mode(mode))
        .map_err(|error| format!("Could not set FFmpeg permissions: {error}"))
}

#[cfg(not(unix))]
fn copy_permissions(_source: &Path, _destination: &Path) -> Result<(), String> {
    Ok(())
}

fn is_usable_ffmpeg(path: &Path) -> bool {
    let cacheable = path
        .file_name()
        .is_some_and(|name| name == OsStr::new(ffmpeg_name()));
    let Ok(metadata) = fs::metadata(path) else {
        if cacheable {
            ffmpeg_validation_cache()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(path);
        }
        return false;
    };
    if !metadata.is_file() {
        if cacheable {
            ffmpeg_validation_cache()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(path);
        }
        return false;
    }
    let signature = metadata.modified().ok().map(|modified| FfmpegSignature {
        byte_len: metadata.len(),
        modified,
    });
    if cacheable {
        let mut cache = ffmpeg_validation_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if signature.is_some_and(|signature| cache.get(path) == Some(&signature)) {
            return true;
        }
        cache.remove(path);
    }
    let mut command = Command::new(path);
    command.args(["-version", "-hide_banner"]);
    crate::child::quiet(&mut command);
    let Ok(mut child) = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(8);
    let usable = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(40)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    if cacheable {
        let mut cache = ffmpeg_validation_cache()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if usable {
            if let Some(signature) = signature {
                cache.insert(path.to_path_buf(), signature);
            }
        } else {
            cache.remove(path);
        }
    }
    usable
}

fn open_decoder_input(
    ffmpeg: &Path,
    input: &OsStr,
    position: f64,
    duration_sec: Option<f64>,
) -> Result<(RemoteSource, RemoteControl, Arc<RemoteStatus>), String> {
    let (producer, consumer) =
        RingBuffer::<[f32; 2]>::new(REMOTE_SAMPLE_RATE as usize * REMOTE_RING_SECONDS);
    let status = Arc::new(RemoteStatus::default());
    status.buffering.store(true, Ordering::Release);
    let state = Arc::new(RemoteState {
        cancelled: AtomicBool::new(false),
        child: Mutex::new(None),
        status: status.clone(),
        stderr_tail: Mutex::new(VecDeque::with_capacity(FFMPEG_STDERR_LIMIT)),
    });

    let mut command = Command::new(ffmpeg);
    // Bound protocol reads so a silent network stall eventually exits FFmpeg
    // and is surfaced through RemoteStatus instead of buffering indefinitely.
    command.args([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-rw_timeout",
        REMOTE_READ_TIMEOUT_MICROS,
    ]);
    if position > 0.0 {
        command.args(["-ss", &format!("{position:.3}")]);
    }
    command.arg("-i").arg(input);
    command.args([
        "-vn",
        "-sn",
        "-dn",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ar",
        &REMOTE_SAMPLE_RATE.to_string(),
        "-ac",
        "2",
        "-flush_packets",
        "1",
        "pipe:1",
    ]);
    crate::child::quiet(&mut command);
    let spawn_started = Instant::now();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the audio stream decoder: {error}"))?;
    log_startup_timing("ffmpeg_spawn", "helper", spawn_started);
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("FFmpeg did not provide an audio output pipe".into());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("FFmpeg did not provide an error output pipe".into());
    };
    *state
        .child
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(child);

    let stderr_state = state.clone();
    let stderr_worker = thread::Builder::new()
        .name("tempo-ffmpeg-stderr".into())
        .spawn(move || drain_stderr(stderr, stderr_state))
        .map_err(|error| {
            terminate_child(&state);
            format!("Could not monitor the audio stream decoder: {error}")
        })?;

    let stderr_worker = Arc::new(Mutex::new(Some(stderr_worker)));
    let worker_stderr = stderr_worker.clone();

    let worker_state = state.clone();
    let worker = match thread::Builder::new()
        .name("tempo-remote-audio".into())
        .spawn(move || {
            let stderr_worker = worker_stderr
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            pump_remote(
                BufReader::with_capacity(64 * 1024, stdout),
                producer,
                worker_state,
                stderr_worker,
            );
        }) {
        Ok(worker) => worker,
        Err(error) => {
            terminate_child(&state);
            if let Some(stderr_worker) = stderr_worker
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                let _ = stderr_worker.join();
            }
            return Err(format!("Could not start the remote audio reader: {error}"));
        }
    };

    let source = RemoteSource {
        consumer,
        status: status.clone(),
        sample_rate: rodio::nz!(48000),
        channels: rodio::nz!(2),
        duration: valid_duration(duration_sec).map(|duration| (duration - position).max(0.0)),
        channel: 0,
        frame: [0.0; 2],
    };
    let control = RemoteControl {
        state,
        worker: Mutex::new(Some(worker)),
    };
    Ok((source, control, status))
}

struct LocalFrame {
    generation: u64,
    samples: [f32; 2],
}

struct LocalState {
    cancelled: AtomicBool,
    generation: AtomicU64,
    seek_target_bits: AtomicU64,
    status: Arc<RemoteStatus>,
}

struct LocalSource {
    consumer: Consumer<LocalFrame>,
    state: Arc<LocalState>,
    sample_rate: rodio::SampleRate,
    channels: rodio::ChannelCount,
    duration: Option<Duration>,
    channel: usize,
    frame: [f32; 2],
}

pub(super) struct LocalControl {
    state: Arc<LocalState>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl LocalControl {
    pub fn status(&self) -> Arc<RemoteStatus> {
        self.state.status.clone()
    }

    pub fn stop(&mut self) {
        self.state.cancelled.store(true, Ordering::Release);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = worker.join();
        }
    }
}

impl Drop for LocalControl {
    fn drop(&mut self) {
        self.stop();
    }
}

fn open_local_buffered<D>(
    decoder: D,
    position: f64,
) -> Result<(LocalSource, LocalControl, Arc<RemoteStatus>), String>
where
    D: Source<Item = f32> + Send + 'static,
{
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();
    let duration = decoder.total_duration();
    let (producer, consumer) = RingBuffer::<LocalFrame>::new(LOCAL_RING_FRAMES);
    let status = Arc::new(RemoteStatus::default());
    status.buffering.store(true, Ordering::Release);
    let state = Arc::new(LocalState {
        cancelled: AtomicBool::new(false),
        generation: AtomicU64::new(0),
        seek_target_bits: AtomicU64::new(position.to_bits()),
        status: status.clone(),
    });
    let worker_state = state.clone();
    let worker = thread::Builder::new()
        .name("tempo-local-audio".into())
        .spawn(move || pump_local(decoder, producer, worker_state))
        .map_err(|error| format!("Could not start the local audio decoder: {error}"))?;
    let source = LocalSource {
        consumer,
        state: state.clone(),
        sample_rate,
        channels,
        duration,
        channel: 0,
        frame: [0.0; 2],
    };
    let control = LocalControl {
        state,
        worker: Mutex::new(Some(worker)),
    };
    Ok((source, control, status))
}

fn pump_local<D>(mut decoder: D, mut producer: Producer<LocalFrame>, state: Arc<LocalState>)
where
    D: Source<Item = f32> + Send + 'static,
{
    let worker_started = Instant::now();
    let mut first_frame_logged = false;
    let channels = decoder.channels().get() as usize;
    let mut generation = state.generation.load(Ordering::Acquire);
    loop {
        if state.cancelled.load(Ordering::Acquire) || producer.is_abandoned() {
            break;
        }
        let requested_generation = state.generation.load(Ordering::Acquire);
        if requested_generation != generation {
            let position = f64::from_bits(state.seek_target_bits.load(Ordering::Acquire));
            let result = if position.is_finite() && position >= 0.0 {
                decoder.try_seek(Duration::from_secs_f64(position))
            } else {
                Err(SeekError::NotSupported {
                    underlying_source: "the requested local seek position is invalid",
                })
            };
            generation = requested_generation;
            match result {
                Ok(()) => {
                    state.status.done.store(false, Ordering::Release);
                    state.status.clear_error();
                    state.status.buffering.store(true, Ordering::Release);
                }
                Err(error) => {
                    state
                        .status
                        .set_error(format!("Could not seek local audio: {error}"));
                    state.status.done.store(true, Ordering::Release);
                    state.status.buffering.store(true, Ordering::Release);
                    continue;
                }
            }
        }
        if state.status.done.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(3));
            continue;
        }

        let mut frame = [0.0f32; 2];
        let mut complete = true;
        for channel in 0..channels {
            match decoder.next() {
                Some(sample) if channel == 0 => frame[0] = sample,
                Some(sample) if channel == 1 => frame[1] = sample,
                Some(_) => {}
                None => {
                    complete = false;
                    break;
                }
            }
        }
        if !complete {
            state.status.done.store(true, Ordering::Release);
            continue;
        }
        if state.generation.load(Ordering::Acquire) != generation {
            continue;
        }

        let mut pending = LocalFrame {
            generation,
            samples: frame,
        };
        loop {
            if state.cancelled.load(Ordering::Acquire) || producer.is_abandoned() {
                return;
            }
            if state.generation.load(Ordering::Acquire) != generation {
                break;
            }
            match producer.push(pending) {
                Ok(()) => {
                    if !first_frame_logged {
                        log_startup_timing("local_first_frame", "local", worker_started);
                        first_frame_logged = true;
                    }
                    break;
                }
                Err(rtrb::PushError::Full(frame)) => {
                    pending = frame;
                    thread::sleep(Duration::from_millis(2));
                }
            }
        }
    }
}

impl Iterator for LocalSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.channel == 0 {
            let generation = self.state.generation.load(Ordering::Acquire);
            let mut current = None;
            for _ in 0..8 {
                match self.consumer.pop() {
                    Ok(frame) if frame.generation == generation => {
                        current = Some(frame.samples);
                        break;
                    }
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            if let Some(frame) = current {
                self.frame = frame;
                self.state.status.buffering.store(false, Ordering::Release);
            } else if self.state.status.done.load(Ordering::Acquire) {
                return None;
            } else {
                self.frame = [0.0; 2];
                self.state.status.buffering.store(true, Ordering::Release);
            }
        }
        let sample = self.frame[self.channel];
        self.channel = (self.channel + 1) % self.channels.get() as usize;
        Some(sample)
    }
}

impl Source for LocalSource {
    fn current_span_len(&self) -> Option<usize> {
        Some(2048)
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.duration
    }
    fn try_seek(&mut self, position: Duration) -> Result<(), SeekError> {
        self.state
            .seek_target_bits
            .store(position.as_secs_f64().to_bits(), Ordering::Release);
        self.state.status.done.store(false, Ordering::Release);
        self.state.status.clear_error();
        self.state.status.buffering.store(true, Ordering::Release);
        self.state.generation.fetch_add(1, Ordering::AcqRel);
        self.channel = 0;
        for _ in 0..LOCAL_RING_FRAMES {
            if self.consumer.pop().is_err() {
                break;
            }
        }
        Ok(())
    }
}

fn drain_stderr(mut stderr: std::process::ChildStderr, state: Arc<RemoteState>) {
    let mut buffer = [0u8; 1024];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let mut tail = state
                    .stderr_tail
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                for &byte in &buffer[..read] {
                    if tail.len() == FFMPEG_STDERR_LIMIT {
                        tail.pop_front();
                    }
                    tail.push_back(byte);
                }
            }
        }
    }
}

fn pump_remote(
    mut stdout: BufReader<std::process::ChildStdout>,
    mut producer: Producer<[f32; 2]>,
    state: Arc<RemoteState>,
    stderr_worker: Option<JoinHandle<()>>,
) {
    let worker_started = Instant::now();
    let mut first_frame_logged = false;
    let mut bytes = [0u8; 8];
    let mut read_error = None;
    'reader: loop {
        if state.cancelled.load(Ordering::Acquire) {
            break;
        }
        match stdout.read_exact(&mut bytes) {
            Ok(()) => {
                let frame = [
                    f32::from_le_bytes(bytes[..4].try_into().unwrap_or([0; 4])),
                    f32::from_le_bytes(bytes[4..].try_into().unwrap_or([0; 4])),
                ];
                let mut pending = frame;
                loop {
                    if state.cancelled.load(Ordering::Acquire) || producer.is_abandoned() {
                        break 'reader;
                    }
                    match producer.push(pending) {
                        Ok(()) => {
                            if !first_frame_logged {
                                log_startup_timing("remote_first_frame", "ffmpeg", worker_started);
                                first_frame_logged = true;
                            }
                            break;
                        }
                        Err(rtrb::PushError::Full(frame)) => {
                            pending = frame;
                            thread::sleep(Duration::from_millis(2));
                        }
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(error) => {
                read_error = Some(error.to_string());
                break;
            }
        }
    }

    let intentional_stop = state.cancelled.load(Ordering::Acquire) || producer.is_abandoned();
    if intentional_stop || read_error.is_some() {
        state.cancelled.store(true, Ordering::Release);
        kill_remote_child(&state);
    }
    drop(stdout);
    let status = wait_remote_child(&state);
    if let Some(stderr_worker) = stderr_worker {
        let _ = stderr_worker.join();
    }
    if !intentional_stop {
        if let Some(error) = read_error {
            state
                .status
                .set_error(format!("Audio stream read failed: {error}"));
        } else if status.is_some_and(|status| !status.success()) {
            let detail = state.stderr_text();
            state.status.set_error(if detail.is_empty() {
                "The audio stream decoder stopped unexpectedly".into()
            } else {
                detail
            });
        }
    }
    state.status.done.store(true, Ordering::Release);
}

fn terminate_child(state: &RemoteState) {
    state.cancelled.store(true, Ordering::Release);
    kill_remote_child(state);
    let mut child = state
        .child
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(child) = child.as_mut() {
        let _ = child.wait();
    }
}

fn kill_remote_child(state: &RemoteState) {
    let mut child = state
        .child
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(child) = child.as_mut() {
        let _ = child.kill();
    }
}

/// Polls without holding the child mutex across a blocking wait. `stop()` can
/// therefore always acquire the mutex and kill a helper that is still reading
/// from a network stream or blocked behind a full output queue.
fn wait_remote_child(state: &RemoteState) -> Option<ExitStatus> {
    loop {
        let still_running = {
            let mut slot = state
                .child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.cancelled.load(Ordering::Acquire) {
                if let Some(child) = slot.as_mut() {
                    let _ = child.kill();
                }
            }
            match slot.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        slot.take();
                        return Some(status);
                    }
                    Ok(None) => true,
                    Err(_) => {
                        let mut child = slot.take();
                        drop(slot);
                        if let Some(child) = child.as_mut() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        return None;
                    }
                },
                None => return None,
            }
        };
        if still_running {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[derive(Default)]
pub(super) struct RemoteStatus {
    pub buffering: Arc<AtomicBool>,
    pub done: AtomicBool,
    pub error: Mutex<Option<String>>,
}

impl RemoteStatus {
    fn set_error(&self, error: String) {
        *self
            .error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
    }

    fn clear_error(&self) {
        self.error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }

    pub fn error(&self) -> Option<String> {
        self.error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

struct RemoteState {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
    status: Arc<RemoteStatus>,
    stderr_tail: Mutex<VecDeque<u8>>,
}

impl RemoteState {
    fn stderr_text(&self) -> String {
        String::from_utf8_lossy(
            &self
                .stderr_tail
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .copied()
                .collect::<Vec<_>>(),
        )
        .trim()
        .to_string()
    }
}

pub(super) struct RemoteControl {
    state: Arc<RemoteState>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl RemoteControl {
    pub fn status(&self) -> Arc<RemoteStatus> {
        self.state.status.clone()
    }

    pub fn stop(&mut self) {
        self.state.cancelled.store(true, Ordering::Release);
        kill_remote_child(&self.state);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = worker.join();
        }
    }
}

impl Drop for RemoteControl {
    fn drop(&mut self) {
        self.stop();
    }
}

struct RemoteSource {
    consumer: Consumer<[f32; 2]>,
    status: Arc<RemoteStatus>,
    sample_rate: rodio::SampleRate,
    channels: rodio::ChannelCount,
    duration: Option<f64>,
    channel: usize,
    frame: [f32; 2],
}

impl Iterator for RemoteSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.channel == 0 {
            match self.consumer.pop() {
                Ok(frame) => {
                    self.frame = frame;
                    self.status.buffering.store(false, Ordering::Release);
                }
                Err(_) if self.status.done.load(Ordering::Acquire) => return None,
                Err(_) => {
                    self.frame = [0.0; 2];
                    self.status.buffering.store(true, Ordering::Release);
                }
            }
        }
        let sample = self.frame[self.channel];
        self.channel = (self.channel + 1) % 2;
        Some(sample)
    }
}

impl Source for RemoteSource {
    fn current_span_len(&self) -> Option<usize> {
        Some(2048)
    }

    fn channels(&self) -> rodio::ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> rodio::SampleRate {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.duration.map(Duration::from_secs_f64)
    }

    fn try_seek(&mut self, _pos: Duration) -> Result<(), SeekError> {
        Err(SeekError::NotSupported {
            underlying_source: "remote audio streams cannot be sought in place".into(),
        })
    }
}

pub(super) struct PositionClock {
    base_bits: AtomicU64,
    frames: AtomicU64,
    seek_target_bits: AtomicU64,
    seek_generation: AtomicU64,
    handled_seek_generation: AtomicU64,
    failed_seek_generation: AtomicU64,
    sample_rate: u32,
    channels: u16,
}

impl PositionClock {
    fn new(position: f64, sample_rate: u32, channels: u16) -> Self {
        Self {
            base_bits: AtomicU64::new(position.to_bits()),
            frames: AtomicU64::new(0),
            seek_target_bits: AtomicU64::new(position.to_bits()),
            seek_generation: AtomicU64::new(0),
            handled_seek_generation: AtomicU64::new(0),
            failed_seek_generation: AtomicU64::new(0),
            sample_rate,
            channels,
        }
    }

    pub fn position(&self) -> f64 {
        let requested = self.seek_generation.load(Ordering::Acquire);
        let handled = self.handled_seek_generation.load(Ordering::Acquire);
        if requested != handled {
            return f64::from_bits(self.seek_target_bits.load(Ordering::Acquire));
        }
        f64::from_bits(self.base_bits.load(Ordering::Acquire))
            + self.frames.load(Ordering::Acquire) as f64 / self.sample_rate as f64
    }

    pub fn request_seek(&self, position: f64) {
        self.seek_target_bits
            .store(position.max(0.0).to_bits(), Ordering::Release);
        self.seek_generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn take_seek_failure(&self) -> bool {
        let failed = self.failed_seek_generation.swap(0, Ordering::AcqRel);
        failed != 0
    }

    pub fn set_position(&self, position: f64) {
        self.frames.store(0, Ordering::Release);
        self.base_bits
            .store(position.max(0.0).to_bits(), Ordering::Release);
    }
}

pub(super) struct ClockSource {
    source: AudioSource,
    clock: Arc<PositionClock>,
    buffering: Option<Arc<AtomicBool>>,
    channel: u16,
    frame_valid: bool,
    handled_seek_generation: u64,
}

impl ClockSource {
    pub fn new(
        source: AudioSource,
        clock: Arc<PositionClock>,
        buffering: Option<Arc<AtomicBool>>,
    ) -> Self {
        Self {
            source,
            clock,
            buffering,
            channel: 0,
            frame_valid: true,
            handled_seek_generation: 0,
        }
    }

    fn apply_pending_seek(&mut self) {
        let requested = self.clock.seek_generation.load(Ordering::Acquire);
        if requested == self.handled_seek_generation {
            return;
        }
        let target_bits = self.clock.seek_target_bits.load(Ordering::Acquire);
        // A newer request may arrive between reading the generation and target.
        // Leave it for the next frame rather than applying a mismatched pair.
        if self.clock.seek_generation.load(Ordering::Acquire) != requested {
            return;
        }
        let target = f64::from_bits(target_bits);
        match self.source.try_seek(Duration::from_secs_f64(target)) {
            Ok(()) => {
                self.clock.set_position(target);
                self.clock
                    .failed_seek_generation
                    .store(0, Ordering::Release);
            }
            Err(_) => {
                self.clock
                    .failed_seek_generation
                    .store(requested, Ordering::Release);
            }
        }
        self.clock
            .handled_seek_generation
            .store(requested, Ordering::Release);
        self.handled_seek_generation = requested;
        self.channel = 0;
        self.frame_valid = true;
    }
}

impl Iterator for ClockSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.channel == 0 {
            self.apply_pending_seek();
        }
        let sample = self.source.next()?;
        let valid_sample = self
            .buffering
            .as_ref()
            .is_none_or(|buffering| !buffering.load(Ordering::Acquire));
        self.frame_valid &= valid_sample;
        self.channel += 1;
        if self.channel >= self.clock.channels {
            if self.frame_valid {
                self.clock.frames.fetch_add(1, Ordering::AcqRel);
            }
            self.channel = 0;
            self.frame_valid = true;
        }
        Some(sample)
    }
}

impl Source for ClockSource {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }

    fn channels(&self) -> rodio::ChannelCount {
        self.source.channels()
    }

    fn sample_rate(&self) -> rodio::SampleRate {
        self.source.sample_rate()
    }

    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }

    fn try_seek(&mut self, position: Duration) -> Result<(), SeekError> {
        self.source.try_seek(position)?;
        self.clock.set_position(position.as_secs_f64());
        self.channel = 0;
        self.frame_valid = true;
        Ok(())
    }
}
