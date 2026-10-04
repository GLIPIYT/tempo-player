//! Conservative acoustic confirmation for files that already exist locally.
//! No path, URL, download, or candidate-library write is accepted from the UI.
use crate::database::Db;
use crate::lyric_analysis;
use crate::recommendation_store::{self, FeatureSectionUpdate};
use rusqlite::{params, OptionalExtension};
use rusty_chromaprint::{match_fingerprints, Configuration, Fingerprinter};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};
use tauri::State;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const AUDIO_MIGRATION: &str = r#"
CREATE TABLE recommendation_audio_fingerprints (
 track_key TEXT PRIMARY KEY,
 file_identity TEXT NOT NULL,
 algorithm_version TEXT NOT NULL,
 content_hash TEXT,
 fingerprint_json TEXT,
 sampled_sec REAL NOT NULL,
 signal_sec REAL NOT NULL,
 duration_sec REAL,
 version_key TEXT NOT NULL,
 supported INTEGER NOT NULL CHECK(supported IN (0,1)),
 updated_at INTEGER NOT NULL
);
CREATE INDEX idx_recommendation_audio_match
 ON recommendation_audio_fingerprints(algorithm_version,version_key,duration_sec,updated_at DESC)
 WHERE supported=1 AND fingerprint_json IS NOT NULL;
CREATE INDEX idx_recommendation_audio_content
 ON recommendation_audio_fingerprints(algorithm_version,version_key,content_hash,updated_at DESC)
 WHERE supported=1 AND content_hash IS NOT NULL;
"#;

const ALGORITHM_VERSION: &str = "chromaprint-test2-symphonia-0.5.5-v1";
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DURATION_SEC: f64 = 6.0 * 60.0 * 60.0;
const MAX_DECODE_SEC: f64 = 90.0;
const MIN_SIGNAL_SEC: f64 = 30.0;
const MAX_SAMPLE_RATE: u32 = 96_000;
const MAX_CHANNELS: usize = 8;
const MAX_PACKET_BYTES: usize = 512 * 1024;
const MAX_PACKET_COUNT: usize = 30_000;
const MAX_PACKET_FRAMES: u64 = 480_000;
const MAX_FINGERPRINT_ITEMS: usize = 4096;
const MAX_STORED_FINGERPRINT_BYTES: usize = 24 * 1024;
const MATCH_CANDIDATE_LIMIT: usize = 192;
const MAX_MATCH_SCORE: f64 = 2.0;
const MIN_MATCH_COVERAGE: f64 = 0.65;
const MAX_WORK_TIME: Duration = Duration::from_secs(20);
const RETAINED_FINGERPRINTS: i64 = 5000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRecordingFeature {
    pub file_identity: String,
    pub algorithm_version: String,
    pub sampled_sec: f64,
    pub duration_sec: Option<f64>,
    pub version_key: String,
    pub supported: bool,
    pub match_group: Option<String>,
}

#[derive(Clone)]
struct FingerprintRow {
    track_key: String,
    file_identity: String,
    algorithm_version: String,
    content_hash: Option<String>,
    fingerprint: Option<Vec<u32>>,
    sampled_sec: f64,
    signal_sec: f64,
    duration_sec: Option<f64>,
    version_key: String,
    supported: bool,
}

struct DecodedAudio {
    supported: bool,
    fingerprint: Option<Vec<u32>>,
    content_hash: Option<String>,
    sampled_sec: f64,
    signal_sec: f64,
}

pub struct RecommendationAudioStore {
    db: Arc<Db>,
    sc_root: PathBuf,
    yt_root: PathBuf,
    permit: Arc<Semaphore>,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    cancelled_jobs: Mutex<HashSet<String>>,
}

impl RecommendationAudioStore {
    pub fn new(db: Arc<Db>, sc_root: PathBuf, yt_root: PathBuf) -> Self {
        Self {
            db,
            sc_root,
            yt_root,
            permit: Arc::new(Semaphore::new(1)),
            jobs: Mutex::new(std::collections::HashMap::new()),
            cancelled_jobs: Mutex::new(HashSet::new()),
        }
    }

