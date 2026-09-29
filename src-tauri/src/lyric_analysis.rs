//! Verified local model artifacts and reusable, media-coordinate lyric analysis.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::{watch, Mutex as AsyncMutex};

use crate::database::Db;

pub const MODEL_ID: &str = "onnx-community/whisper-tiny_timestamped";
pub const MODEL_REVISION: &str = "517244293732ee2d58139af5814231b7e6830a0d";
pub const ALGORITHM_VERSION: &str = "smart-lyrics-v1";
pub const MAX_AUDIO_FILE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_AUDIO_DURATION_SEC: f64 = 600.0;
pub const MAX_DECODED_AUDIO_BYTES: u64 = 256 * 1024 * 1024;
pub const MODEL_STATE_EVENT: &str = "lyrics-analysis://model-state";

const MODEL_PATHS: &[&str] = &[
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ModelPhase {
    Absent,
    Downloading,
    Ready,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    pub enabled: bool,
    pub phase: ModelPhase,
    pub loaded_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBundle {
    pub model_id: String,
    pub revision: String,
    pub files: Vec<ModelFile>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub relative_path: String,
    pub absolute_path: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelManifest {
    model_id: String,
    revision: String,
    files: Vec<ManifestFile>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    relative_path: String,
    size: u64,
    sha256: String,
}

struct ModelRuntime {
    generation: u64,
    attempt: u64,
    last_result: Option<Result<ModelBundle, String>>,
    state: ModelState,
}

pub struct ModelManager {
    root: PathBuf,
    manifest: ModelManifest,
    base_url: String,
    app: Option<AppHandle>,
    client: reqwest::Client,
    runtime: Mutex<ModelRuntime>,
    cancellation: watch::Sender<u64>,
    writer: AsyncMutex<()>,
    transitions: AsyncMutex<()>,
}
impl ModelManager {
    /// `root` must be the native app_cache_dir, never a frontend supplied path.
    pub fn new(root: PathBuf, enabled: bool, app: Option<AppHandle>) -> Result<Self, String> {
        let manifest: ModelManifest =
            serde_json::from_str(include_str!("../lyric_model_manifest.json"))
                .map_err(|e| format!("invalid model manifest: {e}"))?;
        Self::with_source(
            root,
            enabled,
            app,
            manifest,
            format!("https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}"),
        )
    }

    fn with_source(
        root: PathBuf,
        enabled: bool,
        app: Option<AppHandle>,
        manifest: ModelManifest,
        base_url: String,
    ) -> Result<Self, String> {
        validate_manifest(&manifest)?;
        fs::create_dir_all(&root).map_err(|e| format!("model cache root: {e}"))?;
        let root = fs::canonicalize(&root).map_err(|e| format!("model cache root: {e}"))?;
        let total_bytes = manifest.files.iter().map(|f| f.size).sum();
        let (cancellation, _) = watch::channel(0);
        let manager = Self {
            root,
            manifest,
            base_url,
            app,
            client: reqwest::Client::builder()
                .user_agent("tempo-player")
                .timeout(Duration::from_secs(120))
                .build()
                .map_err(|e| e.to_string())?,
            runtime: Mutex::new(ModelRuntime {
                generation: 0,
                attempt: 0,
                last_result: None,
                state: ModelState {
                    enabled,
                    phase: ModelPhase::Absent,
                    loaded_bytes: 0,
                    total_bytes,
                    error: None,
                },
            }),
            cancellation,
            writer: AsyncMutex::new(()),
            transitions: AsyncMutex::new(()),
        };
        manager.check_directory()?;
        Ok(manager)
    }
    pub fn status(&self) -> ModelState {
        self.runtime
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .state
            .clone()
    }
    fn directory(&self) -> PathBuf {
        self.root.join("lyrics-analysis-model").join(MODEL_REVISION)
    }

    fn check_directory(&self) -> Result<(), String> {
        if fs::canonicalize(&self.root).map_err(|e| e.to_string())? != self.root {
            return Err("model cache root changed".into());
        }
        let directory = self.directory();
        if directory != self.root.join("lyrics-analysis-model").join(MODEL_REVISION)
            || !directory.starts_with(&self.root)
        {
            return Err("model directory is outside the dedicated cache".into());
        }
        reject_link(&self.root.join("lyrics-analysis-model"))?;
        reject_link(&directory)?;
        reject_link(&directory.join("onnx"))?;
        Ok(())
    }

    fn file_path(&self, relative_path: &str) -> Result<PathBuf, String> {
        if !MODEL_PATHS.contains(&relative_path) {
            return Err("model path is not allowlisted".into());
        }
        self.check_directory()?;
        let path = self.directory().join(relative_path);
        reject_link(&path)?;
        reject_link(&part_path(&path))?;
        Ok(path)
    }

    fn check_generation(&self, generation: u64) -> Result<(), String> {
        let runtime = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if runtime.generation != generation || !runtime.state.enabled {
            return Err("model download cancelled".into());
        }
        Ok(())
    }

    fn update(&self, generation: u64, phase: ModelPhase, loaded: u64, error: Option<String>) {
        let state = {
            let mut runtime = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if runtime.generation != generation || !runtime.state.enabled {
                return;
            }
            runtime.state.phase = phase;
            runtime.state.loaded_bytes = loaded;
            runtime.state.error = error;
            runtime.state.clone()
        };
        self.emit(&state);
    }
    fn emit(&self, state: &ModelState) {
        if let Some(app) = &self.app {
            let _ = app.emit(MODEL_STATE_EVENT, state);
        }
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<ModelState, String> {
        // Transitions linearize so an enable arriving during deletion waits for
        // that deletion, then starts a fresh generation with no old writer.
        let _transition = self.transitions.lock().await;
        let generation = {
            let mut runtime = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if enabled && runtime.state.enabled {
                return Ok(runtime.state.clone());
            }
            runtime.generation += 1;
            runtime.last_result = None;
            runtime.state.enabled = enabled;
            runtime.state.phase = ModelPhase::Absent;
            runtime.state.loaded_bytes = 0;
            runtime.state.error = None;
            self.cancellation.send_replace(runtime.generation);
            runtime.generation
        };
        self.emit(&self.status());
        if !enabled {
            // The HTTP select wakes immediately; acquiring this gate proves
            // every file writer is closed before the checked recursive delete.
            let _writer = self.writer.lock().await;
            let cleanup = (|| {
                self.check_directory()?;
                let directory = self.directory();
                if directory.exists() {
                    fs::remove_dir_all(&directory)
                        .map_err(|e| format!("model cleanup failed: {e}"))?;
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = cleanup {
                let state = {
                    let mut runtime = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
                    if runtime.generation == generation {
                        runtime.state.phase = ModelPhase::Error;
                        runtime.state.error = Some(error.clone());
                    }
                    runtime.state.clone()
                };
                self.emit(&state);
                return Err(error);
            }
        }
        Ok(self.status())
    }

    pub async fn ensure_model(&self) -> Result<ModelBundle, String> {
        let mut cancelled = self.cancellation.subscribe();
        let (generation, attempt, was_downloading) = {
            let runtime = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if !runtime.state.enabled {
                return Err("lyric analysis is disabled".into());
            }
            (
                runtime.generation,
                runtime.attempt,
                runtime.state.phase == ModelPhase::Downloading,
            )
        };
        let _writer = tokio::select! {
            guard = self.writer.lock() => guard,
            _ = cancelled.changed() => return Err("model download cancelled".into()),
        };
        self.check_generation(generation)?;
        {
            let mut runtime = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if runtime.attempt != attempt || was_downloading {
                if let Some(result) = &runtime.last_result {
                    return result.clone();
                }
            }
            runtime.attempt += 1;
            runtime.last_result = None;
        }
        self.update(generation, ModelPhase::Downloading, 0, None);
        let result = self.fetch_bundle(generation, &mut cancelled).await;
        if let Err(error) = &result {
            self.update(
                generation,
                ModelPhase::Error,
                self.status().loaded_bytes,
                Some(error.clone()),
            );
        }
        let mut runtime = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if runtime.generation != generation || !runtime.state.enabled {
            return Err("model download cancelled".into());
        }
        runtime.last_result = Some(result.clone());
        result
    }

    async fn fetch_bundle(
        &self,
        generation: u64,
        cancelled: &mut watch::Receiver<u64>,
    ) -> Result<ModelBundle, String> {
        self.check_directory()?;
        self.check_generation(generation)?;
        fs::create_dir_all(self.directory()).map_err(|e| format!("model cache: {e}"))?;
        self.check_directory()?;
        let mut loaded = 0;
        let mut files = Vec::new();
        for expected in &self.manifest.files {
            self.check_generation(generation)?;
            let path = self.file_path(&expected.relative_path)?;
            if !self.verify_file(&path, expected, generation)? {
                if path.exists() {
                    fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
                let part = part_path(&path);
                if part.exists() {
                    fs::remove_file(&part).map_err(|e| e.to_string())?;
                }
                let result = self
                    .download_file(&path, expected, loaded, generation, cancelled)
                    .await;
                if result.is_err() {
                    let _ = fs::remove_file(&part);
                }
                result?;
            }
            loaded += expected.size;
            self.update(generation, ModelPhase::Downloading, loaded, None);
            files.push(ModelFile {
                relative_path: expected.relative_path.clone(),
                absolute_path: path.to_string_lossy().into_owned(),
            });
        }
        self.check_generation(generation)?;
        self.update(generation, ModelPhase::Ready, loaded, None);
        Ok(ModelBundle {
            model_id: self.manifest.model_id.clone(),
            revision: self.manifest.revision.clone(),
            files,
        })
    }

    fn verify_file(
        &self,
        path: &Path,
        expected: &ManifestFile,
        generation: u64,
    ) -> Result<bool, String> {
        let meta = match fs::metadata(path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.to_string()),
        };
        if !meta.is_file() || meta.len() != expected.size {
            return Ok(false);
        }
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            self.check_generation(generation)?;
            let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
        }
        Ok(format!("{:x}", hash.finalize()) == expected.sha256)
    }

    async fn download_file(
        &self,
        path: &Path,
        expected: &ManifestFile,
        loaded: u64,
        generation: u64,
        cancelled: &mut watch::Receiver<u64>,
    ) -> Result<(), String> {
        use futures_util::StreamExt;
        let response = tokio::select! {
            response = self.client.get(format!("{}/{}", self.base_url, expected.relative_path)).send() => response.map_err(|e| format!("model download: {e}"))?,
            _ = cancelled.changed() => return Err("model download cancelled".into()),
        }.error_for_status().map_err(|e| format!("model download: {e}"))?;
        self.check_generation(generation)?;
        if response
            .content_length()
            .is_some_and(|size| size != expected.size)
        {
            return Err(format!(
                "unexpected size for {}: expected {}, received {:?}",
                expected.relative_path,
                expected.size,
                response.content_length()
            ));
        }
        let parent = path.parent().ok_or("invalid model path")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        self.file_path(&expected.relative_path)?;
        let part = part_path(path);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .map_err(|e| format!("model write: {e}"))?;
        let mut stream = response.bytes_stream();
        let mut received = 0u64;
        let mut hash = Sha256::new();
        loop {
            let chunk = tokio::select! {
                chunk = stream.next() => chunk,
                _ = cancelled.changed() => return Err("model download cancelled".into()),
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|e| format!("model download: {e}"))?;
            self.check_generation(generation)?;
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or("model size overflow")?;
            if received > expected.size {
                return Err(format!("oversized model file {}", expected.relative_path));
            }
            file.write_all(&chunk)
                .map_err(|e| format!("model write: {e}"))?;
            hash.update(&chunk);
            self.update(generation, ModelPhase::Downloading, loaded + received, None);
        }
        if received != expected.size || format!("{:x}", hash.finalize()) != expected.sha256 {
            return Err(format!(
                "model integrity check failed for {}",
                expected.relative_path
            ));
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        self.check_generation(generation)?;
        self.file_path(&expected.relative_path)?;
        fs::rename(&part, path).map_err(|e| format!("model finalize: {e}"))?;
        Ok(())
    }
}
fn part_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}
fn reject_link(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                meta.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let linked = meta.file_type().is_symlink();
            if linked {
                return Err("linked model cache paths are not allowed".into());
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn validate_manifest(manifest: &ModelManifest) -> Result<(), String> {
    if manifest.model_id != MODEL_ID
        || manifest.revision != MODEL_REVISION
        || manifest.files.len() != MODEL_PATHS.len()
    {
        return Err("model manifest identity or file count is invalid".into());
    }
    let mut seen = HashSet::new();
    for file in &manifest.files {
        if !MODEL_PATHS.contains(&file.relative_path.as_str())
            || !seen.insert(&file.relative_path)
            || file.size == 0
            || file.size > 64 * 1024 * 1024
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("model manifest path, size or hash is invalid".into());
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioIdentity {
    pub fingerprint: String,
    pub absolute_path: String,
    pub file_size: u64,
    pub duration_sec: f64,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisWord {
    pub text: String,
    pub start_sec: f64,
    pub end_sec: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FragmentStatus {
    Completed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedFragment {
    pub start_sec: f64,
    pub end_sec: f64,
    pub status: FragmentStatus,
    pub words: Vec<AnalysisWord>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedSourceEnd {
    pub line_index: u32,
    pub source_end_sec: f64,
    pub matched_media_end_sec: f64,
    pub offset_at_match_ms: f64,
    pub confidence: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedLyricMatches {
    pub source_lyric_key: String,
    pub ends: Vec<MatchedSourceEnd>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BpmEstimate {
    pub bpm: f64,
    pub confidence: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAnalysis {
    pub fingerprint: String,
    pub algorithm_version: String,
    pub model_revision: String,
    pub duration_sec: f64,
    pub bpm: Option<f64>,
    pub bpm_confidence: f64,
    pub fragments: Vec<CompletedFragment>,
    pub lyric_matches: Vec<CachedLyricMatches>,
}
#[derive(Clone, Debug)]
pub struct AnalysisTrack {
    pub id: i64,
    pub path: String,
    pub source: String,
    pub source_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct AudioStamp {
    size: u64,
    modified_ns: u128,
    created_ns: Option<u128>,
    file_key: String,
}
#[derive(Clone)]
struct IssuedAudio {
    identity: AudioIdentity,
    stamp: AudioStamp,
    track: AnalysisTrack,
}

pub struct AudioAnalysisStore {
    db: Arc<Db>,
    sc_root: PathBuf,
    yt_root: PathBuf,
    issued: Mutex<HashMap<String, IssuedAudio>>,
}
impl AudioAnalysisStore {
    pub fn new(db: Arc<Db>, sc_root: PathBuf, yt_root: PathBuf) -> Self {
        Self {
            db,
            sc_root,
            yt_root,
            issued: Mutex::new(HashMap::new()),
        }
    }

    fn resolve(&self, track: &AnalysisTrack) -> Result<Option<PathBuf>, String> {
        match track.source.as_str() {
            "local" => Ok(Path::new(&track.path)
                .is_file()
                .then(|| PathBuf::from(&track.path))),
            "soundcloud" => crate::soundcloud_store::existing_cached_file(
                &self.db,
                &self.sc_root,
                track
                    .source_id
                    .as_deref()
                    .ok_or("missing SoundCloud track ID")?,
            ),
            "youtube" => existing_youtube_file(
                &self.yt_root,
                track
                    .source_id
                    .as_deref()
                    .ok_or("missing YouTube track ID")?,
            ),
            _ => Err("unsupported audio source".into()),
        }
    }

    /// Resolves only the registered row (or source/external ID pair). No URLs or
    /// frontend paths reach the file reader, and no cache downloader is called.
    pub fn audio_identity(
        &self,
        track_id: Option<i64>,
        source: &str,
        source_id: Option<&str>,
    ) -> Result<Option<AudioIdentity>, String> {
        if !matches!(source, "local" | "soundcloud" | "youtube") {
            return Err("unsupported audio source".into());
        }
        if source == "local" && track_id.is_none() {
            return Ok(None);
        }
        if source != "local" {
            validate_source_id(source, source_id.ok_or("missing external track ID")?)?;
        }
        let Some(track) = self.db.lyrics_analysis_track(track_id, source, source_id)? else {
            return Ok(None);
        };
        if track.source != source
            || (source_id.is_some() && track.source_id.as_deref() != source_id)
        {
            return Err("registered track source does not match".into());
        }
        let Some(path) = self.resolve(&track)? else {
            return Ok(None);
        };
        let Some((identity, stamp)) = read_audio_identity(&path)? else {
            return Ok(None);
        };
        let mut issued = self
            .issued
            .lock()
            .map_err(|_| "audio identity mutex poisoned")?;
        issued.retain(|_, old| old.identity.absolute_path != identity.absolute_path);
        if issued.len() >= 64 {
            if let Some(key) = issued.keys().next().cloned() {
                issued.remove(&key);
            }
        }
        issued.insert(
            identity.fingerprint.clone(),
            IssuedAudio {
                identity: identity.clone(),
                stamp,
                track,
            },
        );
        Ok(Some(identity))
    }

    fn current_identity(&self, fingerprint: &str) -> Result<Option<AudioIdentity>, String> {
        let issued = self
            .issued
            .lock()
            .map_err(|_| "audio identity mutex poisoned")?
            .get(fingerprint)
            .cloned();
        let Some(issued) = issued else {
            return Ok(None);
        };
        let Some(registered) = self.db.lyrics_analysis_track(
            Some(issued.track.id),
            &issued.track.source,
            issued.track.source_id.as_deref(),
        )?
        else {
            return Ok(None);
        };
        if registered.path != issued.track.path
            || registered.source != issued.track.source
            || registered.source_id != issued.track.source_id
        {
            return Ok(None);
        }
        let Some(path) = self.resolve(&registered)? else {
            return Ok(None);
        };
        let canonical = match fs::canonicalize(path) {
            Ok(path) => path,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        if canonical.to_string_lossy() != issued.identity.absolute_path {
            return Ok(None);
        }
        let current_stamp = match audio_stamp(&canonical) {
            Ok(stamp) => stamp,
            Err(_) => return Ok(None),
        };
        if current_stamp != issued.stamp {
            return Ok(None);
        }
        Ok(Some(issued.identity))
    }

    pub fn get(&self, fingerprint: &str) -> Result<Option<AudioAnalysis>, String> {
        let Some(identity) = self.current_identity(fingerprint)? else {
            return Ok(None);
        };
        let Some(mut analysis) = self.db.lyrics_analysis_get(fingerprint)? else {
            return Ok(None);
        };
        validate_analysis(&analysis, &identity)?;
        analysis.reset_versions(ALGORITHM_VERSION, MODEL_REVISION);
        Ok(Some(analysis))
    }

    pub fn merge(
        &self,
        fingerprint: &str,
        algorithm: &str,
        model: &str,
        bpm: Option<BpmEstimate>,
        fragment: Option<CompletedFragment>,
        matches: Option<CachedLyricMatches>,
    ) -> Result<AudioAnalysis, String> {
        validate_version(algorithm)?;
        validate_version(model)?;
        let identity = self
            .current_identity(fingerprint)?
            .ok_or("audio identity is missing or changed; resolve the registered track again")?;
        if let Some(bpm) = &bpm {
            validate_bpm(bpm)?;
        }
        if let Some(fragment) = &fragment {
            validate_fragment(fragment, identity.duration_sec)?;
        }
        if let Some(matches) = &matches {
            validate_matches(matches, identity.duration_sec)?;
        }
        // Header/filesystem work and revalidation finish before entering the
        // short SQLite transaction. No database lock spans IO or HTTP awaits.
        self.db.lyrics_analysis_merge(
            &identity,
            algorithm,
            model,
            bpm.as_ref(),
            fragment.as_ref(),
            matches.as_ref(),
        )
    }
}

fn validate_source_id(source: &str, id: &str) -> Result<(), String> {
    let valid = match source {
        "soundcloud" => !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit()),
        "youtube" => {
            id.len() == 11
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("invalid external track ID".into())
    }
}

fn existing_youtube_file(root: &Path, source_id: &str) -> Result<Option<PathBuf>, String> {
    validate_source_id("youtube", source_id)?;
    let root = match fs::canonicalize(root) {
        Ok(root) => root,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut candidates = fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_stem().and_then(|v| v.to_str()) == Some(source_id)
                && path
                    .extension()
                    .and_then(|v| v.to_str())
                    .is_some_and(|ext| crate::scanner::AUDIO_EXTENSIONS.contains(&ext))
                && path.is_file()
        })
        .collect::<Vec<_>>();
    candidates.sort();
    for path in candidates {
        let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
        if canonical.parent() == Some(root.as_path()) {
            return Ok(Some(canonical));
        }
    }
    Ok(None)
}

fn audio_stamp(path: &Path) -> Result<AudioStamp, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("audio is not a file".into());
    }
    let modified_ns = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let created_ns = meta
        .created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_nanos());
    #[cfg(unix)]
    let file_key = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", meta.dev(), meta.ino())
    };
    #[cfg(windows)]
    let file_key = {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
        };
        let mut identity = FILE_ID_INFO::default();
        // Metadata and identity come from the same open handle. NTFS can retain
        // creation time at a reused pathname, so time/size alone miss replacement.
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileIdInfo,
                (&mut identity as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        }
        .map_err(|e| format!("cannot identify audio file: {e}"))?;
        format!(
            "{}:{:02x?}",
            identity.VolumeSerialNumber, identity.FileId.Identifier
        )
    };
    #[cfg(not(any(unix, windows)))]
    let file_key = String::new();
    Ok(AudioStamp {
        size: meta.len(),
        modified_ns,
        created_ns,
        file_key,
    })
}

fn audio_properties_within_limits(duration: f64, rate: Option<u32>, channels: Option<u8>) -> bool {
    let (Some(rate), Some(channels)) = (rate, channels) else {
        return false;
    };
    duration.is_finite()
        && duration > 0.0
        && duration <= MAX_AUDIO_DURATION_SEC
        && rate > 0
        && channels > 0
        && duration * f64::from(rate) * f64::from(channels) * 4.0 <= MAX_DECODED_AUDIO_BYTES as f64
}

fn read_audio_identity(path: &Path) -> Result<Option<(AudioIdentity, AudioStamp)>, String> {
    use lofty::config::ParseOptions;
    use lofty::file::AudioFile;
    use lofty::probe::Probe;

    let canonical = match fs::canonicalize(path) {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let stamp = audio_stamp(&canonical)?;
    if stamp.size == 0 || stamp.size > MAX_AUDIO_FILE_BYTES {
        return Ok(None);
    }
    let tagged = match Probe::open(&canonical)
        .and_then(|probe| Ok(probe.guess_file_type()?))
        .and_then(|probe| {
            probe
                .options(ParseOptions::new().read_tags(false).read_properties(true))
                .read()
        }) {
        Ok(tagged) => tagged,
        Err(_) => return Ok(None),
    };
    let properties = tagged.properties();
    let duration_sec = properties.duration().as_secs_f64();
    let sample_rate = properties.sample_rate();
    let channels = properties.channels();
    if !audio_properties_within_limits(duration_sec, sample_rate, channels) {
        return Ok(None);
    }
    if audio_stamp(&canonical)? != stamp {
        return Ok(None);
    }
    let absolute_path = canonical.to_string_lossy().into_owned();
    let mut hash = Sha256::new();
    hash.update(
        serde_json::to_vec(&(
            &absolute_path,
            stamp.size,
            stamp.modified_ns.to_string(),
            stamp.created_ns.map(|v| v.to_string()),
            &stamp.file_key,
            ALGORITHM_VERSION,
        ))
        .map_err(|e| e.to_string())?,
    );
    Ok(Some((
        AudioIdentity {
            fingerprint: format!("{:x}", hash.finalize()),
            absolute_path,
            file_size: stamp.size,
            duration_sec,
            sample_rate,
            channels,
        },
        stamp,
    )))
}

fn validate_version(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err("invalid analysis version".into());
    }
    Ok(())
}
fn confidence(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}
fn validate_bpm(value: &BpmEstimate) -> Result<(), String> {
    if !value.bpm.is_finite()
        || value.bpm <= 0.0
        || value.bpm > 400.0
        || !confidence(value.confidence)
    {
        return Err("invalid BPM estimate".into());
    }
    Ok(())
}
fn validate_fragment(fragment: &CompletedFragment, duration: f64) -> Result<(), String> {
    if !fragment.start_sec.is_finite()
        || !fragment.end_sec.is_finite()
        || fragment.start_sec < 0.0
        || fragment.end_sec <= fragment.start_sec
        || fragment.end_sec > duration
        || fragment.words.len() > 10000
    {
        return Err("invalid completed fragment".into());
    }
    let mut previous_start = fragment.start_sec;
    for word in &fragment.words {
        if word.text.trim().is_empty()
            || word.text.len() > 1024
            || !word.start_sec.is_finite()
            || !word.end_sec.is_finite()
            || word.start_sec < previous_start
            || word.end_sec <= word.start_sec
            || word.end_sec > fragment.end_sec
        {
            return Err("invalid recognized word".into());
        }
        previous_start = word.start_sec;
    }
    Ok(())
}
fn validate_matches(matches: &CachedLyricMatches, duration: f64) -> Result<(), String> {
    if matches.source_lyric_key.is_empty()
        || matches.source_lyric_key.len() > 512
        || matches.ends.len() > 2000
    {
        return Err("invalid lyric match key or count".into());
    }
    let mut indexes = HashSet::new();
    for end in &matches.ends {
        if !indexes.insert(end.line_index)
            || !end.source_end_sec.is_finite()
            || !end.matched_media_end_sec.is_finite()
            || !end.offset_at_match_ms.is_finite()
            || !confidence(end.confidence)
            || end.matched_media_end_sec < 0.0
            || end.matched_media_end_sec > duration
            || (end.source_end_sec + end.offset_at_match_ms / 1000.0 - end.matched_media_end_sec)
                .abs()
                > 0.000001
        {
            return Err("invalid accepted lyric endpoint".into());
        }
    }
    Ok(())
}
pub fn validate_analysis(analysis: &AudioAnalysis, identity: &AudioIdentity) -> Result<(), String> {
    if analysis.fingerprint != identity.fingerprint
        || !analysis.duration_sec.is_finite()
        || analysis.duration_sec != identity.duration_sec
        || !confidence(analysis.bpm_confidence)
        || analysis.fragments.len() > 2048
        || analysis.lyric_matches.len() > 64
    {
        return Err("invalid stored audio analysis".into());
    }
    validate_version(&analysis.algorithm_version)?;
    validate_version(&analysis.model_revision)?;
    if let Some(bpm) = analysis.bpm {
        validate_bpm(&BpmEstimate {
            bpm,
            confidence: analysis.bpm_confidence,
        })?;
    }
    for fragment in &analysis.fragments {
        validate_fragment(fragment, identity.duration_sec)?;
    }
    for matches in &analysis.lyric_matches {
        validate_matches(matches, identity.duration_sec)?;
    }
    Ok(())
}
impl AudioAnalysis {
    pub fn empty(identity: &AudioIdentity, algorithm: &str, model: &str) -> Self {
        Self {
            fingerprint: identity.fingerprint.clone(),
            algorithm_version: algorithm.into(),
            model_revision: model.into(),
            duration_sec: identity.duration_sec,
            bpm: None,
            bpm_confidence: 0.0,
            fragments: Vec::new(),
            lyric_matches: Vec::new(),
        }
    }
    pub fn reset_versions(&mut self, algorithm: &str, model: &str) {
        if self.algorithm_version != algorithm {
            self.bpm = None;
            self.bpm_confidence = 0.0;
        }
        if self.algorithm_version != algorithm || self.model_revision != model {
            self.fragments.clear();
            self.lyric_matches.clear();
        }
        self.algorithm_version = algorithm.into();
        self.model_revision = model.into();
    }
}

#[tauri::command]
pub fn lyrics_analysis_status(state: tauri::State<'_, Arc<ModelManager>>) -> ModelState {
    state.status()
}

#[tauri::command]
pub async fn lyrics_analysis_set_enabled(
    state: tauri::State<'_, Arc<ModelManager>>,
    enabled: bool,
) -> Result<ModelState, String> {
    state.set_enabled(enabled).await
}

#[tauri::command]
pub async fn lyrics_analysis_ensure_model(
    state: tauri::State<'_, Arc<ModelManager>>,
) -> Result<ModelBundle, String> {
    state.ensure_model().await
}

#[tauri::command]
pub async fn lyrics_analysis_audio_identity(
    state: tauri::State<'_, Arc<AudioAnalysisStore>>,
    track_id: Option<i64>,
    source: String,
    source_id: Option<String>,
) -> Result<Option<AudioIdentity>, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.audio_identity(track_id, &source, source_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lyrics_analysis_get(
    state: tauri::State<'_, Arc<AudioAnalysisStore>>,
    fingerprint: String,
) -> Result<Option<AudioAnalysis>, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.get(&fingerprint))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lyrics_analysis_merge(
    state: tauri::State<'_, Arc<AudioAnalysisStore>>,
    fingerprint: String,
    algorithm_version: String,
    model_revision: String,
    bpm: Option<BpmEstimate>,
    completed_fragment: Option<CompletedFragment>,
    accepted_matches: Option<CachedLyricMatches>,
) -> Result<AudioAnalysis, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.merge(
            &fingerprint,
            &algorithm_version,
            &model_revision,
            bpm,
            completed_fragment,
            accepted_matches,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
