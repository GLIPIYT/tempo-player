use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::Mutex;

const CACHE_FILE: &str = "soundcloud-waveforms.json";
const MAX_ENTRIES: usize = 128;
const MAX_SAMPLES: usize = 512;
const MAX_CACHE_FILE_BYTES: u64 = 4 * 1024 * 1024;
const TTL_MS: u64 = 12 * 60 * 60 * 1000;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    saved_at_ms: u64,
    samples: Vec<f32>,
}

type Entries = HashMap<String, Entry>;

static CACHE_FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn file_lock() -> &'static Mutex<()> {
    CACHE_FILE_LOCK.get_or_init(|| Mutex::new(()))
}

fn file_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(CACHE_FILE)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn valid_track_id(track_id: &str) -> bool {
    !track_id.is_empty()
        && track_id.len() <= 32
        && track_id.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_samples(samples: &[f32]) -> bool {
    !samples.is_empty()
        && samples.len() <= MAX_SAMPLES
        && samples.iter().all(|sample| sample.is_finite() && (0.0..=1.0).contains(sample))
}

fn is_fresh(entry: &Entry, now: u64) -> bool {
    entry.saved_at_ms <= now && now.saturating_sub(entry.saved_at_ms) < TTL_MS
}

fn prune(entries: &mut Entries, now: u64) {
    entries.retain(|track_id, entry| {
        valid_track_id(track_id) && valid_samples(&entry.samples) && is_fresh(entry, now)
    });
    while entries.len() > MAX_ENTRIES {
        if !remove_oldest(entries) {
            break;
        }
    }
}

fn remove_oldest(entries: &mut Entries) -> bool {
    let oldest = entries
        .iter()
        .min_by_key(|(_, entry)| entry.saved_at_ms)
        .map(|(track_id, _)| track_id.clone());
    oldest.is_some_and(|track_id| entries.remove(&track_id).is_some())
}

async fn read_entries(path: &Path) -> Entries {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.len() <= MAX_CACHE_FILE_BYTES => metadata,
        _ => return Entries::new(),
    };
    if metadata.is_dir() {
        return Entries::new();
    }

    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

async fn write_entries(path: &Path, cache_dir: &Path, entries: &Entries) {
    let Ok(bytes) = serde_json::to_vec(entries) else { return };
    if bytes.len() as u64 > MAX_CACHE_FILE_BYTES {
        return;
    }
    if tokio::fs::create_dir_all(cache_dir).await.is_err() {
        return;
    }
    let temporary_path = cache_dir.join(format!("{CACHE_FILE}.{}.tmp", std::process::id()));
    if tokio::fs::write(&temporary_path, bytes).await.is_err() {
        let _ = tokio::fs::remove_file(&temporary_path).await;
        return;
    }
    if tokio::fs::rename(&temporary_path, path).await.is_err() {
        let _ = tokio::fs::remove_file(&temporary_path).await;
    }
}

/// Returns only a validated, unexpired waveform. File errors are a cache miss.
pub async fn load(cache_dir: &Path, track_id: &str) -> Option<Vec<f32>> {
    if !valid_track_id(track_id) {
        return None;
    }

    let _guard = file_lock().lock().await;
    let path = file_path(cache_dir);
    let mut entries = read_entries(&path).await;
    let before = entries.len();
    prune(&mut entries, now_ms());
    let changed = before != entries.len();
    let samples = entries.get(track_id).map(|entry| entry.samples.clone());
    if changed {
        write_entries(&path, cache_dir, &entries).await;
    }
    samples
}

/// Stores successful normalized peaks. Invalid responses and disk errors are ignored.
pub async fn store(cache_dir: &Path, track_id: &str, samples: &[f32]) {
    if !valid_track_id(track_id) || !valid_samples(samples) {
        return;
    }

    let _guard = file_lock().lock().await;
    let path = file_path(cache_dir);
    let mut entries = read_entries(&path).await;
    prune(&mut entries, now_ms());
    if !entries.contains_key(track_id) && entries.len() >= MAX_ENTRIES {
        remove_oldest(&mut entries);
    }
    let saved_at_ms = now_ms();
    entries.insert(
        track_id.to_string(),
        Entry {
            saved_at_ms,
            samples: samples.to_vec(),
        },
    );
    write_entries(&path, cache_dir, &entries).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempCacheDir(PathBuf);

    impl TempCacheDir {
        fn new() -> Self {
            let unique = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "tempo-waveform-cache-test-{}-{}-{}",
                std::process::id(),
                now_ms(),
                unique,
            ));
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempCacheDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn accepts_only_bounded_numeric_ids_and_normalized_samples() {
        assert!(valid_track_id("42"));
        assert!(valid_track_id(&"7".repeat(32)));
        assert!(!valid_track_id(""));
        assert!(!valid_track_id("42a"));
        assert!(!valid_track_id(&"7".repeat(33)));

        assert!(valid_samples(&[0.0, 0.5, 1.0]));
        assert!(!valid_samples(&[]));
        assert!(!valid_samples(&[f32::NAN]));
        assert!(!valid_samples(&[-0.1]));
        assert!(!valid_samples(&[1.1]));
        assert!(!valid_samples(&vec![0.5; MAX_SAMPLES + 1]));
    }

    #[test]
    fn prunes_expired_and_oldest_entries_to_the_cache_cap() {
        let now = TTL_MS + 1_000;
        let mut entries = Entries::new();
        entries.insert(
            "expired".into(),
            Entry {
                saved_at_ms: now - TTL_MS,
                samples: vec![0.5],
            },
        );
        for index in 0..=MAX_ENTRIES {
            entries.insert(
                index.to_string(),
                Entry {
                    saved_at_ms: now - 500 + index as u64,
                    samples: vec![0.5],
                },
            );
        }

        prune(&mut entries, now);

        assert_eq!(entries.len(), MAX_ENTRIES);
        assert!(!entries.contains_key("expired"));
        assert!(!entries.contains_key("0"));
        assert!(entries.contains_key(&MAX_ENTRIES.to_string()));
    }

    #[tokio::test]
    async fn disk_cache_round_trips_overwrites_and_treats_bad_files_as_misses() {
        let temp = TempCacheDir::new();
        let first = [0.1, 0.5, 1.0];
        let replacement = [0.25, 0.75];

        store(temp.path(), "42", &first).await;
        assert_eq!(load(temp.path(), "42").await, Some(first.to_vec()));

        // Exercise replacement of the existing cache file through temp+rename.
        store(temp.path(), "42", &replacement).await;
        assert_eq!(load(temp.path(), "42").await, Some(replacement.to_vec()));
        assert!(!temp
            .path()
            .join(format!("{CACHE_FILE}.{}.tmp", std::process::id()))
            .exists());

        store(temp.path(), "not-numeric", &[0.5]).await;
        store(temp.path(), "43", &[1.5]).await;
        assert_eq!(load(temp.path(), "not-numeric").await, None);
        assert_eq!(load(temp.path(), "43").await, None);
        assert_eq!(load(temp.path(), "99").await, None);

        let cache_file = temp.path().join(CACHE_FILE);
        let invalid_entry = Entries::from([(
            "44".to_string(),
            Entry {
                saved_at_ms: now_ms(),
                samples: vec![f32::INFINITY],
            },
        )]);
        tokio::fs::write(&cache_file, serde_json::to_vec(&invalid_entry).unwrap())
            .await
            .unwrap();
        assert_eq!(load(temp.path(), "44").await, None);

        tokio::fs::write(&cache_file, b"{broken json").await.unwrap();
        assert_eq!(load(temp.path(), "42").await, None);
        let missing_dir = temp.path().join("missing-directory");
        assert_eq!(load(&missing_dir, "42").await, None);

        // A cache path that cannot be a directory must not break the caller.
        let blocked_dir = temp.path().join("regular-file");
        tokio::fs::write(&blocked_dir, b"file").await.unwrap();
        store(&blocked_dir, "45", &[0.5]).await;
        assert_eq!(load(&blocked_dir, "45").await, None);
    }
}
