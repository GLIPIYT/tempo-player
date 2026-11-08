//! Bounded native cache for FireRedVAD AED vocal analysis.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::database::Db;
use crate::lyric_analysis::{AudioAnalysisStore, AudioIdentity};

pub const MODEL_REVISION: &str = "823c2802d870aa57f19b1fbd8214c85c72b22930c851342ef7c656f68b8e9ee2";
pub const ALGORITHM_VERSION: &str = "vocal-aed-v1";
pub const HOP_SEC: f64 = 0.02;
pub const MAX_ANALYSIS_JSON_BYTES: usize = 1024 * 1024;

const MAX_DURATION_SEC: f64 = 600.0;
const MAX_CHUNK_SEC: f64 = 20.0;
const MAX_CHUNKS: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocalAnalysis {
    pub fingerprint: String,
    pub model_revision: String,
    pub algorithm_version: String,
    pub duration_sec: f64,
    pub hop_sec: f64,
    pub chunks: Vec<VocalChunk>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocalChunk {
    pub start_sec: f64,
    pub end_sec: f64,
    pub voice: Vec<u8>,
    pub energy: Vec<u8>,
    pub flux: Vec<u8>,
}

impl VocalAnalysis {
    pub fn empty(identity: &AudioIdentity) -> Self {
        Self {
            fingerprint: identity.fingerprint.clone(),
            model_revision: MODEL_REVISION.into(),
            algorithm_version: ALGORITHM_VERSION.into(),
            duration_sec: identity.duration_sec,
            hop_sec: HOP_SEC,
            chunks: Vec::new(),
        }
    }
}

pub(crate) fn validate_analysis(
    analysis: &VocalAnalysis,
    identity: &AudioIdentity,
) -> Result<(), String> {
    if analysis.fingerprint != identity.fingerprint
        || analysis.model_revision != MODEL_REVISION
        || analysis.algorithm_version != ALGORITHM_VERSION
        || !analysis.duration_sec.is_finite()
        || analysis.duration_sec <= 0.0
        || analysis.duration_sec > MAX_DURATION_SEC
        || analysis.duration_sec != identity.duration_sec
        || (analysis.hop_sec - HOP_SEC).abs() > f64::EPSILON
        || analysis.chunks.len() > MAX_CHUNKS
    {
        return Err("invalid vocal analysis metadata".into());
    }

    let mut previous_end = 0.0;
    for (index, chunk) in analysis.chunks.iter().enumerate() {
        let chunk_duration = chunk.end_sec - chunk.start_sec;
        let expected_frames = (chunk_duration / HOP_SEC).ceil() as usize;
        let arrays_match = chunk.voice.len() == chunk.energy.len()
            && chunk.voice.len() == chunk.flux.len()
            && chunk.voice.len().abs_diff(expected_frames) <= 1;
        if !chunk.start_sec.is_finite()
            || !chunk.end_sec.is_finite()
            || chunk.start_sec < 0.0
            || chunk.end_sec <= chunk.start_sec
            || chunk.end_sec > analysis.duration_sec
            || chunk_duration > MAX_CHUNK_SEC
            || !arrays_match
            || (index > 0 && chunk.start_sec < previous_end)
        {
            return Err("invalid vocal analysis chunk".into());
        }
        previous_end = chunk.end_sec;
    }

    let json = serde_json::to_vec(analysis).map_err(|e| e.to_string())?;
    if json.len() > MAX_ANALYSIS_JSON_BYTES {
        return Err("vocal analysis cache exceeds its size limit".into());
    }
    Ok(())
}

pub struct VocalAnalysisStore {
    db: Arc<Db>,
    audio: Arc<AudioAnalysisStore>,
}

impl VocalAnalysisStore {
    pub fn new(db: Arc<Db>, audio: Arc<AudioAnalysisStore>) -> Self {
        Self { db, audio }
    }

    pub fn get(&self, fingerprint: &str) -> Result<Option<VocalAnalysis>, String> {
        let Some(identity) = self.audio.issued_identity(fingerprint)? else {
            return Ok(None);
        };
        let Some(analysis) = self.db.lyrics_vocal_get(fingerprint)? else {
            return Ok(None);
        };
        if analysis.model_revision != MODEL_REVISION
            || analysis.algorithm_version != ALGORITHM_VERSION
        {
            return Ok(None);
        }
        validate_analysis(&analysis, &identity)?;
        Ok(Some(analysis))
    }

    pub fn merge(&self, incoming: &VocalAnalysis) -> Result<VocalAnalysis, String> {
        let identity = self
            .audio
            .issued_identity(&incoming.fingerprint)?
            .ok_or("audio identity is missing or changed; resolve the registered track again")?;
        validate_analysis(incoming, &identity)?;
        let merged = self.db.lyrics_vocal_merge(&identity, incoming)?;
        validate_analysis(&merged, &identity)?;
        Ok(merged)
    }
}

#[tauri::command]
pub async fn lyrics_vocal_get(
    state: tauri::State<'_, Arc<VocalAnalysisStore>>,
    fingerprint: String,
) -> Result<Option<VocalAnalysis>, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.get(&fingerprint))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lyrics_vocal_merge(
    state: tauri::State<'_, Arc<VocalAnalysisStore>>,
    analysis: VocalAnalysis,
) -> Result<VocalAnalysis, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.merge(&analysis))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "tempo_vocal_analysis_{}_{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn wav(path: &Path, duration_sec: u32) {
        let sample_rate = 16_000u32;
        let byte_count = sample_rate * duration_sec * 2;
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + byte_count).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&sample_rate.to_le_bytes()).unwrap();
        file.write_all(&(sample_rate * 2).to_le_bytes()).unwrap();
        file.write_all(&2u16.to_le_bytes()).unwrap();
        file.write_all(&16u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&byte_count.to_le_bytes()).unwrap();
        file.write_all(&vec![0u8; byte_count as usize]).unwrap();
    }

    fn test_store(root: &Path) -> (VocalAnalysisStore, String, PathBuf) {
        let db = Arc::new(Db::open_at(&root.join("tempo.db")).unwrap());
        let audio_path = root.join("audio.wav");
        wav(&audio_path, 2);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tracks(path,title,duration_sec,added_at,source) VALUES(?1,'fixture',2,0,'local')",
                rusqlite::params![audio_path.to_string_lossy()],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();
        let audio = Arc::new(AudioAnalysisStore::new(
            db.clone(),
            root.join("sc"),
            root.join("yt"),
        ));
        let audio_id = audio
            .audio_identity(Some(1), "local", None)
            .unwrap()
            .unwrap();
        (
            VocalAnalysisStore::new(db, audio),
            audio_id.fingerprint,
            audio_path,
        )
    }

    fn analysis(fingerprint: &str, chunk: VocalChunk) -> VocalAnalysis {
        VocalAnalysis {
            fingerprint: fingerprint.into(),
            model_revision: MODEL_REVISION.into(),
            algorithm_version: ALGORITHM_VERSION.into(),
            duration_sec: 2.0,
            hop_sec: HOP_SEC,
            chunks: vec![chunk],
        }
    }

    fn chunk(start_sec: f64, end_sec: f64, value: u8) -> VocalChunk {
        let count = ((end_sec - start_sec) / HOP_SEC).ceil() as usize;
        VocalChunk {
            start_sec,
            end_sec,
            voice: vec![value; count],
            energy: vec![value; count],
            flux: vec![value; count],
        }
    }

    #[test]
    fn cache_merges_replaces_and_rejects_overlaps_without_touching_asr_cache() {
        let root = Temp::new();
        let (store, fingerprint, _) = test_store(&root.0);
        assert!(store.get(&fingerprint).unwrap().is_none());

        store
            .db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO lyric_audio_analysis(fingerprint,audio_key,analysis_json,updated_at) VALUES('asr-fixture','fixture','{}',0)",
                    [],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();

        store
            .merge(&analysis(&fingerprint, chunk(0.0, 0.1, 1)))
            .unwrap();
        let second = store
            .merge(&analysis(&fingerprint, chunk(0.1, 0.2, 2)))
            .unwrap();
        assert_eq!(second.chunks.len(), 2);

        let replaced = store
            .merge(&analysis(&fingerprint, chunk(0.0, 0.1, 9)))
            .unwrap();
        assert_eq!(replaced.chunks[0].voice, vec![9; 5]);
        assert!(store
            .merge(&analysis(&fingerprint, chunk(0.05, 0.15, 3)))
            .is_err());
        assert_eq!(store.get(&fingerprint).unwrap(), Some(replaced));
        assert_eq!(
            store
                .db
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM lyric_audio_analysis WHERE fingerprint='asr-fixture'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|e| e.to_string())
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn get_and_merge_revalidate_the_issued_audio_file() {
        let root = Temp::new();
        let (store, fingerprint, audio_path) = test_store(&root.0);
        store
            .merge(&analysis(&fingerprint, chunk(0.0, 0.1, 1)))
            .unwrap();
        assert!(store.get(&fingerprint).unwrap().is_some());
        std::fs::remove_file(&audio_path).unwrap();
        assert!(store.get(&fingerprint).unwrap().is_none());
        assert!(store
            .merge(&analysis(&fingerprint, chunk(0.1, 0.2, 2)))
            .is_err());
    }

    #[test]
    fn validation_enforces_chunk_shape_duration_and_count_limits() {
        let identity = AudioIdentity {
            fingerprint: "a".repeat(64),
            absolute_path: "fixture.wav".into(),
            file_size: 1,
            duration_sec: 600.0,
            sample_rate: Some(16_000),
            channels: Some(1),
        };
        let valid = VocalAnalysis::empty(&identity);
        validate_analysis(&valid, &identity).unwrap();

        let mut malformed = valid.clone();
        malformed.chunks.push(VocalChunk {
            start_sec: 0.0,
            end_sec: 0.1,
            voice: vec![1; 5],
            energy: vec![1; 4],
            flux: vec![1; 5],
        });
        assert!(validate_analysis(&malformed, &identity).is_err());

        let mut too_many = valid;
        too_many.chunks = (0..=MAX_CHUNKS)
            .map(|index| {
                let start = index as f64 * 0.1;
                chunk(start, start + 0.1, 0)
            })
            .collect();
        assert!(validate_analysis(&too_many, &identity).is_err());

        let long = VocalAnalysis {
            duration_sec: 600.0,
            ..analysis(&identity.fingerprint, chunk(0.0, 20.02, 1))
        };
        assert!(validate_analysis(&long, &identity).is_err());
    }
}
