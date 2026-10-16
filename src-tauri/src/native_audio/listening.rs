use crate::database::Db;
use crate::recommendation_store::{self, ListeningEvent, Provenance, RecommendationTrack};
use serde_json::Value;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::models::TrackPayload;

const CHECKPOINT_INTERVAL_MS: i64 = 5_000;
const MAX_COVERAGE_INTERVALS: usize = 2048;

#[derive(Debug, Clone, Copy)]
struct PlaybackAnchor {
    position: f64,
    at_ms: i64,
    rate: f64,
}

struct ActiveSession {
    event: ListeningEvent,
    anchor: Option<PlaybackAnchor>,
    intervals: Vec<(f64, f64)>,
    last_checkpoint_at: i64,
}

pub struct ListeningAccumulator {
    active: Option<ActiveSession>,
}

impl Default for ListeningAccumulator {
    fn default() -> Self {
        Self { active: None }
    }
}

impl ListeningAccumulator {
    pub fn begin(&mut self, payload: &Value, reason: &str, generation: i64) -> Result<(), String> {
        let track = TrackPayload(payload.clone());
        let metadata = recommendation_track(&track)?;
        let now = now_ms();
        self.active = Some(ActiveSession {
            event: ListeningEvent {
                id: session_id(now),
                revision: 0,
                track_key: metadata.track_key.clone(),
                track: metadata.clone(),
                start_reason: valid_reason(reason).to_string(),
                started_at: now,
                elapsed_sec: 0.0,
                covered_sec: 0.0,
                duration_sec: metadata.duration_sec,
                playback_rate: 1.0,
                end_reason: None,
                finished: false,
                generation,
            },
            anchor: None,
            intervals: Vec::new(),
            last_checkpoint_at: now,
        });
        Ok(())
    }

    /// Samples only source-clock movement while audio is actually advancing.
    /// Seeking or buffering clears the anchor, so it cannot invent coverage.
    pub fn sample(
        &mut self,
        position: f64,
        duration: Option<f64>,
        playback_rate: f64,
        playing: bool,
    ) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        if !playing
            || !position.is_finite()
            || position < 0.0
            || !playback_rate.is_finite()
            || playback_rate <= 0.0
        {
            active.anchor = None;
            return;
        }
        let now = now_ms();
        if let Some(duration) = duration.filter(|value| value.is_finite() && *value >= 0.0) {
            active.event.duration_sec = Some(duration);
            active.event.track.duration_sec = Some(duration);
        }
        if let Some(previous) = active.anchor {
            let wall = (now - previous.at_ms) as f64 / 1000.0;
            let advance = position - previous.position;
            if wall > 0.0 && advance > 0.0 && advance <= wall * previous.rate + 0.35 {
                active.event.elapsed_sec += wall.min(advance / previous.rate);
                add_interval(
                    &mut active.intervals,
                    previous.position,
                    position,
                    active.event.duration_sec,
                );
                active.event.covered_sec = active
                    .intervals
                    .iter()
                    .map(|(start, end)| end - start)
                    .sum();
            }
        }
        active.event.playback_rate = playback_rate;
        active.anchor = Some(PlaybackAnchor {
            position,
            at_ms: now,
            rate: playback_rate,
        });
    }

    pub fn reanchor(&mut self) {
        if let Some(active) = self.active.as_mut() {
            active.anchor = None;
        }
    }

    pub fn update_metadata(&mut self, payload: &Value) -> Result<(), String> {
        let metadata = recommendation_track(&TrackPayload(payload.clone()))?;
        let Some(active) = self.active.as_mut() else {
            return Ok(());
        };
        if active.event.track_key == metadata.track_key {
            active.event.track = metadata.clone();
            if metadata.duration_sec.is_some() {
                active.event.duration_sec = metadata.duration_sec;
            }
        }
        Ok(())
    }

    pub fn checkpoint_if_due(&mut self) -> Option<ListeningEvent> {
        let active = self.active.as_mut()?;
        let now = now_ms();
        if active.event.elapsed_sec <= 0.0
            || now - active.last_checkpoint_at < CHECKPOINT_INTERVAL_MS
        {
            return None;
        }
        active.last_checkpoint_at = now;
        active.event.revision += 1;
        Some(active.event.clone())
    }

    pub fn finish(&mut self, reason: &str) -> Option<ListeningEvent> {
        let mut active = self.active.take()?;
        if active.event.elapsed_sec <= 0.0 {
            return None;
        }
        active.event.revision += 1;
        active.event.end_reason = Some(valid_end_reason(reason).to_string());
        active.event.finished = true;
        active.anchor = None;
        Some(active.event)
    }

    pub fn has_active(&self) -> bool {
        self.active.is_some()
    }
}

