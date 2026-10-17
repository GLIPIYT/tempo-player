use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::listening::{ListeningAccumulator, ListeningWriter};
use super::models::{
    NativePersistedState, NativeSettings, PlayerSnapshot, RepeatMode, TrackPayload,
    NATIVE_STATE_SETTING,
};
use super::output::{OutputEngine, OutputSettings};
use super::queue::QueueEntry;
use super::resolver::{self, PreparedTrack, PreparedTransport, ReservoirResult};
use super::{
    ActorMessage, ANALYSIS_EVENT, CLOCK_EVENT, CONTINUATION_EVENT, FFT_EVENT, STATE_EVENT,
};
use crate::soundcloud_browser::{BrowserEvent, BrowserPlayback, BrowserSettings};

const ACTOR_TICK: Duration = Duration::from_millis(50);
const CLOCK_INTERVAL: Duration = Duration::from_millis(100);
const STATE_HEARTBEAT: Duration = Duration::from_millis(500);
const ANALYSIS_INTERVAL: Duration = Duration::from_millis(50);
const CONTINUATION_DELAY: Duration = Duration::from_millis(1500);
const PERSIST_POSITION_INTERVAL: Duration = Duration::from_secs(15);
const RESERVOIR_LIMIT: usize = 512;
const SHORT_CLIP_CROSSFADE_LIMIT_SEC: f64 = 8.0;
const CROSSFADE_TRACK_FRACTION: f64 = 0.2;

pub(crate) struct PreparedMessage {
    pub generation: u64,
    pub entry_id: String,
    pub result: Result<PreparedTrack, String>,
}

pub(crate) struct BrowserPreparedMessage {
    pub generation: u64,
    pub entry_id: String,
    pub track: Value,
    pub result: Result<(BrowserPlayback, Receiver<BrowserEvent>), String>,
}

struct BrowserOutput {
    handle: BrowserPlayback,
    events: Receiver<BrowserEvent>,
    position: f64,
    duration: f64,
    playing: bool,
    buffering: bool,
    finished: bool,
    bins: Vec<f64>,
}

pub(crate) struct PreloadMessage {
    pub generation: u64,
    pub preload_token: u64,
    pub entry_id: String,
    pub result: Result<PreparedTrack, String>,
}

pub(crate) struct ReservoirMessage {
    pub request_id: String,
    pub result: Result<Option<ReservoirResult>, String>,
}

enum PersistMessage {
    Save(NativePersistedState),
    Flush(SyncSender<Result<(), String>>),
    Stop,
}

struct PersistenceWriter {
    sender: Sender<PersistMessage>,
    worker: Option<thread::JoinHandle<()>>,
}

impl PersistenceWriter {
    fn new(db: Arc<crate::database::Db>) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("tempo-native-audio-state".into())
            .spawn(move || {
                let mut last_error = None;
                while let Ok(message) = receiver.recv() {
                    match message {
                        PersistMessage::Save(state) => {
                            if let Err(error) = persist_state(&db, &state) {
                                eprintln!("[tempo native audio] state persistence failed: {error}");
                                last_error = Some(error);
                            }
                        }
                        PersistMessage::Flush(reply) => {
                            let _ = reply.send(last_error.take().map_or(Ok(()), Err));
                        }
                        PersistMessage::Stop => break,
                    }
                }
            })
            .map_err(|error| format!("could not start native state writer: {error}"))?;
        Ok(Self {
            sender,
            worker: Some(worker),
        })
    }

    fn save(&self, state: NativePersistedState) {
        let _ = self.sender.send(PersistMessage::Save(state));
    }

    fn flush(&self) -> Result<(), String> {
        let (reply, result) = mpsc::sync_channel(1);
        self.sender
            .send(PersistMessage::Flush(reply))
            .map_err(|error| error.to_string())?;
        result
            .recv_timeout(Duration::from_millis(900))
            .map_err(|error| format!("native state flush timed out: {error}"))?
    }
}