    fn begin_job(&self, id: &str, cancel: Arc<AtomicBool>) -> Result<bool, String> {
        let mut jobs = self.jobs.lock().map_err(|_| "audio job mutex poisoned")?;
        if jobs.contains_key(id) || !jobs.is_empty() {
            return Ok(false);
        }
        // Keep the check and active-job insertion behind the same lock used by
        // cancel_job, so an IPC cancel arriving just before registration wins.
        let mut cancelled = self
            .cancelled_jobs
            .lock()
            .map_err(|_| "audio cancellation mutex poisoned")?;
        if cancelled.remove(id) {
            return Ok(false);
        }
        jobs.insert(id.to_owned(), cancel);
        Ok(true)
    }

    fn end_job(&self, id: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(id);
        }
    }

    fn cancel_job(&self, id: &str) {
        if let Ok(jobs) = self.jobs.lock() {
            if let Some(cancel) = jobs.get(id) {
                cancel.store(true, Ordering::Relaxed);
            } else if let Ok(mut cancelled) = self.cancelled_jobs.lock() {
                // Cancellation IDs are untrusted IPC input. Keep pre-registration
                // tombstones small in case a caller sends IDs that never start.
                if cancelled.len() >= 64 {
                    cancelled.clear();
                }
                cancelled.insert(id.to_owned());
            }
        }
    }

    fn resolve_path(
        &self,
        track_id: Option<i64>,
        source: &str,
        source_id: &str,
    ) -> Result<Option<PathBuf>, String> {
        match source {
            "local" => {
                let Some(id) = track_id else { return Ok(None) };
                if id <= 0 || source_id.parse::<i64>().ok() != Some(id) {
                    return Ok(None);
                }
                let Some(track) = self.db.lyrics_analysis_track(Some(id), "local", None)? else {
                    return Ok(None);
                };
                if track.source != "local" || track.id != id {
                    return Ok(None);
                }
                Ok(Path::new(&track.path)
                    .is_file()
                    .then(|| PathBuf::from(track.path)))
            }
            "soundcloud" => {
                lyric_analysis::validate_source_id(source, source_id)?;
                if let Some(id) = track_id {
                    let registered =
                        self.db
                            .lyrics_analysis_track(Some(id), source, Some(source_id))?;
                    if registered.as_ref().is_some_and(|track| {
                        track.source != source || track.source_id.as_deref() != Some(source_id)
                    }) {
                        return Ok(None);
                    }
                }
                crate::soundcloud_store::existing_cached_file(&self.db, &self.sc_root, source_id)
            }
            "youtube" => {
                lyric_analysis::validate_source_id(source, source_id)?;
                if let Some(id) = track_id {
                    let registered =
                        self.db
                            .lyrics_analysis_track(Some(id), source, Some(source_id))?;
                    if registered.as_ref().is_some_and(|track| {
                        track.source != source || track.source_id.as_deref() != Some(source_id)
                    }) {
                        return Ok(None);
                    }
                }
                lyric_analysis::existing_youtube_file(&self.yt_root, source_id)
            }
            _ => Err("unsupported audio source".into()),
        }
    }

    fn resolve_key(&self, key: &str) -> Result<Option<(PathBuf, String)>, String> {
        let Some((source, source_id)) = key.split_once(':') else {
            return Ok(None);
        };
        let track_id = if source == "local" {
            match source_id.parse::<i64>() {
                Ok(id) if id > 0 => Some(id),
                _ => return Ok(None),
            }
        } else {
            None
        };
        let Some(path) = self.resolve_path(track_id, source, source_id)? else {
            return Ok(None);
        };
        let Some((absolute_path, identity)) = lyric_analysis::trusted_file_identity(&path)? else {
            return Ok(None);
        };
        Ok(Some((PathBuf::from(absolute_path), identity)))
    }

    fn cached(
        &self,
        track_key: &str,
        file_identity: &str,
    ) -> Result<Option<FingerprintRow>, String> {
        self.db.with_conn(|conn| {
            conn.query_row(
                "SELECT track_key,file_identity,algorithm_version,content_hash,fingerprint_json,sampled_sec,signal_sec,duration_sec,version_key,supported,updated_at FROM recommendation_audio_fingerprints WHERE track_key=?1 AND file_identity=?2 AND algorithm_version=?3",
                params![track_key,file_identity,ALGORITHM_VERSION],
                |row| {
                    let encoded: Option<String> = row.get(4)?;
                    let fingerprint = encoded.and_then(|text| serde_json::from_str::<Vec<u32>>(&text).ok());
                    Ok(FingerprintRow {
                        track_key: row.get(0)?, file_identity: row.get(1)?, algorithm_version: row.get(2)?,
                        content_hash: row.get(3)?, fingerprint, sampled_sec: row.get(5)?, signal_sec: row.get(6)?,
                        duration_sec: row.get(7)?, version_key: row.get(8)?, supported: row.get::<_,i64>(9)? == 1,
                    })
                },
            ).optional().map_err(|error| format!("recommendation audio cache: {error}"))
        })
    }

    fn possible_matches(&self, current: &FingerprintRow) -> Result<Vec<FingerprintRow>, String> {
        let Some(duration) = current.duration_sec else {
            return Ok(Vec::new());
        };
        if !current.supported
            || current.fingerprint.is_none()
            || current.signal_sec < MIN_SIGNAL_SEC
            || current.version_key == "unknown"
        {
            return Ok(Vec::new());
        }
        self.db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT track_key,file_identity,algorithm_version,content_hash,fingerprint_json,sampled_sec,signal_sec,duration_sec,version_key,supported,updated_at FROM recommendation_audio_fingerprints WHERE algorithm_version=?1 AND version_key=?2 AND supported=1 AND fingerprint_json IS NOT NULL AND duration_sec IS NOT NULL AND track_key<>?3 AND abs(duration_sec-?4)<=MAX(2.0,MIN(duration_sec,?4)*0.01) ORDER BY CASE WHEN content_hash=?6 THEN 0 ELSE 1 END,updated_at DESC LIMIT ?5",
            ).map_err(|error| format!("recommendation audio cache: {error}"))?;
            let mapped = statement.query_map(params![ALGORITHM_VERSION,current.version_key,current.track_key,duration,MATCH_CANDIDATE_LIMIT as i64,current.content_hash], |row| {
                let encoded: Option<String> = row.get(4)?;
                let fingerprint = encoded.and_then(|text| {
                    if text.len() > MAX_STORED_FINGERPRINT_BYTES { return None; }
                    serde_json::from_str::<Vec<u32>>(&text).ok().filter(|values| !values.is_empty() && values.len() <= MAX_FINGERPRINT_ITEMS)
                });
                Ok(FingerprintRow {
                    track_key: row.get(0)?, file_identity: row.get(1)?, algorithm_version: row.get(2)?,
                    content_hash: row.get(3)?, fingerprint, sampled_sec: row.get(5)?, signal_sec: row.get(6)?,
                    duration_sec: row.get(7)?, version_key: row.get(8)?, supported: row.get::<_,i64>(9)? == 1,
                })
            }).map_err(|error| format!("recommendation audio cache: {error}"))?;
            let mut rows = Vec::new();
            for row in mapped {
                let candidate = row.map_err(|error| format!("recommendation audio cache: {error}"))?;
                if candidate.fingerprint.is_some() { rows.push(candidate); }
            }
            Ok(rows)
        })
    }

    fn remove_stale_record(&self, track_key: &str, file_identity: &str) {
        let _ = self.db.with_conn(|conn| {
            conn.execute("DELETE FROM recommendation_audio_fingerprints WHERE track_key=?1 AND file_identity=?2", params![track_key,file_identity])
                .map(|_| ()).map_err(|error| error.to_string())
        });
    }

    fn confirmed_match(
        &self,
        current: &FingerprintRow,
        cancel: &AtomicBool,
    ) -> Result<Option<String>, String> {
        let Some(fingerprint) = current.fingerprint.as_deref() else {
            return Ok(None);
        };
        let config = Configuration::preset_test2();
        let mut matches = Vec::new();
        for candidate in self.possible_matches(current)? {
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            if candidate.version_key != current.version_key
                || candidate.algorithm_version != current.algorithm_version
            {
                continue;
            }
            let (Some(duration), Some(previous_duration), Some(previous)) = (
                current.duration_sec,
                candidate.duration_sec,
                candidate.fingerprint.as_deref(),
            ) else {
                continue;
            };
            if (duration - previous_duration).abs()
                > (2.0_f64).max(duration.min(previous_duration) * 0.01)
            {
                continue;
            }
            if let Ok(segments) = match_fingerprints(fingerprint, previous, &config) {
                if let Some((seconds, score)) = segments
                    .into_iter()
                    .map(|segment| (f64::from(segment.duration(&config)), segment.score))
                    .filter(|(seconds, score)| {
                        *seconds >= MIN_SIGNAL_SEC
                            && *score <= MAX_MATCH_SCORE
                            && *seconds / current.sampled_sec.min(candidate.sampled_sec).max(1.0)
                                >= MIN_MATCH_COVERAGE
                    })
                    .max_by(|a, b| a.0.total_cmp(&b.0).then_with(|| b.1.total_cmp(&a.1)))
                {
                    matches.push((seconds, score, candidate));
                }
            }
        }
        matches.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.total_cmp(&b.1)));
        for (_, _, candidate) in matches.into_iter().take(8) {
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            match self.resolve_key(&candidate.track_key)? {
                Some((_, identity)) if identity == candidate.file_identity => {
                    return Ok(Some(candidate.track_key));
                }
                _ => self.remove_stale_record(&candidate.track_key, &candidate.file_identity),
            }
        }
        Ok(None)
    }

    fn persist(&self, record: &FingerprintRow, match_group: Option<&str>) -> Result<(), String> {
        let encoded_fingerprint = record
            .fingerprint
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| e.to_string())?;
        if encoded_fingerprint
            .as_ref()
            .is_some_and(|value| value.len() > MAX_STORED_FINGERPRINT_BYTES)
        {
            return Err("Audio fingerprint exceeds storage limit".into());
        }
        let updated_at = now_ms();
        self.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction().map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO recommendation_audio_fingerprints(track_key,file_identity,algorithm_version,content_hash,fingerprint_json,sampled_sec,signal_sec,duration_sec,version_key,supported,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(track_key) DO UPDATE SET file_identity=excluded.file_identity,algorithm_version=excluded.algorithm_version,content_hash=excluded.content_hash,fingerprint_json=excluded.fingerprint_json,sampled_sec=excluded.sampled_sec,signal_sec=excluded.signal_sec,duration_sec=excluded.duration_sec,version_key=excluded.version_key,supported=excluded.supported,updated_at=excluded.updated_at",
                params![record.track_key,record.file_identity,record.algorithm_version,record.content_hash,encoded_fingerprint,record.sampled_sec,record.signal_sec,record.duration_sec,record.version_key,if record.supported {1_i64}else{0_i64},updated_at],
            ).map_err(|error| format!("recommendation audio cache: {error}"))?;
            tx.execute(
                "DELETE FROM recommendation_audio_fingerprints WHERE track_key NOT IN (SELECT track_key FROM recommendation_audio_fingerprints ORDER BY updated_at DESC,track_key LIMIT ?1)",
                [RETAINED_FINGERPRINTS],
            ).map_err(|error| format!("recommendation audio cache: {error}"))?;
            let old_audio_at: i64 = tx.query_row(
                "SELECT COALESCE(json_extract(data_json,'$.sectionUpdatedAt.audio'),0) FROM recommendation_features WHERE track_key=?1",
                [&record.track_key], |row| row.get(0),
            ).optional().map_err(|error| error.to_string())?.unwrap_or(0);
            let feature_data = json!({
                "fileIdentity": record.file_identity,
                "algorithmVersion": record.algorithm_version,
                "contentHash": record.content_hash,
                "sampledSec": record.sampled_sec,
                "signalSec": record.signal_sec,
                "durationSec": record.duration_sec,
                "versionKey": record.version_key,
                "supported": record.supported,
                "hasFingerprint": record.fingerprint.is_some(),
                "matchGroup": match_group,
            });
            recommendation_store::merge_feature_section_conn(&tx, FeatureSectionUpdate {
                track_key: record.track_key.clone(), section: "audio".into(), data: feature_data,
                updated_at: updated_at.max(old_audio_at.saturating_add(1)),
            })?;
            tx.execute("DELETE FROM recommendation_features WHERE track_key NOT IN (SELECT track_key FROM recommendation_features ORDER BY updated_at DESC LIMIT 5000)", [])
                .map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())
        })
    }

    fn analyze(
        &self,
        track_id: Option<i64>,
        source: &str,
        source_id: &str,
        duration_sec: Option<f64>,
        version_key: &str,
        cancel: &AtomicBool,
    ) -> Result<Option<AudioRecordingFeature>, String> {
        validate_request(track_id, source, source_id, duration_sec, version_key)?;
        let track_key = format!("{source}:{source_id}");
        let Some(path) = self.resolve_path(track_id, source, source_id)? else {
            return Ok(None);
        };
        let Some((absolute_path, file_identity)) = lyric_analysis::trusted_file_identity(&path)?
        else {
            return Ok(None);
        };
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let cached = self.cached(&track_key, &file_identity)?;
        let mut row = if let Some(mut record) = cached {
            record.version_key = version_key.to_owned();
            record.duration_sec = duration_sec.or(record.duration_sec);
            record
        } else {
            let decoded = decode_fingerprint(&PathBuf::from(&absolute_path), cancel)?;
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            let Some((_, current_identity)) = lyric_analysis::trusted_file_identity(&path)? else {
                return Ok(None);
            };
            if current_identity != file_identity {
                return Ok(None);
            }
            FingerprintRow {
                track_key: track_key.clone(),
                file_identity: file_identity.clone(),
                algorithm_version: ALGORITHM_VERSION.into(),
                content_hash: decoded.content_hash,
                fingerprint: decoded.fingerprint,
                sampled_sec: decoded.sampled_sec,
                signal_sec: decoded.signal_sec,
                duration_sec,
                version_key: version_key.into(),
                supported: decoded.supported,
            }
        };
        // Damaged persisted JSON cannot be trusted as a matching signature.
        if row
            .fingerprint
            .as_ref()
            .is_some_and(|fp| fp.is_empty() || fp.len() > MAX_FINGERPRINT_ITEMS)
        {
            row.fingerprint = None;
        }
        let match_group = self.confirmed_match(&row, cancel)?;
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        // Re-resolve and restamp even cache hits: the file may have been
        // replaced while matching, and must not create an alias for stale audio.
        let Some(final_path) = self.resolve_path(track_id, source, source_id)? else {
            return Ok(None);
        };
        let Some((_, final_identity)) = lyric_analysis::trusted_file_identity(&final_path)? else {
            return Ok(None);
        };
        if final_identity != file_identity {
            return Ok(None);
        }
        self.persist(&row, match_group.as_deref())?;
        Ok(Some(AudioRecordingFeature {
            file_identity: row.file_identity,
            algorithm_version: row.algorithm_version,
            sampled_sec: row.sampled_sec,
            duration_sec: row.duration_sec,
            version_key: row.version_key,
            supported: row.supported,
            match_group,
        }))
    }
}