fn recommendation_track(track: &TrackPayload) -> Result<RecommendationTrack, String> {
    let source = track
        .string("source")
        .ok_or("track source is missing")?
        .to_string();
    let source_id = if source == "local" {
        track
            .0
            .get("dbId")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0)
            .map(|id| id.to_string())
            .unwrap_or_else(|| track.source_id().to_string())
    } else {
        track.source_id().to_string()
    };
    let track_key = format!("{source}:{source_id}");
    let artists = track
        .0
        .get("artists")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .take(16)
                .map(|value| value.to_string())
                .collect()
        })
        .unwrap_or_default();
    let provenance = track
        .0
        .get("provenance")
        .cloned()
        .and_then(|value| serde_json::from_value::<Provenance>(value).ok());
    Ok(RecommendationTrack {
        traits: track.0.get("traits").cloned().filter(Value::is_object),
        track_key,
        source,
        source_id,
        db_id: track
            .0
            .get("dbId")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0),
        title: track
            .string("title")
            .unwrap_or_default()
            .chars()
            .take(1024)
            .collect(),
        artists,
        album: track
            .0
            .get("album")
            .and_then(Value::as_str)
            .map(str::to_string),
        duration_sec: track.duration(),
        cover_path: track
            .0
            .get("coverPath")
            .and_then(Value::as_str)
            .map(str::to_string),
        external_url: track
            .0
            .get("externalUrl")
            .and_then(Value::as_str)
            .map(str::to_string),
        provenance,
    })
}

fn add_interval(
    intervals: &mut Vec<(f64, f64)>,
    mut start: f64,
    mut end: f64,
    duration: Option<f64>,
) {
    if let Some(duration) = duration.filter(|value| *value > 0.0) {
        end = end.min(duration);
    }
    if end <= start {
        return;
    }
    let previous = std::mem::take(intervals);
    let mut merged = Vec::with_capacity(previous.len().min(MAX_COVERAGE_INTERVALS) + 1);
    for (left, right) in previous.iter().copied() {
        if right < start {
            merged.push((left, right));
        } else if end < left {
            merged.push((start, end));
            start = left;
            end = right;
        } else {
            start = start.min(left);
            end = end.max(right);
        }
    }
    merged.push((start, end));
    // Keep the same conservative bound as the renderer accumulator. If the
    // user seeks through thousands of fragments, do not merge unseen gaps.
    if merged.len() <= MAX_COVERAGE_INTERVALS {
        *intervals = merged;
    } else {
        *intervals = previous;
    }
}

fn valid_reason(reason: &str) -> &str {
    match reason {
        "manual" | "queue" | "autoplay" | "repeat" | "restore" => reason,
        _ => "queue",
    }
}

fn valid_end_reason(reason: &str) -> &str {
    match reason {
        "select" | "next" | "previous" | "clear" | "end" | "error" | "exit" | "remove" | "stop" => {
            reason
        }
        _ => "stop",
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn session_id(now: i64) -> String {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("native:{now}:{sequence}")
}

enum WriterMessage {
    Record(ListeningEvent),
    Flush(SyncSender<Result<(), String>>),
    Stop,
}

/// Serializes writes to the existing recommendation/listening store off the
/// audio actor. Its FIFO queue preserves revisions for each session.
pub struct ListeningWriter {
    sender: Option<Sender<WriterMessage>>,
    worker: Option<JoinHandle<()>>,
}

impl ListeningWriter {
    pub fn new(db: std::sync::Arc<Db>) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("tempo-native-listening".into())
            .spawn(move || run_writer(db, receiver))
            .map_err(|error| format!("could not start native listening writer: {error}"))?;
        Ok(Self {
            sender: Some(sender),
            worker: Some(worker),
        })
    }

    pub fn record(&self, event: ListeningEvent) {
        if let Some(sender) = &self.sender {
            if sender.send(WriterMessage::Record(event)).is_err() {
                eprintln!("[tempo native audio] listening writer is unavailable");
            }
        }
    }

    pub fn flush(&self) -> Result<(), String> {
        let Some(sender) = &self.sender else {
            return Ok(());
        };
        let (ack, result) = mpsc::sync_channel(1);
        sender
            .send(WriterMessage::Flush(ack))
            .map_err(|error| error.to_string())?;
        result
            .recv_timeout(Duration::from_millis(900))
            .map_err(|error| format!("history flush timed out: {error}"))?
    }
}

impl Drop for ListeningWriter {
    fn drop(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(WriterMessage::Stop);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run_writer(db: std::sync::Arc<Db>, receiver: Receiver<WriterMessage>) {
    let mut last_error = None;
    while let Ok(message) = receiver.recv() {
        match message {
            WriterMessage::Record(event) => {
                if let Err(error) = recommendation_store::record(&db, event) {
                    // A queued checkpoint can cross the user's clear-history
                    // boundary before the actor receives its generation event.
                    // The store rejects that stale generation intentionally.
                    if error != "Listening history was cleared" {
                        eprintln!("[tempo native audio] listening history write failed: {error}");
                        last_error = Some(error);
                    }
                }
            }
            WriterMessage::Flush(ack) => {
                let _ = ack.send(last_error.take().map_or(Ok(()), Err));
            }
            WriterMessage::Stop => break,
        }
    }
}
