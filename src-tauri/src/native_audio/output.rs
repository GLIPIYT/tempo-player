//! Native audio output and source preparation for desktop playback.
//!
//! Local files stay file-backed. Remote sources are decoded by a managed FFmpeg
//! child into an eight-second bounded frame queue; the rodio source only polls
//! that queue and emits silence during underflow, so it never waits for network IO.

mod dsp;
mod input;
mod pitch;
mod spectrum;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use rodio::{DeviceSinkBuilder, MixerDeviceSink, Player};

use self::dsp::{process_source, EffectControls};
use self::input::{LocalControl, PositionClock, RemoteControl, RemoteStatus};
use self::spectrum::SpectrumBuffer;

pub use self::input::PreparedAudio;

const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(500);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(10);
const STALL_AFTER: Duration = Duration::from_secs(2);

fn log_startup_timing(stage: &str, source: &str, started: Instant) {
    #[cfg(debug_assertions)]
    eprintln!(
        "[tempo startup] stage={stage} source={source} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    #[cfg(not(debug_assertions))]
    let _ = (stage, source, started);
}

#[derive(Clone, Debug)]
pub struct OutputSettings {
    pub volume: f32,
    pub playback_rate: f32,
    pub preserve_pitch: bool,
    pub equalizer_enabled: bool,
    pub equalizer_gains: [f64; 10],
}

impl Default for OutputSettings {
    fn default() -> Self {
        Self {
            volume: 0.8,
            playback_rate: 1.0,
            preserve_pitch: false,
            equalizer_enabled: false,
            equalizer_gains: [0.0; 10],
        }
    }
}

impl OutputSettings {
    fn sanitized(mut self) -> Self {
        self.volume = if self.volume.is_finite() {
            self.volume.clamp(0.0, 1.0)
        } else {
            0.8
        };
        self.playback_rate = if self.playback_rate.is_finite() {
            self.playback_rate.clamp(0.5, 2.0)
        } else {
            1.0
        };
        for gain in &mut self.equalizer_gains {
            *gain = if gain.is_finite() {
                gain.clamp(-18.0, 18.0)
            } else {
                0.0
            };
        }
        self
    }
}

#[derive(Clone, Debug)]
pub struct SourceSpec {
    pub location: String,
    pub duration_sec: Option<f64>,
    pub gain_db: f64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisFrame {
    pub frequency_bins: Vec<u8>,
    pub sample_rate: u32,
    pub min_decibels: f32,
    pub max_decibels: f32,
}

/// Opens local files directly or starts a bounded remote decoder off the actor.
/// The returned source owns any helper process and cancels it when dropped.
pub fn prepare(
    spec: SourceSpec,
    position: f64,
    settings: OutputSettings,
    bin_dir: PathBuf,
) -> Result<PreparedAudio, String> {
    input::prepare_input(spec, position, settings.sanitized(), bin_dir)
}

/// Ensures the managed FFmpeg helper is installed and usable for cache remuxing.
pub(crate) fn ensure_decoder_helper(bin_dir: &std::path::Path) -> Result<PathBuf, String> {
    input::ensure_ffmpeg(bin_dir)
}

pub struct OutputEngine {
    sink: Option<MixerDeviceSink>,
    device_error: Arc<AtomicBool>,
    reconnect_at: Option<Instant>,
    reconnect_delay: Duration,
    active: Option<ActiveTrack>,
    outgoing: Vec<ActiveTrack>,
    pending: Option<PendingInstall>,
    recovery: Option<Recovery>,
    settings: OutputSettings,
    settings_configured: bool,
    track_gain_db: f64,
    spectrum: Arc<SpectrumBuffer>,
    last_error: Option<String>,
}

struct ActiveTrack {
    spec: SourceSpec,
    bin_dir: PathBuf,
    duration_sec: Option<f64>,
    clock: Arc<PositionClock>,
    controls: Arc<EffectControls>,
    player: Option<Player>,
    remote: Option<RemoteControl>,
    local: Option<LocalControl>,
    buffering: Option<Arc<AtomicBool>>,
    requested_playing: bool,
    fade: Option<Fade>,
    last_progress_position: f64,
    last_progress_at: Instant,
    startup_started: Instant,
    startup_reported: bool,
    error_reported: bool,
}

struct PendingInstall {
    audio: PreparedAudio,
    playing: bool,
    fade_sec: f64,
}

struct RecoveryRequest {
    spec: SourceSpec,
    position: f64,
    settings: OutputSettings,
    bin_dir: PathBuf,
    playing: bool,
}

struct Recovery {
    request: RecoveryRequest,
    receiver: Receiver<Result<PreparedAudio, String>>,
}

struct Fade {
    started: Instant,
    duration: Duration,
    from: f32,
    to: f32,
    paused_at: Option<Instant>,
    paused_total: Duration,
}

impl Fade {
    fn value(&self, now: Instant) -> (f32, bool) {
        let elapsed = self
            .paused_at
            .unwrap_or(now)
            .saturating_duration_since(self.started)
            .saturating_sub(self.paused_total);
        let elapsed = elapsed.as_secs_f32();
        let length = self.duration.as_secs_f32().max(f32::EPSILON);
        let amount = (elapsed / length).clamp(0.0, 1.0);
        (self.from + (self.to - self.from) * amount, amount >= 1.0)
    }

    fn pause(&mut self, now: Instant) {
        self.paused_at.get_or_insert(now);
    }

    fn resume(&mut self, now: Instant) {
        if let Some(paused_at) = self.paused_at.take() {
            self.paused_total += now.saturating_duration_since(paused_at);
        }
    }
}

impl ActiveTrack {
    fn position(&self) -> f64 {
        self.clock.position()
    }

    fn is_buffering(&self) -> bool {
        self.buffering
            .as_ref()
            .is_some_and(|buffering| buffering.load(Ordering::Acquire))
    }

    fn shutdown(&mut self) {
        if let Some(player) = self.player.take() {
            player.stop();
        }
        if let Some(remote) = self.remote.as_mut() {
            remote.stop();
        }
        if let Some(local) = self.local.as_mut() {
            local.stop();
        }
        self.remote.take();
    }
}

impl Drop for ActiveTrack {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl OutputEngine {
    /// Creates a native output owner. If no device is available yet, the engine
    /// remains alive and retries in the background through `tick`.
    pub fn new() -> Result<Self, String> {
        let device_error = Arc::new(AtomicBool::new(false));
        let device_started = Instant::now();
        let sink = open_device(device_error.clone()).ok();
        log_startup_timing("output_device_open", "device", device_started);
        let reconnect_at = sink
            .is_none()
            .then(|| Instant::now() + INITIAL_RECONNECT_DELAY);
        Ok(Self {
            sink,
            device_error,
            reconnect_at,
            reconnect_delay: INITIAL_RECONNECT_DELAY,
            active: None,
            outgoing: Vec::new(),
            pending: None,
            recovery: None,
            settings: OutputSettings::default(),
            settings_configured: false,
            track_gain_db: 0.0,
            spectrum: SpectrumBuffer::new(),
            last_error: None,
        })
    }

    pub fn install(
        &mut self,
        audio: PreparedAudio,
        playing: bool,
        fade_sec: f64,
    ) -> Result<(), String> {
        self.recovery.take();
        self.pending.take();
        self.track_gain_db = if audio.spec.gain_db.is_finite() {
            audio.spec.gain_db.clamp(-36.0, 36.0)
        } else {
            0.0
        };
        if !self.settings_configured {
            self.settings = audio.settings.clone().sanitized();
        }
        self.stop_outgoing();

        let fade = fade_sec.is_finite() && fade_sec > 0.0 && playing;
        if let Some(mut old) = self.active.take() {
            if fade && old.requested_playing && old.player.is_some() {
                let start_volume = old.player.as_ref().map(Player::volume).unwrap_or(0.0);
                old.fade = Some(Fade {
                    started: Instant::now(),
                    duration: Duration::from_secs_f64(fade_sec.clamp(0.0, 30.0)),
                    from: start_volume,
                    to: 0.0,
                    paused_at: None,
                    paused_total: Duration::ZERO,
                });
                self.outgoing.push(old);
            } else {
                old.shutdown();
            }
        }

        if self.sink.is_none() {
            self.pending = Some(PendingInstall {
                audio,
                playing,
                fade_sec: 0.0,
            });
            self.reconnect_at
                .get_or_insert(Instant::now() + self.reconnect_delay);
            return Ok(());
        }
        self.attach(audio, playing, if fade { fade_sec } else { 0.0 })
    }

    fn attach(
        &mut self,
        mut audio: PreparedAudio,
        playing: bool,
        fade_sec: f64,
    ) -> Result<(), String> {
        let attach_started = Instant::now();
        let source_kind = if audio.remote.is_some() {
            "ffmpeg"
        } else {
            "local"
        };
        let Some(sink) = self.sink.as_ref() else {
            self.pending = Some(PendingInstall {
                audio,
                playing,
                fade_sec: 0.0,
            });
            log_startup_timing("output_attach_deferred", source_kind, attach_started);
            return Ok(());
        };
        let source = audio
            .source
            .take()
            .ok_or_else(|| "Prepared audio source was already consumed".to_string())?;
        let controls = EffectControls::new(self.track_gain_db, source.sample_rate());
        controls.configure(&self.settings);
        let player = Player::connect_new(sink.mixer());
        player.set_speed(self.settings.playback_rate.clamp(0.5, 2.0));
        let fade_in = playing && fade_sec.is_finite() && fade_sec > 0.0;
        let target_volume = self.settings.volume.clamp(0.0, 1.0);
        player.set_volume(if fade_in { 0.0 } else { target_volume });
        let source = process_source(source, controls.clone(), self.spectrum.clone());
        let source = input::ClockSource::new(source, audio.clock.clone(), audio.buffering.clone());
        player.append(source);
        if playing {
            player.play();
        } else {
            player.pause();
        }
        let now = Instant::now();
        self.active = Some(ActiveTrack {
            spec: audio.spec.clone(),
            bin_dir: audio.bin_dir.clone(),
            duration_sec: audio.duration_sec,
            clock: audio.clock.clone(),
            controls,
            player: Some(player),
            remote: audio.remote.take(),
            local: audio.local.take(),
            buffering: audio.buffering.clone(),
            requested_playing: playing,
            fade: fade_in.then(|| Fade {
                started: now,
                duration: Duration::from_secs_f64(fade_sec.clamp(0.0, 30.0)),
                from: 0.0,
                to: target_volume,
                paused_at: None,
                paused_total: Duration::ZERO,
            }),
            last_progress_position: audio.clock.position(),
            last_progress_at: now,
            startup_started: attach_started,
            startup_reported: false,
            error_reported: false,
        });
        audio.shutdown();
        log_startup_timing("output_attach", source_kind, attach_started);
        Ok(())
    }

    pub fn configure(&mut self, settings: OutputSettings) {
        self.settings = settings.sanitized();
        self.settings_configured = true;
        let now = Instant::now();
        if let Some(track) = self.active.as_mut() {
            track.controls.configure(&self.settings);
            if let Some(player) = track.player.as_ref() {
                player.set_speed(self.settings.playback_rate.clamp(0.5, 2.0));
                if let Some(fade) = track.fade.as_mut() {
                    if fade.to > 0.0 {
                        fade.to = self.settings.volume;
                        player.set_volume(fade.value(now).0);
                    }
                } else {
                    player.set_volume(self.settings.volume);
                }
            }
        }
        for track in &mut self.outgoing {
            track.controls.configure(&self.settings);
            if let Some(player) = track.player.as_ref() {
                player.set_speed(self.settings.playback_rate);
            }
        }
    }

    /// Attempts a source-time seek. Remote sources return an error so the queue
    /// service can prepare a generation-guarded replacement off-thread.
    pub fn seek(&mut self, position: f64) -> Result<(), String> {
        let position = if position.is_finite() {
            position.max(0.0)
        } else {
            return Err("Seek position must be finite".into());
        };
        let position = self
            .duration()
            .map_or(position, |duration| position.min(duration));
        self.seek_track(position)
    }

    fn seek_track(&mut self, position: f64) -> Result<(), String> {
        let Some(track) = self.active.as_mut() else {
            return Err("No active source to seek".into());
        };
        if track.remote.is_some() {
            return Err("Remote streams require a prepared seek replacement".into());
        }
        let player = track
            .player
            .as_ref()
            .ok_or_else(|| "Audio output is reconnecting".to_string())?;
        if player.empty() {
            return Err("The active audio source has ended".into());
        }
        // Rodio's Player::try_seek waits for the mixer callback to acknowledge
        // the request. Publish a source-time seek instead; ClockSource applies
        // it on the callback thread so a failed device callback cannot block
        // the actor's watchdog or shutdown path.
        track.clock.request_seek(position);
        track.last_progress_position = position;
        track.last_progress_at = Instant::now();
        Ok(())
    }

    /// Updates per-track loudness/normalization gain without replacing the source.
    pub fn set_track_gain(&mut self, gain_db: f64) {
        self.track_gain_db = if gain_db.is_finite() {
            gain_db.clamp(-60.0, 24.0)
        } else {
            0.0
        };
        if let Some(track) = self.active.as_ref() {
            track.controls.set_track_gain_db(self.track_gain_db);
        }
    }

    pub fn play(&mut self) {
        let now = Instant::now();
        if let Some(pending) = self.pending.as_mut() {
            pending.playing = true;
        }
        if let Some(recovery) = self.recovery.as_mut() {
            recovery.request.playing = true;
        }
        if let Some(track) = self.active.as_mut() {
            track.requested_playing = true;
            if let Some(player) = track.player.as_ref() {
                player.play();
            }
        }
        for track in &mut self.outgoing {
            if let Some(fade) = track.fade.as_mut() {
                fade.resume(now);
            }
            if let Some(player) = track.player.as_ref() {
                player.play();
            }
        }
        if let Some(fade) = self.active.as_mut().and_then(|track| track.fade.as_mut()) {
            fade.resume(now);
        }
    }

    pub fn pause(&mut self) {
        let now = Instant::now();
        if let Some(pending) = self.pending.as_mut() {
            pending.playing = false;
        }
        if let Some(recovery) = self.recovery.as_mut() {
            recovery.request.playing = false;
        }
        if let Some(track) = self.active.as_mut() {
            track.requested_playing = false;
            if let Some(player) = track.player.as_ref() {
                player.pause();
            }
        }
        for track in &mut self.outgoing {
            if let Some(fade) = track.fade.as_mut() {
                fade.pause(now);
            }
            if let Some(player) = track.player.as_ref() {
                player.pause();
            }
        }
        if let Some(fade) = self.active.as_mut().and_then(|track| track.fade.as_mut()) {
            fade.pause(now);
        }
    }

    pub fn stop(&mut self) {
        self.pending.take();
        self.recovery.take();
        if let Some(mut track) = self.active.take() {
            track.shutdown();
        }
        self.stop_outgoing();
    }

    fn stop_outgoing(&mut self) {
        for mut track in self.outgoing.drain(..) {
            track.shutdown();
        }
    }

    pub fn position(&self) -> f64 {
        self.active
            .as_ref()
            .map(ActiveTrack::position)
            .or_else(|| {
                self.pending
                    .as_ref()
                    .map(|pending| pending.audio.clock.position())
            })
            .or_else(|| {
                self.recovery
                    .as_ref()
                    .map(|recovery| recovery.request.position)
            })
            .unwrap_or(0.0)
    }

    pub fn duration(&self) -> Option<f64> {
        self.active
            .as_ref()
            .and_then(|track| track.duration_sec)
            .or_else(|| {
                self.pending
                    .as_ref()
                    .and_then(|pending| pending.audio.duration_sec)
            })
            .or_else(|| {
                self.recovery
                    .as_ref()
                    .and_then(|recovery| recovery.request.spec.duration_sec)
            })
    }

    pub fn is_playing(&self) -> bool {
        self.active
            .as_ref()
            .map(|track| {
                track.requested_playing
                    && track
                        .player
                        .as_ref()
                        .is_none_or(|player| !player.is_paused() && !player.empty())
            })
            .or_else(|| self.pending.as_ref().map(|pending| pending.playing))
            .or_else(|| {
                self.recovery
                    .as_ref()
                    .map(|recovery| recovery.request.playing)
            })
            .unwrap_or(false)
    }

    /// Returns whether a source is attached, waiting for a device, or being
    /// rebuilt after output recovery.
    pub fn has_source(&self) -> bool {
        self.active.is_some() || self.pending.is_some() || self.recovery.is_some()
    }

    pub fn ended(&self) -> bool {
        if self.pending.is_some() || self.recovery.is_some() {
            return false;
        }
        self.active
            .as_ref()
            .and_then(|track| track.player.as_ref())
            .is_some_and(Player::empty)
    }

    pub fn buffering(&self) -> bool {
        if self.sink.is_none() && self.is_playing() {
            return true;
        }
        self.active.as_ref().is_some_and(ActiveTrack::is_buffering)
            || self
                .pending
                .as_ref()
                .and_then(|pending| pending.audio.buffering.as_ref())
                .is_some_and(|buffering| buffering.load(Ordering::Acquire))
            || self.recovery.is_some()
    }

    pub fn tick(&mut self) -> Result<(), String> {
        if self.device_error.swap(false, Ordering::AcqRel) && self.sink.is_some() {
            self.lose_device();
        }
        if self.stalled() {
            self.lose_device();
        }

        self.poll_recovery()?;
        self.try_reconnect();
        self.install_pending()?;
        if let Some(track) = self.active.as_mut() {
            let started = track.requested_playing
                && !track.is_buffering()
                && track
                    .player
                    .as_ref()
                    .is_some_and(|player| !player.is_paused() && !player.empty());
            if started && !track.startup_reported {
                let source_kind = if track.remote.is_some() {
                    "ffmpeg"
                } else {
                    "local"
                };
                log_startup_timing("output_first_audio", source_kind, track.startup_started);
                track.startup_reported = true;
            }
        }
        self.advance_fades();
        self.report_input_error()
    }

    fn stalled(&mut self) -> bool {
        let Some(track) = self.active.as_mut() else {
            return false;
        };
        let Some(player) = track.player.as_ref() else {
            return false;
        };
        if !track.requested_playing || player.is_paused() || player.empty() || track.is_buffering()
        {
            track.last_progress_position = track.position();
            track.last_progress_at = Instant::now();
            return false;
        }
        let position = track.position();
        if position > track.last_progress_position + 0.01 {
            track.last_progress_position = position;
            track.last_progress_at = Instant::now();
            return false;
        }
        track.last_progress_at.elapsed() >= STALL_AFTER
    }

    fn lose_device(&mut self) {
        if let Some(mut track) = self.active.take() {
            let request = RecoveryRequest {
                spec: track.spec.clone(),
                position: track.position(),
                settings: self.settings.clone(),
                bin_dir: track.bin_dir.clone(),
                playing: track.requested_playing,
            };
            track.shutdown();
            self.start_recovery(request);
        }
        self.stop_outgoing();
        self.sink.take();
        self.reconnect_at = Some(Instant::now() + self.reconnect_delay);
        self.reconnect_delay = (self.reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
    }

    fn start_recovery(&mut self, request: RecoveryRequest) {
        let (sender, receiver) = mpsc::sync_channel(1);
        let spec = request.spec.clone();
        let settings = request.settings.clone();
        let bin_dir = request.bin_dir.clone();
        let position = request.position;
        let spawn = thread::Builder::new()
            .name("tempo-audio-recovery".into())
            .spawn(move || {
                let _ = sender.send(prepare(spec, position, settings, bin_dir));
            });
        match spawn {
            Ok(_) => self.recovery = Some(Recovery { request, receiver }),
            Err(error) => {
                self.last_error = Some(format!("Could not start audio recovery: {error}"));
            }
        }
    }

    fn poll_recovery(&mut self) -> Result<(), String> {
        let Some(recovery) = self.recovery.as_ref() else {
            return Ok(());
        };
        match recovery.receiver.try_recv() {
            Ok(Ok(audio)) => {
                let recovery = self.recovery.take().expect("recovery is present");
                self.pending = Some(PendingInstall {
                    audio,
                    playing: recovery.request.playing,
                    fade_sec: 0.0,
                });
                Ok(())
            }
            Ok(Err(error)) => {
                self.recovery.take();
                self.last_error = Some(format!(
                    "Could not restore audio after device failure: {error}"
                ));
                Ok(())
            }
            Err(TryRecvError::Empty) => Ok(()),
            Err(TryRecvError::Disconnected) => {
                self.recovery.take();
                self.last_error = Some("Audio recovery worker stopped unexpectedly".into());
                Ok(())
            }
        }
    }

    fn try_reconnect(&mut self) {
        if self.sink.is_some() || !self.reconnect_at.is_some_and(|when| Instant::now() >= when) {
            return;
        }
        let reconnect_started = Instant::now();
        match open_device(self.device_error.clone()) {
            Ok(sink) => {
                self.sink = Some(sink);
                self.reconnect_at = None;
                self.reconnect_delay = INITIAL_RECONNECT_DELAY;
                self.device_error.store(false, Ordering::Release);
                log_startup_timing("output_device_reconnect", "device", reconnect_started);
            }
            Err(_) => {
                log_startup_timing(
                    "output_device_reconnect_failed",
                    "device",
                    reconnect_started,
                );
                self.reconnect_at = Some(Instant::now() + self.reconnect_delay);
                self.reconnect_delay = (self.reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
            }
        }
    }

    fn install_pending(&mut self) -> Result<(), String> {
        if self.sink.is_none() {
            return Ok(());
        }
        if let Some(pending) = self.pending.take() {
            return self.attach(pending.audio, pending.playing, pending.fade_sec);
        }
        Ok(())
    }

    fn advance_fades(&mut self) {
        let now = Instant::now();
        if let Some(track) = self.active.as_mut() {
            if let (Some(fade), Some(player)) = (track.fade.as_ref(), track.player.as_ref()) {
                let (volume, complete) = fade.value(now);
                player.set_volume(volume);
                if complete {
                    track.fade = None;
                }
            }
        }
        for track in &mut self.outgoing {
            if let (Some(fade), Some(player)) = (track.fade.as_ref(), track.player.as_ref()) {
                let (volume, complete) = fade.value(now);
                player.set_volume(volume);
                if complete {
                    track.fade = None;
                    player.stop();
                }
            }
        }
        self.outgoing.retain(|track| track.fade.is_some());
    }

    fn report_input_error(&mut self) -> Result<(), String> {
        let Some(track) = self.active.as_mut() else {
            return self.last_error.take().map_or(Ok(()), Err);
        };
        if track.clock.take_seek_failure() {
            return Err("The active audio source rejected a seek request".into());
        }
        if !track.error_reported {
            let status = track
                .remote
                .as_ref()
                .map(RemoteControl::status)
                .or_else(|| track.local.as_ref().map(LocalControl::status));
            if let Some(error) = status.and_then(|status: Arc<RemoteStatus>| status.error()) {
                track.error_reported = true;
                return Err(error);
            }
        }
        self.last_error.take().map_or(Ok(()), Err)
    }

    pub fn spectrum(&self) -> Vec<f32> {
        self.spectrum.bins()
    }

    pub fn analysis(&self) -> Option<AnalysisFrame> {
        let (frequency_bins, sample_rate) = self.spectrum.analysis_bins()?;
        Some(AnalysisFrame {
            frequency_bins,
            sample_rate,
            min_decibels: -85.0,
            max_decibels: -15.0,
        })
    }

    pub fn set_spectrum_enabled(&mut self, enabled: bool) {
        self.spectrum.enabled.store(enabled, Ordering::Release);
    }

    /// Returns source time, duration and whether the outgoing fade source is
    /// actively contributing audio. There is at most one outgoing source.
    pub fn outgoing_clock(&self) -> Option<(f64, Option<f64>, bool)> {
        self.outgoing.first().map(|track| {
            let is_playing = track.requested_playing
                && track
                    .player
                    .as_ref()
                    .is_some_and(|player| !player.is_paused() && !player.empty())
                && !track.is_buffering();
            (track.position(), track.duration_sec, is_playing)
        })
    }
}

fn open_device(error_flag: Arc<AtomicBool>) -> Result<MixerDeviceSink, String> {
    let builder = DeviceSinkBuilder::from_default_device()
        .map_err(|error| format!("Could not enumerate output devices: {error}"))?;
    builder
        .with_error_callback(move |_error| {
            error_flag.store(true, Ordering::Release);
        })
        .open_sink_or_fallback()
        .map_err(|error| format!("Could not open audio output: {error}"))
}