#[tauri::command]
pub async fn recommendation_audio_feature(
    state: State<'_, Arc<RecommendationAudioStore>>,
    job_id: String,
    track_id: Option<i64>,
    source: String,
    source_id: String,
    duration_sec: Option<f64>,
    version_key: String,
) -> Result<Option<AudioRecordingFeature>, String> {
    let store = state.inner().clone();
    validate_job_id(&job_id)?;
    validate_request(track_id, &source, &source_id, duration_sec, &version_key)?;
    let permit = match store.permit.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return Ok(None),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    if !store.begin_job(&job_id, cancel.clone())? {
        return Ok(None);
    }
    let job_store = store.clone();
    let source_for_job = source.clone();
    let source_id_for_job = source_id.clone();
    let version_for_job = version_key.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _permit: OwnedSemaphorePermit = permit;
        job_store.analyze(
            track_id,
            &source_for_job,
            &source_id_for_job,
            duration_sec,
            &version_for_job,
            &cancel,
        )
    })
    .await;
    store.end_job(&job_id);
    result.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_recommendation_audio_feature(
    state: State<'_, Arc<RecommendationAudioStore>>,
    job_id: String,
) -> Result<(), String> {
    validate_job_id(&job_id)?;
    state.cancel_job(&job_id);
    Ok(())
}