impl Drop for PersistenceWriter {
    fn drop(&mut self) {
        let _ = self.sender.send(PersistMessage::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn persist_state(db: &crate::database::Db, state: &NativePersistedState) -> Result<(), String> {
    let encoded = serde_json::to_string(state).map_err(|error| error.to_string())?;
    if encoded.len() > 16 * 1024 * 1024 {
        return Err("native audio state exceeds its storage limit".into());
    }
    db.set_app_setting(NATIVE_STATE_SETTING, &encoded)
}

pub fn run(
    app: AppHandle,
    receiver: Receiver<ActorMessage>,
    sender: Sender<ActorMessage>,
    stop_monitor: Arc<AtomicBool>,
) {
    let state = app.state::<crate::commands::AppState>();
    let db = state.db.clone();
    drop(state);

    let mut persisted = db
        .get_app_setting(NATIVE_STATE_SETTING)
        .ok()
        .flatten()
        .and_then(|encoded| serde_json::from_str::<NativePersistedState>(&encoded).ok())
        .unwrap_or_default();
    persisted.queue.sanitize();
    persisted.settings = persisted.settings.clone().normalized();
    persisted.queue.set_shuffled(persisted.settings.shuffle);
    persisted.position = finite_nonnegative(persisted.position);
    if persisted.reservoir_consumed.len() > RESERVOIR_LIMIT {
        let remove = persisted.reservoir_consumed.len() - RESERVOIR_LIMIT;
        persisted.reservoir_consumed.drain(0..remove);
    }

    let mut engine = match OutputEngine::new() {
        Ok(engine) => engine,
        Err(error) => {
            eprintln!("[tempo native audio] output initialization failed: {error}");
            return;
        }
    };
    engine.configure(output_settings(&persisted.settings));
    engine.set_spectrum_enabled(false);

    let persistence = match PersistenceWriter::new(db.clone()) {
        Ok(writer) => writer,
        Err(error) => {
            eprintln!("[tempo native audio] {error}");
            return;
        }
    };
    let listening_writer = match ListeningWriter::new(db.clone()) {
        Ok(writer) => writer,
        Err(error) => {
            eprintln!("[tempo native audio] {error}");
            return;
        }
    };
    let mut actor = Actor {
        app,
        db,
        sender,
        engine,
        browser: None,
        persisted,
        version: 0,
        current_error: None,
        spectrum_enabled: false,
        analysis_enabled: false,
        queue_generation: 1,
        generation_guard: Arc::new(AtomicU64::new(1)),
        pending_start: None,
        active_entry_id: None,
        active_track: None,
        active_reason: "restore".into(),
        playing_intent: false,
        last_position: 0.0,
        preloaded: None,
        preload_requested: None,
        preload_token: 1,
        continuation: None,
        reservoir_request_running: false,
        continuation_sequence: 0,
        load_attempts: 0,
        soundcloud_fallback_attempted: HashSet::new(),
        listening: ListeningAccumulator::default(),
        fading_listening: None,
        listening_writer,
        persistence,
        last_clock_at: Instant::now() - CLOCK_INTERVAL,
        last_fft_at: Instant::now() - Duration::from_millis(34),
        last_analysis_at: Instant::now() - ANALYSIS_INTERVAL,
        last_state_at: Instant::now() - STATE_HEARTBEAT,
        last_position_persist: Instant::now(),
        visible: false,
        shutdown: false,
        shutdown_reply: None,
    };

    actor.last_position = actor.persisted.position;
    actor.emit_state();

    while !actor.shutdown {
        match receiver.recv_timeout(ACTOR_TICK) {
            Ok(message) => actor.handle(message),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if !actor.shutdown {
            actor.tick();
        }
    }

    actor.finish_session("exit");
    actor.last_position = actor.current_position();
    actor.pause_output();
    actor.stop_output();
    actor.active_entry_id = None;
    actor.pending_start = None;
    actor.preloaded = None;
    actor.persist_now();
    let listening_result = actor.listening_writer.flush();
    let persistence_result = actor.persistence.flush();
    let final_result = match (listening_result, persistence_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(history), Ok(())) => Err(format!("history flush failed: {history}")),
        (Ok(()), Err(state)) => Err(format!("state flush failed: {state}")),
        (Err(history), Err(state)) => Err(format!(
            "history flush failed: {history}; state flush failed: {state}"
        )),
    };
    actor.emit_state();
    stop_monitor.store(true, Ordering::Release);
    if let Some(reply) = actor.shutdown_reply.take() {
        let _ = reply.send(final_result);
    }
}

struct PendingStart {
    generation: u64,
    entry_id: String,
    position: f64,
    playing: bool,
    reason: String,
    fade_sec: f64,
    keep_session: bool,
}

struct Continuation {
    request_id: String,
    deadline: Instant,
}

struct Actor {
    app: AppHandle,
    db: Arc<crate::database::Db>,
    sender: Sender<ActorMessage>,
    engine: OutputEngine,
    browser: Option<BrowserOutput>,
    persisted: NativePersistedState,
    version: u64,
    current_error: Option<String>,
    spectrum_enabled: bool,
    analysis_enabled: bool,
    queue_generation: u64,
    generation_guard: Arc<AtomicU64>,
    pending_start: Option<PendingStart>,
    active_entry_id: Option<String>,
    active_track: Option<Value>,
    active_reason: String,
    playing_intent: bool,
    last_position: f64,
    preloaded: Option<(String, PreparedTrack)>,
    preload_requested: Option<String>,
    preload_token: u64,
    continuation: Option<Continuation>,
    reservoir_request_running: bool,
    continuation_sequence: u64,
    load_attempts: usize,
    soundcloud_fallback_attempted: HashSet<String>,
    listening: ListeningAccumulator,
    fading_listening: Option<ListeningAccumulator>,
    listening_writer: ListeningWriter,
    persistence: PersistenceWriter,
    last_clock_at: Instant,
    last_fft_at: Instant,
    last_analysis_at: Instant,
    last_state_at: Instant,
    last_position_persist: Instant,
    visible: bool,
    shutdown: bool,
    shutdown_reply: Option<Sender<Result<(), String>>>,
}

impl Actor {
    fn browser_settings(&self, track: Option<&Value>) -> BrowserSettings {
        let settings = &self.persisted.settings;
        BrowserSettings {
            volume: settings.volume as f64,
            playback_rate: settings.playback_rate as f64,
            preserve_pitch: settings.preserve_pitch,
            equalizer_enabled: settings.equalizer_enabled,
            equalizer_gains: settings.equalizer_gains,
            gain_db: track
                .map(|track| TrackPayload(track.clone()).gain_db(settings.normalize))
                .unwrap_or(0.0),
            spectrum_enabled: (self.spectrum_enabled || self.analysis_enabled) && self.visible,
        }
    }

    fn on_browser_prepared(&mut self, message: BrowserPreparedMessage) {
        if !self.pending_start.as_ref().is_some_and(|pending| {
            pending.generation == message.generation && pending.entry_id == message.entry_id
        }) {
            return;
        }
        let pending = self.pending_start.take().expect("matching browser start");
        match message.result {
            Ok((handle, events)) => {
                if !pending.keep_session {
                    self.finish_session("next");
                }
                let duration = TrackPayload(message.track.clone())
                    .duration()
                    .unwrap_or(0.0);
                self.persisted
                    .queue
                    .update_entry(&pending.entry_id, message.track.clone());
                self.engine.stop();
                self.browser = Some(BrowserOutput {
                    handle,
                    events,
                    position: pending.position,
                    duration,
                    playing: false,
                    buffering: true,
                    finished: false,
                    bins: vec![0.0; 64],
                });
                self.active_entry_id = Some(pending.entry_id);
                self.active_track = Some(message.track);
                self.active_reason = pending.reason;
                self.playing_intent = pending.playing;
                self.last_position = pending.position;
                self.current_error = None;
                self.load_attempts = 0;
                self.preloaded = None;
                self.preload_requested = None;
                let settings = self.browser_settings(self.active_track.as_ref());
                if let Some(browser) = self.browser.as_ref() {
                    if let Err(error) = browser.handle.configure(settings) {
                        self.current_error = Some(error);
                    }
                }
                if pending.playing {
                    self.play_output();
                }
                self.persist_now();
                self.emit_state();
            }
            Err(error) => {
                self.current_error = Some(error);
                self.finish_session("error");
                self.stop_output();
                self.active_entry_id = None;
                self.active_track = None;
                self.playing_intent = false;
                self.emit_state();
            }
        }
    }

    fn poll_browser(&mut self) {
        let mut failed = None;
        if let Some(browser) = self.browser.as_mut() {
            for _ in 0..64 {
                let event = match browser.events.try_recv() {
                    Ok(event) => event,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        failed = Some(
                            "SoundCloud browser playback stopped; sign in or retry the track"
                                .to_string(),
                        );
                        break;
                    }
                };
                match event {
                    BrowserEvent::Ready { duration } => {
                        browser.duration = duration;
                    }
                    BrowserEvent::Clock {
                        position,
                        duration,
                        playing,
                        buffering,
                    } => {
                        if !browser.finished {
                            browser.position = finite_nonnegative(position);
                            browser.duration = duration;
                            browser.playing = playing;
                            browser.buffering = buffering;
                        }
                    }
                    BrowserEvent::Finished => {
                        browser.finished = true;
                        browser.position = browser.duration;
                        browser.playing = false;
                        browser.buffering = false;
                        browser.bins.fill(0.0);
                    }
                    BrowserEvent::Failed(error) => {
                        failed = Some(error);
                        break;
                    }
                    BrowserEvent::Spectrum(bins) => {
                        if bins.len() == 64
                            && bins
                                .iter()
                                .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
                        {
                            browser.bins = bins;
                        }
                    }
                    BrowserEvent::Capabilities {
                        equalizer,
                        gain,
                        spectrum,
                        error,
                    } => {
                        let _ = self.app.emit("native-audio://browser-capabilities", json!({
                            "equalizer": equalizer, "gain": gain, "spectrum": spectrum, "error": error,
                        }));
                    }
                }
            }
        }
        if let Some(error) = failed {
            self.sample_listening();
            self.finish_session("error");
            self.last_position = self.current_position();
            self.stop_output();
            self.active_entry_id = None;
            self.active_track = None;
            self.playing_intent = false;
            self.current_error = Some(error);
            self.emit_state();
        }
    }

    fn transport_position(&self) -> f64 {
        self.browser
            .as_ref()
            .map_or_else(|| self.engine.position(), |browser| browser.position)
    }
    fn transport_duration(&self) -> Option<f64> {
        self.browser
            .as_ref()
            .map_or_else(|| self.engine.duration(), |browser| Some(browser.duration))
    }
    fn transport_is_playing(&self) -> bool {
        self.browser
            .as_ref()
            .map_or_else(|| self.engine.is_playing(), |browser| browser.playing)
    }
    fn transport_buffering(&self) -> bool {
        self.browser
            .as_ref()
            .map_or_else(|| self.engine.buffering(), |browser| browser.buffering)
    }
    fn transport_ended(&self) -> bool {
        self.browser
            .as_ref()
            .map_or_else(|| self.engine.ended(), |browser| browser.finished)
    }
    fn transport_has_source(&self) -> bool {
        self.browser.is_some() || self.engine.has_source()
    }
    fn play_output(&mut self) {
        if let Some(browser) = self.browser.as_mut() {
            if let Err(error) = browser.handle.play() {
                self.current_error = Some(error);
            }
        } else {
            self.engine.play();
        }
    }
    fn pause_output(&mut self) {
        if let Some(browser) = self.browser.as_mut() {
            if let Err(error) = browser.handle.pause() {
                self.current_error = Some(error);
            }
            browser.playing = false;
            browser.bins.fill(0.0);
        } else {
            self.engine.pause();
        }
    }
    fn stop_output(&mut self) {
        self.browser = None;
        self.engine.stop();
    }
    fn seek_output(&mut self, position: f64) -> Result<(), String> {
        if let Some(browser) = self.browser.as_mut() {
            browser.handle.seek(position)?;
            browser.position = position.min(browser.duration).max(0.0);
            browser.finished = false;
            browser.buffering = true;
            Ok(())
        } else {
            self.engine.seek(position)
        }
    }

    fn handle(&mut self, message: ActorMessage) {
        match message {
            ActorMessage::Command { value, reply } => {
                #[cfg(debug_assertions)]
                let timing = (
                    Instant::now(),
                    value
                        .get("op")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                );
                let result = self.command(value);
                #[cfg(debug_assertions)]
                if matches!(
                    timing.1.as_str(),
                    "replace" | "play" | "toggle" | "next" | "previous"
                ) {
                    eprintln!(
                        "[tempo startup] stage=actor_command op={} queue_items={} elapsed_ms={}",
                        timing.1,
                        self.persisted.queue.len(),
                        timing.0.elapsed().as_millis()
                    );
                }
                let _ = reply.send(result);
            }
            ActorMessage::Prepared(message) => self.on_prepared(message),
            ActorMessage::BrowserPrepared(message) => self.on_browser_prepared(message),
            ActorMessage::Preloaded(message) => self.on_preloaded(message),
            ActorMessage::ReservoirReady(message) => self.on_reservoir(message),
            ActorMessage::GenerationChanged(generation) => self.on_generation(generation),
            ActorMessage::Snapshot(reply) => {
                let _ = reply.send(self.snapshot_value());
            }
            ActorMessage::Shutdown(reply) => {
                self.shutdown = true;
                self.shutdown_reply = Some(reply);
            }
        }
    }

    fn command(&mut self, command: Value) -> Result<(), String> {
        let op = command
            .get("op")
            .and_then(Value::as_str)
            .ok_or("native audio command is missing op")?;
        self.current_error = None;
        let mut changed = false;
        let mut persist = false;
        let result = (|| -> Result<(), String> {
            match op {
                "migrate" => {
                    if self.persisted.initialized {
                        return Ok(());
                    }
                    let tracks = parse_tracks(command.get("tracks"))?;
                    let index = command.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let settings = match command.get("settings") {
                        Some(patch) => self.merged_settings(patch)?,
                        None => self.persisted.settings.clone(),
                    };
                    let mut queue = self.persisted.queue.clone();
                    queue.set_shuffled(settings.shuffle);
                    queue.replace(tracks, index)?;
                    self.persisted.queue = queue;
                    self.apply_settings(settings);
                    self.persisted.initialized = true;
                    self.invalidate_continuation();
                    if self.persisted.queue.is_empty() {
                        self.stop_current("clear");
                    } else {
                        self.last_position = 0.0;
                    }
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "replace" => {
                    let tracks = parse_tracks(command.get("tracks"))?;
                    let index = command.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let play = command.get("play").and_then(Value::as_bool).unwrap_or(true);
                    self.invalidate_continuation();
                    self.finish_session("select");
                    self.persisted.queue.replace(tracks, index)?;
                    self.persisted.initialized = true;
                    self.load_attempts = 0;
                    if play {
                        if let Some(entry) = self.persisted.queue.current().cloned() {
                            self.request_start(entry, 0.0, play, "manual", 0.0, false);
                        }
                    } else if self.persisted.queue.is_empty() {
                        self.stop_current("select");
                    } else {
                        self.bump_generation();
                        self.stop_output();
                        self.active_entry_id = None;
                        self.active_track = None;
                        self.active_reason = "manual".into();
                        self.playing_intent = false;
                        self.last_position = 0.0;
                    }
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "toggle" => {
                    if self.playing_intent {
                        self.pause_current();
                    } else {
                        self.play_current();
                    }
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "play" => {
                    self.play_current();
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "pause" => {
                    self.pause_current();
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "next" => {
                    self.invalidate_continuation();
                    self.move_next("next", true);
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "previous" => {
                    self.invalidate_continuation();
                    self.move_previous();
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "clear" => {
                    self.invalidate_continuation();
                    self.persisted.queue.clear();
                    self.persisted.initialized = true;
                    self.stop_current("clear");
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "seek" => {
                    let position = command
                        .get("position")
                        .and_then(Value::as_f64)
                        .filter(|value| value.is_finite())
                        .ok_or("seek position must be finite")?
                        .max(0.0);
                    self.seek(position)?;
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "settings" => {
                    self.merge_settings(&command)?;
                    self.persisted.initialized = true;
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "append" => {
                    let track = TrackPayload::parse(
                        command
                            .get("track")
                            .cloned()
                            .ok_or("append track is missing")?,
                    )?
                    .0;
                    let request_id = command.get("requestId").and_then(Value::as_str);
                    let tagged = if let Some(id) = request_id {
                        let matches = self
                            .continuation
                            .as_ref()
                            .is_some_and(|pending| pending.request_id == id);
                        if !matches {
                            return Ok(());
                        }
                        self.continuation = None;
                        true
                    } else {
                        self.invalidate_continuation();
                        false
                    };
                    if tagged {
                        let payload = TrackPayload(track.clone());
                        let existing = self
                            .persisted
                            .queue
                            .items()
                            .iter()
                            .flat_map(|entry| TrackPayload(entry.track.clone()).reservoir_keys())
                            .collect::<HashSet<_>>();
                        if payload
                            .reservoir_keys()
                            .iter()
                            .any(|key| existing.contains(key))
                            || payload.reservoir_keys().iter().any(|key| {
                                self.persisted
                                    .reservoir_consumed
                                    .iter()
                                    .any(|consumed| consumed == key)
                            })
                        {
                            return Ok(());
                        }
                    }
                    let was_empty = self.persisted.queue.is_empty();
                    let was_exhausted = !self.playing_intent && self.transport_ended();
                    let next = command
                        .get("next")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    self.invalidate_preload();
                    let entry = self.persisted.queue.append(track.clone(), next)?;
                    self.persisted.initialized = true;
                    if tagged || track.get("auto").and_then(Value::as_bool) == Some(true) {
                        self.remember_track_consumed(&track);
                    }
                    if was_empty {
                        self.load_attempts = 0;
                        self.request_start(
                            entry,
                            0.0,
                            true,
                            if tagged { "autoplay" } else { "queue" },
                            0.0,
                            false,
                        );
                    } else if tagged || was_exhausted {
                        if let Some(entry) =
                            self.persisted.queue.next(self.persisted.settings.repeat)
                        {
                            self.load_attempts = 0;
                            self.request_start(
                                entry,
                                0.0,
                                true,
                                if tagged { "autoplay" } else { "queue" },
                                0.0,
                                false,
                            );
                        }
                    }
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "remove" => {
                    self.invalidate_continuation();
                    let index = command
                        .get("index")
                        .and_then(Value::as_u64)
                        .ok_or("remove index is missing")? as usize;
                    let was_playing = self.playing_intent;
                    self.invalidate_preload();
                    let removed = self
                        .persisted
                        .queue
                        .remove(index)
                        .ok_or("queue index is out of range")?;
                    if removed {
                        self.finish_session("remove");
                        if was_playing {
                            if let Some(entry) = self.persisted.queue.current().cloned() {
                                self.load_attempts = 0;
                                self.request_start(entry, 0.0, true, "queue", 0.0, false);
                            } else {
                                self.stop_current("remove");
                            }
                        } else {
                            self.stop_current("remove");
                        }
                    }
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "move" => {
                    self.invalidate_continuation();
                    let from = command
                        .get("from")
                        .and_then(Value::as_u64)
                        .ok_or("move from index is missing")?
                        as usize;
                    let to = command
                        .get("to")
                        .and_then(Value::as_u64)
                        .ok_or("move to index is missing")? as usize;
                    self.invalidate_preload();
                    self.persisted.queue.move_item(from, to);
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "updateTrack" => {
                    let track = TrackPayload::parse(
                        command
                            .get("track")
                            .cloned()
                            .ok_or("updated track is missing")?,
                    )?
                    .0;
                    self.invalidate_preload();
                    self.persisted.queue.update_track(track.clone())?;
                    if self
                        .active_track
                        .as_ref()
                        .is_some_and(|current| same_identity(current, &track))
                    {
                        self.active_track = Some(track.clone());
                        self.engine.set_track_gain(
                            TrackPayload(track.clone()).gain_db(self.persisted.settings.normalize),
                        );
                        if let Some(browser) = self.browser.as_ref() {
                            if let Err(error) = browser
                                .handle
                                .configure(self.browser_settings(Some(&track)))
                            {
                                self.current_error = Some(error);
                            }
                        }
                        let _ = self.listening.update_metadata(&track);
                    }
                    changed = true;
                    persist = true;
                    Ok(())
                }
                "visibility" => {
                    self.visible = command
                        .get("visible")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    self.update_spectrum_capture();
                    Ok(())
                }
                "spectrum" => {
                    self.spectrum_enabled = command
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    self.update_spectrum_capture();
                    Ok(())
                }
                "analysis" => {
                    self.analysis_enabled = command
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    self.update_spectrum_capture();
                    Ok(())
                }
                other => Err(format!("unsupported native audio operation: {other}")),
            }
        })();

        if let Err(error) = result {
            self.current_error = Some(error.clone());
            self.emit_state();
            return Err(error);
        }
        if persist {
            self.persist_now();
        }
        if changed {
            self.emit_state();
        }
        Ok(())
    }

    fn tick(&mut self) {
        self.poll_browser();
        self.sample_fading_listening();
        let position_before_tick = self.current_position();
        if let Err(error) = if self.browser.is_none() {
            self.engine.tick()
        } else {
            Ok(())
        } {
            if self.retry_current_soundcloud(&error) {
                self.current_error =
                    Some("SoundCloud stream stopped; switching to a cached fallback…".into());
                self.emit_state();
                return;
            }
            self.current_error = Some(error);
            if self.playing_intent
                && self.pending_start.is_none()
                && (self.transport_ended() || !self.transport_has_source())
            {
                let engine_position = self.transport_position();
                self.last_position = finite_nonnegative(if engine_position > 0.0 {
                    engine_position
                } else {
                    position_before_tick
                });
                self.active_entry_id = None;
                self.active_track = None;
                self.finish_session("error");
                self.stop_output();
                self.playing_intent = false;
                self.persist_now();
            }
            self.emit_state();
        }

        self.sample_listening();
        self.sample_fading_listening();
        if let Some(event) = self.listening.checkpoint_if_due() {
            self.listening_writer.record(event);
        }
        if let Some(event) = self
            .fading_listening
            .as_mut()
            .and_then(ListeningAccumulator::checkpoint_if_due)
        {
            self.listening_writer.record(event);
        }

        if self.transport_ended() && self.playing_intent && self.pending_start.is_none() {
            self.advance_after_end();
        }

        self.maybe_preload();
        self.maybe_crossfade();
        self.maybe_continue();

        let now = Instant::now();
        let playing = self.playing_intent || self.transport_is_playing();
        if playing && now.duration_since(self.last_clock_at) >= CLOCK_INTERVAL {
            self.emit_clock();
            self.last_clock_at = now;
        }
        if playing && now.duration_since(self.last_state_at) >= STATE_HEARTBEAT {
            self.emit_state();
        }
        if self.spectrum_enabled
            && self.visible
            && now.duration_since(self.last_fft_at) >= Duration::from_millis(33)
        {
            self.emit_spectrum();
            self.last_fft_at = now;
        }
        if self.analysis_enabled
            && self.visible
            && self.pending_start.is_none()
            && self.transport_is_playing()
            && !self.transport_buffering()
            && now.duration_since(self.last_analysis_at) >= ANALYSIS_INTERVAL
        {
            self.emit_analysis();
            self.last_analysis_at = now;
        }
        if now.duration_since(self.last_position_persist) >= PERSIST_POSITION_INTERVAL {
            self.last_position = self.current_position();
            self.persist_now();
            self.last_position_persist = now;
        }
    }

    fn on_prepared(&mut self, message: PreparedMessage) {
        let Some(pending) = self.pending_start.as_ref() else {
            return;
        };
        if pending.generation != message.generation || pending.entry_id != message.entry_id {
            return;
        }
        let pending = self.pending_start.take().expect("pending start checked");
        match message.result {
            Ok(prepared) => {
                let PreparedTrack { transport, track } = prepared;
                let audio = match transport {
                    PreparedTransport::Native(audio) => audio,
                    PreparedTransport::Browser(descriptor) => {
                        if !pending.keep_session {
                            self.finish_session("next");
                        }
                        self.stop_output();
                        self.browser = None;
                        let settings = self.browser_settings(Some(&track));
                        let app = self.app.clone();
                        let sender = self.sender.clone();
                        let generation = pending.generation;
                        let entry_id = pending.entry_id.clone();
                        let position = pending.position;
                        let guard = self.generation_guard.clone();
                        self.pending_start = Some(pending);
                        tauri::async_runtime::spawn(async move {
                            let (events, receiver) = mpsc::channel();
                            let result = crate::soundcloud_browser::start(
                                app, descriptor, settings, position, false, generation, events,
                            )
                            .await
                            .map(|handle| (handle, receiver));
                            if guard.load(Ordering::Acquire) == generation {
                                let _ = sender.send(ActorMessage::BrowserPrepared(
                                    BrowserPreparedMessage {
                                        generation,
                                        entry_id,
                                        track,
                                        result,
                                    },
                                ));
                            }
                        });
                        return;
                    }
                };
                if self.browser.is_some() && !pending.keep_session {
                    self.finish_session("next");
                }
                self.browser = None;
                let outgoing_session =
                    if pending.fade_sec > 0.0 && pending.playing && self.transport_is_playing() {
                        self.sample_listening();
                        self.finish_fading_session("end");
                        Some(std::mem::take(&mut self.listening))
                    } else {
                        if !pending.keep_session {
                            self.finish_session("next");
                        }
                        None
                    };
                self.persisted
                    .queue
                    .update_entry(&pending.entry_id, track.clone());
                let gain = TrackPayload(track.clone()).gain_db(self.persisted.settings.normalize);
                self.engine
                    .configure(output_settings(&self.persisted.settings));
                if let Err(error) = self
                    .engine
                    .install(audio, pending.playing, pending.fade_sec)
                {
                    if let Some(mut session) = outgoing_session {
                        if let Some(event) = session.finish("error") {
                            self.listening_writer.record(event);
                        }
                    } else {
                        self.finish_session("error");
                    }
                    self.current_error = Some(error);
                    self.playing_intent = false;
                    self.stop_output();
                    self.emit_state();
                    return;
                }
                self.fading_listening = outgoing_session;
                self.engine.set_track_gain(gain);
                self.active_entry_id = Some(pending.entry_id);
                self.active_track = Some(track);
                self.active_reason = pending.reason;
                self.playing_intent = pending.playing;
                self.last_position = pending.position;
                self.current_error = None;
                self.load_attempts = 0;
                self.preloaded = None;
                self.preload_requested = None;
                if self.transport_is_playing() && !self.transport_buffering() {
                    self.ensure_session();
                }
                self.persist_now();
                self.emit_state();
            }
            Err(error) => {
                if self.retry_failed_soundcloud(&pending, &error) {
                    self.current_error =
                        Some("SoundCloud stream failed; switching to a cached fallback…".into());
                    self.emit_state();
                    return;
                }
                self.current_error = Some(error.clone());
                self.finish_session("error");
                self.stop_output();
                self.active_entry_id = None;
                self.active_track = None;
                self.last_position = 0.0;
                self.load_attempts += 1;
                let mut retrying_next = false;
                if self.playing_intent && self.load_attempts < self.persisted.queue.len().max(1) {
                    if let Some(entry) = self.persisted.queue.next(self.persisted.settings.repeat) {
                        self.request_start(entry, 0.0, true, "queue", 0.0, false);
                        retrying_next = true;
                    }
                }
                if !retrying_next {
                    self.playing_intent = false;
                }
                self.emit_state();
            }
        }
    }

    fn on_preloaded(&mut self, message: PreloadMessage) {
        if message.generation != self.queue_generation
            || message.preload_token != self.preload_token
        {
            return;
        }
        if self.preload_requested.as_deref() != Some(message.entry_id.as_str()) {
            return;
        }
        self.preload_requested = None;
        if self
            .persisted
            .queue
            .peek_next(self.persisted.settings.repeat)
            .as_ref()
            .map(|entry| entry.id.as_str())
            != Some(message.entry_id.as_str())
        {
            return;
        }
        match message.result {
            Ok(prepared) => self.preloaded = Some((message.entry_id, prepared)),
            Err(error) => {
                // A preload failure is not yet a playback failure. The normal
                // next-track path reports it if/when the user reaches it.
                eprintln!("[tempo native audio] preload failed: {error}");
            }
        }
    }

    fn on_reservoir(&mut self, message: ReservoirMessage) {
        if !self
            .continuation
            .as_ref()
            .is_some_and(|request| request.request_id == message.request_id)
        {
            return;
        }
        self.reservoir_request_running = false;
        let candidate = match message.result {
            Ok(candidate) => candidate,
            Err(error) => {
                self.current_error = Some(error);
                self.continuation = None;
                self.emit_state();
                return;
            }
        };
        self.continuation = None;
        let Some(candidate) = candidate else {
            self.emit_state();
            return;
        };
        let candidate_keys = TrackPayload(candidate.track.clone()).reservoir_keys();
        let existing_keys = self
            .persisted
            .queue
            .items()
            .iter()
            .flat_map(|entry| TrackPayload(entry.track.clone()).reservoir_keys())
            .collect::<HashSet<_>>();
        if candidate_keys.iter().any(|key| existing_keys.contains(key)) {
            self.emit_state();
            return;
        }
        self.persisted.reservoir_revision = Some(candidate.revision);
        self.remember_track_consumed(&candidate.track);
        match self.persisted.queue.append(candidate.track, false) {
            Ok(_) => {
                if let Some(entry) = self.persisted.queue.next(self.persisted.settings.repeat) {
                    self.persisted.initialized = true;
                    self.load_attempts = 0;
                    self.request_start(entry, 0.0, true, "autoplay", 0.0, false);
                    self.persist_now();
                }
            }
            Err(error) => self.current_error = Some(error),
        }
        self.emit_state();
    }

    fn on_generation(&mut self, generation: i64) {
        let current_generation = self.listening_generation();
        if current_generation != generation {
            return;
        }
        if !self.listening.has_active() {
            self.fading_listening = None;
            return;
        }
        self.listening = ListeningAccumulator::default();
        self.fading_listening = None;
        if self.transport_is_playing() && !self.transport_buffering() {
            if let Some(track) = self.active_track.as_ref() {
                let _ = self.listening.begin(track, &self.active_reason, generation);
                self.listening.sample(
                    self.transport_position(),
                    self.transport_duration(),
                    self.persisted.settings.playback_rate as f64,
                    true,
                );
            }
        }
    }

    fn play_current(&mut self) {
        self.invalidate_continuation();
        self.playing_intent = true;
        if let Some(pending) = self.pending_start.as_mut() {
            pending.playing = true;
        }
        if self.pending_start.is_none() {
            if self.active_entry_id.is_some()
                && self.transport_has_source()
                && !self.transport_ended()
            {
                self.play_output();
                if let Some(session) = self.fading_listening.as_mut() {
                    session.reanchor();
                }
                self.ensure_session();
            } else if let Some(entry) = self.persisted.queue.current().cloned() {
                let reason = if self.active_reason == "restore" {
                    "restore"
                } else {
                    "manual"
                };
                let position = if self.transport_ended() {
                    0.0
                } else {
                    self.last_position
                };
                self.request_start(entry, position, true, reason, 0.0, false);
            }
        }
    }

    fn pause_current(&mut self) {
        self.invalidate_continuation();
        self.sample_listening();
        self.sample_fading_listening();
        self.playing_intent = false;
        if let Some(pending) = self.pending_start.as_mut() {
            pending.playing = false;
        }
        self.pause_output();
        self.last_position = self.current_position();
        self.listening.reanchor();
        if let Some(session) = self.fading_listening.as_mut() {
            session.reanchor();
        }
    }

    fn seek(&mut self, position: f64) -> Result<(), String> {
        self.invalidate_continuation();
        self.sample_listening();
        self.sample_fading_listening();
        self.last_position = position;
        self.listening.reanchor();
        if let Some(session) = self.fading_listening.as_mut() {
            session.reanchor();
        }
        if let Some(pending) = self.pending_start.as_mut() {
            pending.position = position;
            self.request_current_prepare(position, true);
            return Ok(());
        }
        match self.seek_output(position) {
            Ok(()) => {}
            Err(_) => {
                let Some(entry) = self.persisted.queue.current().cloned() else {
                    return Err("No active track to seek".into());
                };
                let reason = self.active_reason.clone();
                self.request_start(entry, position, self.playing_intent, &reason, 0.0, true);
            }
        }
        Ok(())
    }

    fn request_current_prepare(&mut self, position: f64, keep_session: bool) {
        let Some(entry) = self.persisted.queue.current().cloned() else {
            return;
        };
        let reason = self.active_reason.clone();
        self.request_start(
            entry,
            position,
            self.playing_intent,
            &reason,
            0.0,
            keep_session,
        );
    }

    fn move_next(&mut self, reason: &str, allow_continuation: bool) {
        if self.persisted.settings.repeat == RepeatMode::One && reason == "end" {
            let position = 0.0;
            self.finish_session("end");
            if let Some(entry) = self.persisted.queue.current().cloned() {
                self.request_start(entry, position, true, "repeat", 0.0, false);
            }
            return;
        }
        self.sample_listening();
        let playing = self.playing_intent || self.transport_is_playing();
        self.finish_session(if reason == "end" { "end" } else { "next" });
        if let Some(entry) = self.persisted.queue.next(self.persisted.settings.repeat) {
            self.load_attempts = 0;
            if !playing {
                self.stop_output_keep_queue();
            } else {
                if let Some(prepared) = self.take_preloaded(&entry.id) {
                    // Overlap is started only by maybe_crossfade, before EOF.
                    // A normal/manual transition must not fade away its intro.
                    self.install_transition(entry, prepared, true, 0.0, "queue");
                } else {
                    self.request_start(entry, 0.0, true, "queue", 0.0, false);
                }
            }
        } else {
            self.playing_intent = false;
            self.pause_output();
            self.last_position = self.current_position();
            if allow_continuation && reason == "end" {
                self.request_continuation();
            }
        }
    }

    fn move_previous(&mut self) {
        self.sample_listening();
        let playing = self.playing_intent || self.transport_is_playing();
        self.finish_session("previous");
        if self.transport_position() > 3.0 {
            if let Some(entry) = self.persisted.queue.current().cloned() {
                if playing {
                    self.request_start(entry, 0.0, true, "queue", 0.0, false);
                } else {
                    self.last_position = 0.0;
                    self.stop_output_keep_queue();
                }
                return;
            }
        }
        if let Some(entry) = self
            .persisted
            .queue
            .previous(self.persisted.settings.repeat)
        {
            self.load_attempts = 0;
            if playing {
                self.request_start(entry, 0.0, true, "queue", 0.0, false);
            } else {
                self.last_position = 0.0;
                self.stop_output_keep_queue();
            }
        } else if let Some(_entry) = self.persisted.queue.current().cloned() {
            if playing {
                self.request_start(_entry, 0.0, true, "queue", 0.0, false);
            } else {
                self.last_position = 0.0;
                self.stop_output_keep_queue();
            }
        }
    }

    fn stop_output_keep_queue(&mut self) {
        self.bump_generation();
        self.pending_start = None;
        self.stop_output();
        self.active_entry_id = None;
        self.active_track = None;
        self.playing_intent = false;
    }

    fn advance_after_end(&mut self) {
        if self.persisted.settings.repeat == RepeatMode::One {
            self.move_next("end", false);
            self.emit_state();
            return;
        }
        self.move_next("end", true);
        self.emit_state();
    }

    fn stop_current(&mut self, reason: &str) {
        self.sample_listening();
        self.finish_session(reason);
        self.bump_generation();
        self.pending_start = None;
        self.preloaded = None;
        self.preload_requested = None;
        self.stop_output();
        self.active_entry_id = None;
        self.active_track = None;
        self.playing_intent = false;
        self.last_position = 0.0;
    }

    fn request_start(
        &mut self,
        entry: QueueEntry,
        position: f64,
        playing: bool,
        reason: &str,
        fade_sec: f64,
        keep_session: bool,
    ) {
        self.request_start_with_fallback(
            entry,
            position,
            playing,
            reason,
            fade_sec,
            keep_session,
            false,
        );
    }

    fn request_start_with_fallback(
        &mut self,
        entry: QueueEntry,
        position: f64,
        playing: bool,
        reason: &str,
        fade_sec: f64,
        keep_session: bool,
        force_ytdlp: bool,
    ) {
        if let Some((preloaded_id, prepared)) = self.preloaded.take() {
            if preloaded_id == entry.id && !force_ytdlp && position == 0.0 && !keep_session {
                self.install_transition(entry, prepared, playing, fade_sec, reason);
                return;
            }
            self.preloaded = Some((preloaded_id, prepared));
        }
        self.sample_listening();
        self.sample_fading_listening();
        if self.browser.is_some() {
            if !keep_session {
                self.finish_session("next");
            }
            self.last_position = self.transport_position();
            self.browser = None;
        }
        // Invalidate an older asynchronous Widget startup immediately. Its
        // paused result must not delay or replace this new selection.
        crate::soundcloud_browser::close_all(&self.app);
        let generation = self.bump_generation();
        self.pause_output();
        self.playing_intent = playing;
        let pending = PendingStart {
            generation,
            entry_id: entry.id.clone(),
            position: finite_nonnegative(position),
            playing,
            reason: reason.into(),
            fade_sec,
            keep_session,
        };
        self.pending_start = Some(pending);
        self.spawn_prepare(entry, generation, position, false, force_ytdlp, None);
    }

    fn install_transition(
        &mut self,
        entry: QueueEntry,
        prepared: PreparedTrack,
        playing: bool,
        fade_sec: f64,
        reason: &str,
    ) {
        let generation = self.bump_generation();
        self.preload_requested = None;
        self.pending_start = Some(PendingStart {
            generation,
            entry_id: entry.id.clone(),
            position: 0.0,
            playing,
            reason: reason.into(),
            fade_sec,
            keep_session: false,
        });
        self.on_prepared(PreparedMessage {
            generation,
            entry_id: entry.id,
            result: Ok(prepared),
        });
    }

    fn spawn_prepare(
        &mut self,
        entry: QueueEntry,
        generation: u64,
        position: f64,
        preload: bool,
        force_ytdlp: bool,
        preload_token: Option<u64>,
    ) {
        let app = self.app.clone();
        let settings = self.persisted.settings.clone();
        let sender = self.sender.clone();
        let guard = self.generation_guard.clone();
        let entry_id = entry.id;
        let name = if preload {
            "tempo-audio-preload"
        } else {
            "tempo-audio-load"
        };
        let spawn = thread::Builder::new().name(name.into()).spawn(move || {
            if guard.load(Ordering::Acquire) != generation {
                return;
            }
            let result = resolver::prepare_track(app, entry.track, settings, position, force_ytdlp);
            if guard.load(Ordering::Acquire) != generation {
                drop(result);
                return;
            }
            if preload {
                let _ = sender.send(ActorMessage::Preloaded(PreloadMessage {
                    generation,
                    preload_token: preload_token.expect("preload token was allocated"),
                    entry_id,
                    result,
                }));
            } else {
                let _ = sender.send(ActorMessage::Prepared(PreparedMessage {
                    generation,
                    entry_id,
                    result,
                }));
            }
        });
        if let Err(error) = spawn {
            self.current_error = Some(format!("could not start source resolver: {error}"));
            if preload {
                self.preload_requested = None;
            } else {
                self.pending_start = None;
                self.playing_intent = false;
            }
        }
    }

    fn bump_generation(&mut self) -> u64 {
        self.queue_generation = self.queue_generation.wrapping_add(1).max(1);
        self.generation_guard
            .store(self.queue_generation, Ordering::Release);
        self.invalidate_preload();
        self.queue_generation
    }

    fn invalidate_preload(&mut self) {
        self.preload_token = self.preload_token.wrapping_add(1).max(1);
        self.preloaded = None;
        self.preload_requested = None;
    }

    fn retry_current_soundcloud(&mut self, _error: &str) -> bool {
        let Some(entry_id) = self.active_entry_id.clone() else {
            return false;
        };
        let Some(track) = self.active_track.as_ref() else {
            return false;
        };
        if TrackPayload(track.clone()).source() != "soundcloud"
            || !self.soundcloud_fallback_attempted.insert(entry_id.clone())
        {
            return false;
        }
        let Some(entry) = self
            .persisted
            .queue
            .current()
            .filter(|entry| entry.id == entry_id)
            .cloned()
        else {
            return false;
        };
        let position = self.transport_position();
        let reason = self.active_reason.clone();
        self.request_start_with_fallback(
            entry,
            position,
            self.playing_intent,
            &reason,
            0.0,
            true,
            true,
        );
        true
    }

    fn retry_failed_soundcloud(&mut self, pending: &PendingStart, _error: &str) -> bool {
        let Some(entry) = self
            .persisted
            .queue
            .current()
            .filter(|entry| entry.id == pending.entry_id)
            .cloned()
        else {
            return false;
        };
        if TrackPayload(entry.track.clone()).source() != "soundcloud"
            || !self.soundcloud_fallback_attempted.insert(entry.id.clone())
        {
            return false;
        }
        let reason = pending.reason.clone();
        self.request_start_with_fallback(
            entry,
            pending.position,
            pending.playing,
            &reason,
            pending.fade_sec,
            pending.keep_session,
            true,
        );
        true
    }

    fn take_preloaded(&mut self, entry_id: &str) -> Option<PreparedTrack> {
        self.preloaded
            .take()
            .and_then(|(id, track)| (id == entry_id).then_some(track))
    }

    fn maybe_preload(&mut self) {
        if self.pending_start.is_some()
            || self.preloaded.is_some()
            || self.preload_requested.is_some()
        {
            return;
        }
        if self.persisted.settings.repeat == RepeatMode::One {
            return;
        }
        if !self.playing_intent {
            return;
        }
        let Some(entry) = self
            .persisted
            .queue
            .peek_next(self.persisted.settings.repeat)
        else {
            return;
        };
        let generation = self.queue_generation;
        self.preload_token = self.preload_token.wrapping_add(1).max(1);
        let preload_token = self.preload_token;
        self.preload_requested = Some(entry.id.clone());
        self.spawn_prepare(entry, generation, 0.0, true, false, Some(preload_token));
    }

    fn maybe_crossfade(&mut self) {
        let fade = self.persisted.settings.crossfade_sec;
        if self.browser.is_some()
            || fade <= 0.0
            || self.persisted.settings.repeat == RepeatMode::One
            || !self.playing_intent
            || self.pending_start.is_some()
        {
            return;
        }
        let Some(duration) = self.transport_duration().filter(|value| *value > 0.0) else {
            return;
        };
        let Some(entry) = self
            .persisted
            .queue
            .peek_next(self.persisted.settings.repeat)
        else {
            return;
        };
        let Some(incoming_duration) = TrackPayload(entry.track.clone())
            .duration()
            .filter(|value| *value > 0.0)
        else {
            return;
        };
        if duration <= SHORT_CLIP_CROSSFADE_LIMIT_SEC
            || incoming_duration <= SHORT_CLIP_CROSSFADE_LIMIT_SEC
        {
            return;
        }
        let playback_rate = self.persisted.settings.playback_rate as f64;
        if !playback_rate.is_finite() || playback_rate <= 0.0 {
            return;
        }
        let safe_fade = fade
            .min(duration * CROSSFADE_TRACK_FRACTION / playback_rate)
            .min(incoming_duration * CROSSFADE_TRACK_FRACTION / playback_rate);
        if safe_fade < 0.2 {
            return;
        }
        let remaining_wall = (duration - self.transport_position()) / playback_rate;
        if !remaining_wall.is_finite() || remaining_wall <= 0.0 || remaining_wall > safe_fade + 0.15
        {
            return;
        }
        let Some((id, prepared)) = self.preloaded.take() else {
            return;
        };
        if matches!(prepared.transport, PreparedTransport::Browser(_)) {
            self.preloaded = Some((id, prepared));
            return;
        }
        if id != entry.id {
            return;
        }
        self.sample_listening();
        let Some(entry) = self.persisted.queue.next(self.persisted.settings.repeat) else {
            return;
        };
        let effective_fade = safe_fade.min(remaining_wall.max(0.0));
        self.install_transition(entry, prepared, true, effective_fade, "queue");
        self.persist_now();
        self.emit_state();
    }

    fn request_continuation(&mut self) {
        if self.continuation.is_some() {
            return;
        }
        self.continuation_sequence = self.continuation_sequence.wrapping_add(1).max(1);
        let request_id = format!("native-{}-{}", now_ms(), self.continuation_sequence);
        let continuation = Continuation {
            request_id: request_id.clone(),
            deadline: Instant::now() + CONTINUATION_DELAY,
        };
        self.continuation = Some(continuation);
        self.reservoir_request_running = false;
        let _ = self
            .app
            .emit(CONTINUATION_EVENT, json!({ "requestId": request_id }));
    }

    fn maybe_continue(&mut self) {
        if self.reservoir_request_running {
            return;
        }
        let Some(continuation) = self.continuation.as_ref() else {
            return;
        };
        if Instant::now() < continuation.deadline {
            return;
        }
        let request_id = continuation.request_id.clone();
        let app = self.app.clone();
        let sender = self.sender.clone();
        let excluded = self
            .persisted
            .queue
            .items()
            .iter()
            .flat_map(|entry| TrackPayload(entry.track.clone()).reservoir_keys())
            .collect::<HashSet<_>>();
        let consumed = self
            .persisted
            .reservoir_consumed
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        self.reservoir_request_running = true;
        let spawn = thread::Builder::new()
            .name("tempo-audio-reservoir".into())
            .spawn(move || {
                let result = resolver::stored_feed_candidate(app, excluded, consumed);
                let _ = sender.send(ActorMessage::ReservoirReady(ReservoirMessage {
                    request_id,
                    result,
                }));
            });
        if let Err(error) = spawn {
            self.reservoir_request_running = false;
            self.current_error = Some(format!("could not query autoplay reservoir: {error}"));
            self.continuation = None;
            self.emit_state();
        }
    }

    fn invalidate_continuation(&mut self) {
        self.continuation = None;
        self.reservoir_request_running = false;
    }

    fn remember_consumed(&mut self, key: String) {
        if self
            .persisted
            .reservoir_consumed
            .iter()
            .any(|existing| existing == &key)
        {
            return;
        }
        self.persisted.reservoir_consumed.push(key);
        if self.persisted.reservoir_consumed.len() > RESERVOIR_LIMIT {
            let excess = self.persisted.reservoir_consumed.len() - RESERVOIR_LIMIT;
            self.persisted.reservoir_consumed.drain(0..excess);
        }
    }

    fn remember_track_consumed(&mut self, track: &Value) {
        for key in TrackPayload(track.clone()).reservoir_keys() {
            self.remember_consumed(key);
        }
    }

    fn merge_settings(&mut self, patch: &Value) -> Result<(), String> {
        let settings = self.merged_settings(patch)?;
        self.apply_settings(settings);
        Ok(())
    }

    fn merged_settings(&self, patch: &Value) -> Result<NativeSettings, String> {
        let mut settings = self.persisted.settings.clone();
        if let Some(value) = patch.get("volume").and_then(Value::as_f64) {
            settings.volume = value as f32;
        }
        if let Some(value) = patch.get("playbackRate").and_then(Value::as_f64) {
            settings.playback_rate = value as f32;
        }
        if let Some(value) = patch.get("preservePitch").and_then(Value::as_bool) {
            settings.preserve_pitch = value;
        }
        if let Some(value) = patch
            .get("repeat")
            .and_then(Value::as_str)
            .and_then(RepeatMode::parse)
        {
            settings.repeat = value;
        }
        if let Some(value) = patch.get("shuffle").and_then(Value::as_bool) {
            settings.shuffle = value;
        }
        if let Some(value) = patch.get("crossfadeSec").and_then(Value::as_f64) {
            settings.crossfade_sec = value;
        }
        if let Some(value) = patch.get("normalize").and_then(Value::as_bool) {
            settings.normalize = value;
        }
        if let Some(value) = patch.get("cacheBeforePlay").and_then(Value::as_bool) {
            settings.cache_before_play = value;
        }
        if let Some(value) = patch.get("ytdlpPath").and_then(Value::as_str) {
            settings.ytdlp_path = value.to_string();
        }
        if let Some(equalizer) = patch.get("equalizer") {
            if let Some(enabled) = equalizer.get("enabled").and_then(Value::as_bool) {
                settings.equalizer_enabled = enabled;
            }
            if let Some(bands) = equalizer.get("bands").and_then(Value::as_array) {
                if bands.len() != 10 {
                    return Err("equalizer must contain exactly 10 bands".into());
                }
                for (target, value) in settings.equalizer_gains.iter_mut().zip(bands.iter()) {
                    *target = value
                        .as_f64()
                        .filter(|value| value.is_finite())
                        .ok_or("equalizer band must be finite")?;
                }
            }
        }
        Ok(settings.normalized())
    }

    fn apply_settings(&mut self, settings: NativeSettings) {
        let shuffle_changed = settings.shuffle != self.persisted.settings.shuffle;
        let repeat_changed = settings.repeat != self.persisted.settings.repeat;
        if shuffle_changed || repeat_changed {
            self.invalidate_continuation();
        }
        if shuffle_changed || repeat_changed {
            self.invalidate_preload();
        }
        if shuffle_changed {
            self.persisted.queue.set_shuffled(settings.shuffle);
        }
        self.persisted.settings = settings;
        self.engine
            .configure(output_settings(&self.persisted.settings));
        if let Some(browser) = self.browser.as_ref() {
            if let Err(error) = browser
                .handle
                .configure(self.browser_settings(self.active_track.as_ref()))
            {
                self.current_error = Some(error);
            }
        }
        if let Some(track) = self.active_track.as_ref() {
            self.engine.set_track_gain(
                TrackPayload(track.clone()).gain_db(self.persisted.settings.normalize),
            );
        }
        self.listening.reanchor();
    }

    fn sample_listening(&mut self) {
        let playing = self.transport_is_playing()
            && !self.transport_buffering()
            && self.pending_start.is_none();
        let position = if self.active_entry_id.is_some() {
            self.transport_position()
        } else {
            self.last_position
        };
        self.last_position = finite_nonnegative(position);
        if playing {
            self.ensure_session();
        }
        self.listening.sample(
            position,
            self.transport_duration(),
            self.persisted.settings.playback_rate as f64,
            playing,
        );
    }

    fn sample_fading_listening(&mut self) {
        let Some((position, duration, outgoing_playing)) = self.engine.outgoing_clock() else {
            self.finish_fading_session("end");
            return;
        };
        let playing = outgoing_playing;
        if let Some(session) = self.fading_listening.as_mut() {
            session.sample(
                position,
                duration,
                self.persisted.settings.playback_rate as f64,
                playing,
            );
        }
    }

    fn finish_fading_session(&mut self, reason: &str) {
        if self.fading_listening.is_none() {
            return;
        }
        if let Some((position, duration, outgoing_playing)) = self.engine.outgoing_clock() {
            if let Some(session) = self.fading_listening.as_mut() {
                session.sample(
                    position,
                    duration,
                    self.persisted.settings.playback_rate as f64,
                    outgoing_playing,
                );
            }
        }
        if let Some(mut session) = self.fading_listening.take() {
            if let Some(event) = session.finish(reason) {
                self.listening_writer.record(event);
            }
        }
    }

    fn ensure_session(&mut self) {
        if self.listening.has_active() {
            return;
        }
        let Some(track) = self.active_track.as_ref() else {
            return;
        };
        let generation = self.listening_generation();
        if let Err(error) = self.listening.begin(track, &self.active_reason, generation) {
            eprintln!("[tempo native audio] could not start listening session: {error}");
        }
    }

    fn finish_session(&mut self, reason: &str) {
        let playing = self.transport_is_playing()
            && !self.transport_buffering()
            && self.pending_start.is_none();
        let position = if self.active_entry_id.is_some() {
            self.transport_position()
        } else {
            self.last_position
        };
        self.listening.sample(
            position,
            self.transport_duration(),
            self.persisted.settings.playback_rate as f64,
            playing,
        );
        if let Some(event) = self.listening.finish(reason) {
            self.listening_writer.record(event);
        }
        self.finish_fading_session(reason);
    }

    fn listening_generation(&self) -> i64 {
        self.db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT generation FROM recommendation_meta WHERE id=1",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| format!("recommendation database: {error}"))
            })
            .unwrap_or(0)
    }

    fn current_position(&self) -> f64 {
        if self.pending_start.is_some() {
            self.pending_start
                .as_ref()
                .map(|pending| pending.position)
                .unwrap_or(self.last_position)
        } else if self.active_entry_id.is_some() {
            self.transport_position()
        } else {
            self.last_position
        }
    }

    fn snapshot_value(&mut self) -> Result<Value, String> {
        self.version = self.version.wrapping_add(1);
        let track = self
            .persisted
            .queue
            .current()
            .map(|entry| entry.track.clone());
        let preparing = self.pending_start.is_some();
        let duration = track
            .as_ref()
            .and_then(|track| TrackPayload(track.clone()).duration())
            .or_else(|| self.transport_duration().filter(|value| *value > 0.0))
            .unwrap_or(0.0);
        let snapshot = PlayerSnapshot {
            current_track: track,
            queue: self.persisted.queue.tracks(),
            queue_index: self.persisted.queue.index(),
            is_playing: self
                .pending_start
                .as_ref()
                .map(|pending| pending.playing)
                .unwrap_or(self.playing_intent || self.transport_is_playing()),
            position: self.current_position(),
            duration,
            volume: self.persisted.settings.volume,
            playback_rate: self.persisted.settings.playback_rate,
            preserve_pitch: self.persisted.settings.preserve_pitch,
            repeat: self.persisted.settings.repeat,
            shuffle: self.persisted.settings.shuffle,
            buffer_pct: None,
            buffering: !preparing && self.transport_buffering(),
            preparing,
            version: self.version,
            error: self.current_error.clone(),
            initialized: self.persisted.initialized,
        };
        serde_json::to_value(snapshot).map_err(|error| error.to_string())
    }

    fn emit_state(&mut self) {
        let Ok(snapshot) = self.snapshot_value() else {
            return;
        };
        self.last_state_at = Instant::now();
        if let Err(error) = self.app.emit(STATE_EVENT, snapshot) {
            eprintln!("[tempo native audio] state event failed: {error}");
        }
    }

    fn emit_clock(&mut self) {
        self.version = self.version.wrapping_add(1);
        let track_duration = self
            .persisted
            .queue
            .current()
            .and_then(|entry| TrackPayload(entry.track.clone()).duration());
        let duration = track_duration
            .or_else(|| self.transport_duration().filter(|value| *value > 0.0))
            .unwrap_or(0.0);
        let payload = json!({
            "position": self.current_position(),
            "duration": duration,
            "isPlaying": self.pending_start.as_ref().map(|pending| pending.playing).unwrap_or(self.playing_intent || self.transport_is_playing()),
            "buffering": self.pending_start.is_none() && self.transport_buffering(),
            "version": self.version,
        });
        let _ = self.app.emit(CLOCK_EVENT, payload);
    }

    fn emit_spectrum(&self) {
        let bins: Vec<f64> = self
            .browser
            .as_ref()
            .map(|browser| browser.bins.clone())
            .unwrap_or_else(|| self.engine.spectrum().into_iter().map(f64::from).collect());
        if bins.len() != 64 {
            return;
        }
        let _ = self.app.emit(FFT_EVENT, bins);
    }

    fn emit_analysis(&self) {
        let Some(frame) = self.engine.analysis() else {
            return;
        };
        if frame.frequency_bins.len() != 512 {
            return;
        }
        let Ok(mut payload) = serde_json::to_value(frame) else {
            return;
        };
        let Some(object) = payload.as_object_mut() else {
            return;
        };
        object.insert(
            "position".into(),
            json!(finite_nonnegative(self.transport_position())),
        );
        if let Err(error) = self.app.emit(ANALYSIS_EVENT, payload) {
            eprintln!("[tempo native audio] analysis event failed: {error}");
        }
    }

    fn update_spectrum_capture(&mut self) {
        self.engine
            .set_spectrum_enabled((self.spectrum_enabled || self.analysis_enabled) && self.visible);
        if let Some(browser) = self.browser.as_ref() {
            if let Err(error) = browser
                .handle
                .configure(self.browser_settings(self.active_track.as_ref()))
            {
                self.current_error = Some(error);
            }
        }
    }

    fn persist_now(&mut self) {
        self.persisted.position = finite_nonnegative(self.current_position());
        self.persistence.save(self.persisted.clone());
        self.last_position_persist = Instant::now();
    }
}

fn parse_tracks(value: Option<&Value>) -> Result<Vec<Value>, String> {
    let tracks = value
        .and_then(Value::as_array)
        .ok_or("tracks must be an array")?;
    if tracks.len() > super::models::MAX_QUEUE_ITEMS {
        return Err(format!(
            "queue exceeds {} tracks",
            super::models::MAX_QUEUE_ITEMS
        ));
    }
    tracks
        .iter()
        .cloned()
        .map(|track| TrackPayload::parse(track).map(|track| track.0))
        .collect()
}

fn same_identity(left: &Value, right: &Value) -> bool {
    TrackPayload(left.clone()).identity_key() == TrackPayload(right.clone()).identity_key()
}

fn output_settings(settings: &NativeSettings) -> OutputSettings {
    OutputSettings {
        volume: settings.volume,
        playback_rate: settings.playback_rate,
        preserve_pitch: settings.preserve_pitch,
        equalizer_enabled: settings.equalizer_enabled,
        equalizer_gains: settings.equalizer_gains,
    }
}

fn finite_nonnegative(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}