fn validate_job_id(job_id: &str) -> Result<(), String> {
    if job_id.is_empty()
        || job_id.len() > 96
        || !job_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))
    {
        return Err("Invalid recommendation audio job ID".into());
    }
    Ok(())
}

fn validate_request(
    track_id: Option<i64>,
    source: &str,
    source_id: &str,
    duration_sec: Option<f64>,
    version_key: &str,
) -> Result<(), String> {
    if !matches!(source, "local" | "soundcloud" | "youtube")
        || source_id.is_empty()
        || source_id.len() > 32
    {
        return Err("Invalid recommendation audio track identity".into());
    }
    if track_id.is_some_and(|id| id <= 0) {
        return Err("Invalid recommendation audio track ID".into());
    }
    if source == "local" {
        if track_id.is_none() || source_id.parse::<i64>().ok() != track_id {
            return Err("Invalid local recommendation audio identity".into());
        }
    } else {
        lyric_analysis::validate_source_id(source, source_id)?;
    }
    if duration_sec.is_some_and(|duration| {
        !duration.is_finite() || duration <= 0.0 || duration > MAX_DURATION_SEC
    }) {
        return Err("Invalid recommendation audio duration".into());
    }
    if version_key.is_empty()
        || version_key.len() > 128
        || !version_key.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'|')
        })
    {
        return Err("Invalid recommendation audio version key".into());
    }
    Ok(())
}

fn decode_fingerprint(path: &Path, cancel: &AtomicBool) -> Result<DecodedAudio, String> {
    let started = Instant::now();
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
        return Ok(DecodedAudio {
            supported: false,
            fingerprint: None,
            content_hash: None,
            sampled_sec: 0.0,
            signal_sec: 0.0,
        });
    }
    let stream = MediaSourceStream::new(
        Box::new(File::open(path).map_err(|error| error.to_string())?),
        Default::default(),
    );
    let probed = match get_probe().format(
        &Hint::new(),
        stream,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) {
        Ok(probed) => probed,
        Err(_) => {
            return Ok(DecodedAudio {
                supported: false,
                fingerprint: None,
                content_hash: None,
                sampled_sec: 0.0,
                signal_sec: 0.0,
            })
        }
    };
    let mut format = probed.format;
    let Some(track) = format.default_track() else {
        return Ok(DecodedAudio {
            supported: false,
            fingerprint: None,
            content_hash: None,
            sampled_sec: 0.0,
            signal_sec: 0.0,
        });
    };
    let stream_id = track.id;
    let codec_params = track.codec_params.clone();
    let Some(rate) = codec_params
        .sample_rate
        .filter(|rate| *rate > 0 && *rate <= MAX_SAMPLE_RATE)
    else {
        return Ok(DecodedAudio {
            supported: false,
            fingerprint: None,
            content_hash: None,
            sampled_sec: 0.0,
            signal_sec: 0.0,
        });
    };
    let Some(channels) = codec_params
        .channels
        .map(|channels| channels.count())
        .filter(|channels| *channels > 0 && *channels <= MAX_CHANNELS)
    else {
        return Ok(DecodedAudio {
            supported: false,
            fingerprint: None,
            content_hash: None,
            sampled_sec: 0.0,
            signal_sec: 0.0,
        });
    };
    if codec_params
        .max_frames_per_packet
        .is_some_and(|frames| frames > MAX_PACKET_FRAMES)
    {
        return Ok(DecodedAudio {
            supported: false,
            fingerprint: None,
            content_hash: None,
            sampled_sec: 0.0,
            signal_sec: 0.0,
        });
    }
    let mut decoder = match get_codecs().make(&codec_params, &DecoderOptions::default()) {
        Ok(decoder) => decoder,
        Err(_) => {
            return Ok(DecodedAudio {
                supported: false,
                fingerprint: None,
                content_hash: None,
                sampled_sec: 0.0,
                signal_sec: 0.0,
            })
        }
    };
    let output_channels = if channels == 1 { 1_usize } else { 2_usize };
    let max_frames = (f64::from(rate) * MAX_DECODE_SEC) as u64;
    let config = Configuration::preset_test2();
    let mut fingerprinter = Fingerprinter::new(&config);
    if fingerprinter.start(rate, output_channels as u32).is_err() {
        return Ok(DecodedAudio {
            supported: false,
            fingerprint: None,
            content_hash: None,
            sampled_sec: 0.0,
            signal_sec: 0.0,
        });
    }
    let mut content_hash = Sha256::new();
    content_hash.update(ALGORITHM_VERSION.as_bytes());
    let mut total_frames = 0_u64;
    let mut signal_sec = 0.0_f64;
    let window_frames = (rate / 10).max(1) as usize;
    let mut window_count = 0_usize;
    let mut window_energy = 0.0_f64;
    let mut packet_count = 0_usize;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        if started.elapsed() > MAX_WORK_TIME {
            return Err("recommendation audio analysis exceeded its time budget".into());
        }
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(DecodeError::IoError(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
                break
            }
            Err(DecodeError::ResetRequired) => break,
            Err(_) => break,
        };
        packet_count += 1;
        if packet_count > MAX_PACKET_COUNT || packet.data.len() > MAX_PACKET_BYTES {
            return Ok(DecodedAudio {
                supported: false,
                fingerprint: None,
                content_hash: None,
                sampled_sec: 0.0,
                signal_sec: 0.0,
            });
        }
        if packet.track_id() != stream_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(DecodeError::DecodeError(_)) => continue,
            Err(DecodeError::Unsupported(_)) | Err(DecodeError::ResetRequired) => {
                return Ok(DecodedAudio {
                    supported: false,
                    fingerprint: None,
                    content_hash: None,
                    sampled_sec: 0.0,
                    signal_sec: 0.0,
                });
            }
            Err(_) => continue,
        };
        let spec = *decoded.spec();
        let decoded_channels = spec.channels.count();
        if spec.rate != rate
            || decoded_channels == 0
            || decoded_channels > MAX_CHANNELS
            || decoded.capacity() > MAX_PACKET_FRAMES as usize * MAX_CHANNELS
        {
            return Ok(DecodedAudio {
                supported: false,
                fingerprint: None,
                content_hash: None,
                sampled_sec: 0.0,
                signal_sec: 0.0,
            });
        }
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        let input = buffer.samples();
        let frames = input.len() / decoded_channels;
        let take_frames = frames.min((max_frames - total_frames) as usize);
        if take_frames == 0 {
            break;
        }
        let mut normalized = Vec::with_capacity(take_frames.saturating_mul(output_channels));
        for frame in input.chunks_exact(decoded_channels).take(take_frames) {
            if output_channels == 1 {
                normalized.push(to_i16(frame[0]));
            } else {
                let mut left_sum = 0.0_f32;
                let mut right_sum = 0.0_f32;
                let mut left_count = 0_usize;
                let mut right_count = 0_usize;
                for (index, sample) in frame.iter().enumerate() {
                    if index % 2 == 0 {
                        left_sum += *sample;
                        left_count += 1;
                    } else {
                        right_sum += *sample;
                        right_count += 1;
                    }
                }
                normalized.push(to_i16(left_sum / left_count.max(1) as f32));
                normalized.push(to_i16(if right_count == 0 {
                    left_sum / left_count.max(1) as f32
                } else {
                    right_sum / right_count as f32
                }));
            }
        }
        let bytes = normalized
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        content_hash.update(bytes);
        for frame in normalized.chunks_exact(output_channels) {
            let energy = frame
                .iter()
                .map(|sample| {
                    let value = f64::from(*sample) / f64::from(i16::MAX);
                    value * value
                })
                .sum::<f64>()
                / output_channels as f64;
            window_energy += energy;
            window_count += 1;
            if window_count == window_frames {
                if (window_energy / window_count as f64).sqrt() >= 0.002 {
                    signal_sec += window_count as f64 / f64::from(rate);
                }
                window_count = 0;
                window_energy = 0.0;
            }
        }
        fingerprinter.consume(&normalized);
        total_frames += take_frames as u64;
        if total_frames >= max_frames {
            break;
        }
    }
    if window_count > 0 && (window_energy / window_count as f64).sqrt() >= 0.002 {
        signal_sec += window_count as f64 / f64::from(rate);
    }
    let sampled_sec = total_frames as f64 / f64::from(rate);
    let mut fingerprint = None;
    let mut content_hash_value = None;
    if sampled_sec >= MIN_SIGNAL_SEC && signal_sec >= MIN_SIGNAL_SEC {
        fingerprinter.finish();
        let values = fingerprinter.fingerprint().to_vec();
        if (100..=MAX_FINGERPRINT_ITEMS).contains(&values.len()) {
            content_hash_value = Some(format!("{:x}", content_hash.finalize()));
            fingerprint = Some(values);
        }
    }
    Ok(DecodedAudio {
        supported: true,
        fingerprint,
        content_hash: content_hash_value,
        sampled_sec,
        signal_sec,
    })
}

fn to_i16(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis() as i64)
        .unwrap_or(0)
}
