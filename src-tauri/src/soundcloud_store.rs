use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::database::Db;

const DESKTOP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const CACHE_DIR_KEY: &str = "sc_cache_dir";
const CACHE_LIMIT_KEY: &str = "sc_cache_limit_bytes";
pub const LIBRARY_CHANGED_EVENT: &str = "library://changed";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScPlayback {
    pub url: Option<String>,
    pub cached_path: Option<String>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScCacheInfo {
    pub path: String,
    pub total_bytes: i64,
    pub file_count: i64,
    pub limit_bytes: i64,
}

pub fn cache_dir(db: &Db, default_root: &Path) -> PathBuf {
    let configured = db.get_app_setting(CACHE_DIR_KEY).ok().flatten();
    let dir = configured
        .map(PathBuf::from)
        .unwrap_or_else(|| default_root.to_path_buf());
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn set_cache_dir(db: &Db, path: &str) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|e| format!("failed to create soundcloud cache directory {}: {}", path, e))?;
    db.set_app_setting(CACHE_DIR_KEY, path)
}

pub fn cache_limit(db: &Db) -> i64 {
    db.get_app_setting(CACHE_LIMIT_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
        .max(0)
}

pub fn set_cache_limit(db: &Db, default_root: &Path, bytes: i64) -> Result<(), String> {
    let bytes = bytes.max(0);
    db.set_app_setting(CACHE_LIMIT_KEY, &bytes.to_string())?;
    if bytes > 0 {
        let dir = cache_dir(db, default_root);
        enforce_cache_limit(db, &dir, bytes);
    }
    Ok(())
}

/// Deletes cached files for the least recently played SoundCloud tracks until the
/// cache fits into `limit_bytes` (0 disables the limit).
pub fn enforce_cache_limit(db: &Db, dir: &Path, limit: i64) {
    if limit <= 0 {
        return;
    }
    for _ in 0..10_000 {
        let info = cache_info(db, dir);
        if info.total_bytes <= limit {
            break;
        }
        let Ok(Some(external_id)) = db.oldest_cached_sc_track() else {
            break;
        };
        let file = cached_file_path(dir, &external_id);
        if std::fs::remove_file(&file).is_ok() || !file.exists() {
            let _ = db.mark_sc_uncached(&external_id);
        } else {
            break;
        }
    }
}

/// Runs at startup: flags cached tracks so they show up in the library,
/// unflags rows whose files disappeared, then applies the cache limit.
pub fn startup_maintenance(db: &Db, default_root: &Path, covers_dir: &Path) {
    let dir = cache_dir(db, default_root);
    let _ = db.reconcile_sc_cache(&dir, covers_dir);
    enforce_cache_limit(db, &dir, cache_limit(db));
}

/// Marks the freshly downloaded file as cached, links it into albums/artists
/// from the file's tags and notifies the frontend so the library refreshes.
fn finalize_cached_file(db: &Db, dir: &Path, covers_dir: &Path, sc_id: &str, app: Option<&AppHandle>) {
    let file = cached_file_path(dir, sc_id);
    let size = std::fs::metadata(&file).map(|m| m.len() as i64).unwrap_or(0);
    let _ = db.mark_sc_cached(sc_id, size);
    let _ = db.enrich_sc_track_from_tags(sc_id, &file, covers_dir);
    if let Some(app) = app {
        let _ = app.emit(LIBRARY_CHANGED_EVENT, sc_id.to_string());
    }
}

pub fn cache_info(db: &Db, default_root: &Path) -> ScCacheInfo {
    let dir = cache_dir(db, default_root);
    let mut total_bytes = 0i64;
    let mut file_count = 0i64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("mp3") {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total_bytes += meta.len() as i64;
                    file_count += 1;
                }
            }
        }
    }
    ScCacheInfo {
        path: dir.to_string_lossy().to_string(),
        total_bytes,
        file_count,
        limit_bytes: cache_limit(db),
    }
}

pub async fn get_playback(
    db: Arc<Db>,
    default_root: PathBuf,
    covers_dir: PathBuf,
    track_id: &str,
    app: Option<AppHandle>,
) -> Result<ScPlayback, String> {
    let dir = cache_dir(&db, &default_root);
    let cached = cached_file_path(&dir, track_id);
    if cached.exists() {
        return Ok(ScPlayback {
            url: None,
            cached_path: Some(cached.to_string_lossy().to_string()),
            format: None,
        });
    }
    let info = crate::soundcloud::get_stream_info(track_id).await?;
    let format = Some(info.format.clone());
    if info.format == "hls" {
        return Ok(ScPlayback { url: Some(info.url), cached_path: None, format });
    }
    let bg_url = info.url.clone();
    let bg_id = track_id.to_string();
    let limit = cache_limit(&db);
    tokio::spawn(async move {
        if download_to_cache(&bg_url, &cached).await.is_ok() {
            finalize_cached_file(&db, &dir, &covers_dir, &bg_id, app.as_ref());
            enforce_cache_limit(&db, &dir, limit);
        }
    });
    Ok(ScPlayback { url: Some(info.url), cached_path: None, format })
}

pub async fn precache(
    db: Arc<Db>,
    default_root: PathBuf,
    covers_dir: PathBuf,
    track_id: &str,
    app: Option<AppHandle>,
) {
    let dir = cache_dir(&db, &default_root);
    let dest = cached_file_path(&dir, track_id);
    if dest.exists() {
        return;
    }
    if let Ok(info) = crate::soundcloud::get_stream_info(track_id).await {
        if info.format == "hls" {
            return;
        }
        if download_to_cache(&info.url, &dest).await.is_ok() {
            finalize_cached_file(&db, &dir, &covers_dir, track_id, app.as_ref());
            enforce_cache_limit(&db, &dir, cache_limit(&db));
        }
    }
}

pub fn clear_cache(db: &Db, default_root: &Path) -> Result<(u32, u32), String> {
    let dir = cache_dir(db, default_root);
    let mut files_deleted = 0u32;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && std::fs::remove_file(&path).is_ok() {
                files_deleted += 1;
            }
        }
    }
    let playlist_rows_deleted = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let deleted = tx
            .execute(
                "DELETE FROM playlist_tracks WHERE track_id IN \
                 (SELECT id FROM tracks WHERE source = 'soundcloud')",
                [],
            )
            .map_err(|e| e.to_string())? as u32;
        tx.execute("DELETE FROM tracks WHERE source = 'soundcloud'", [])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(deleted)
    })?;
    Ok((files_deleted, playlist_rows_deleted))
}

fn cached_file_path(dir: &Path, track_id: &str) -> PathBuf {
    dir.join(format!("{}.mp3", track_id))
}

async fn download_to_cache(url: &str, final_path: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(DESKTOP_UA)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client error: {}", e))?;
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("download failed: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("download failed: {}", e))?;
    let tmp_path = final_path.with_extension("tmp");
    std::fs::write(&tmp_path, &bytes).map_err(|e| format!("cache write failed: {}", e))?;
    std::fs::rename(&tmp_path, final_path).map_err(|e| format!("cache finalize failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    fn test_env(tag: &str) -> (Db, PathBuf) {
        let seq = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let root = std::env::temp_dir().join(format!(
            "tempo_sc_{}_{}_{}_{}",
            tag,
            std::process::id(),
            nanos,
            seq
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = Db::open_at(&root.join("tempo.db")).unwrap();
        (db, root)
    }

    #[test]
    fn set_cache_dir_persists_and_overrides_default() {
        let (db, root) = test_env("setdir");
        let custom = root.join("custom_cache");
        set_cache_dir(&db, custom.to_str().unwrap()).unwrap();
        assert_eq!(
            db.get_app_setting(CACHE_DIR_KEY).unwrap().as_deref(),
            Some(custom.to_str().unwrap())
        );
        assert!(custom.is_dir());
        let resolved = cache_dir(&db, &root.join("default"));
        assert_eq!(resolved, custom);
        assert!(resolved.is_dir());
        drop(db);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_info_counts_only_mp3_files() {
        let (db, root) = test_env("info");
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("a.mp3"), vec![0u8; 100]).unwrap();
        std::fs::write(cache.join("b.mp3"), vec![0u8; 25]).unwrap();
        std::fs::write(cache.join("c.tmp"), vec![0u8; 50]).unwrap();
        std::fs::create_dir_all(cache.join("nested")).unwrap();
        set_cache_dir(&db, cache.to_str().unwrap()).unwrap();
        let info = cache_info(&db, &root.join("elsewhere"));
        assert_eq!(info.path, cache.to_string_lossy());
        assert_eq!(info.file_count, 2);
        assert_eq!(info.total_bytes, 125);
        drop(db);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clear_cache_deletes_files_and_soundcloud_rows() {
        use rusqlite::params;

        let (db, root) = test_env("clearcache");
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        for name in ["one.mp3", "two.mp3", "note.txt"] {
            std::fs::write(cache.join(name), b"x").unwrap();
        }
        set_cache_dir(&db, cache.to_str().unwrap()).unwrap();

        let folder = db.add_library_folder(r"C:\scl_local").unwrap();
        let local_id: i64 = db
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO tracks(path, folder_id, title, added_at, source) \
                     VALUES('C:\\scl_local\\l.mp3', ?1, 'Local', 1, 'local')",
                    params![folder.id],
                )
                .map_err(|e| e.to_string())?;
                c.query_row(
                    "SELECT id FROM tracks WHERE path = 'C:\\scl_local\\l.mp3'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        let sc1 = db.upsert_sc_track("101", "T1", "A1", 1000, None).unwrap();
        let sc2 = db.upsert_sc_track("102", "T2", "A2", 2000, None).unwrap();
        let pl = db.create_playlist("P").unwrap();
        db.playlist_add_track(pl.id, local_id).unwrap();
        db.playlist_add_track(pl.id, sc1).unwrap();
        db.playlist_add_track(pl.id, sc2).unwrap();

        let (files_deleted, playlist_rows) = clear_cache(&db, &root.join("unused")).unwrap();
        assert_eq!(files_deleted, 3);
        assert_eq!(playlist_rows, 2);

        let remaining = db.get_playlist_tracks(pl.id).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].track.id, local_id);
        let sc_left: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM tracks WHERE source = 'soundcloud'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(sc_left, 0);
        assert!(std::fs::read_dir(&cache).unwrap().next().is_none());
        drop(db);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn get_playback_returns_cached_file_without_network() {
        let (db, root) = test_env("playback");
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("999.mp3"), b"cached-bytes").unwrap();
        set_cache_dir(&db, cache.to_str().unwrap()).unwrap();
        let playback = get_playback(
            Arc::new(db),
            root.join("default"),
            root.join("covers"),
            "999",
            None,
        )
        .await
        .unwrap();
        assert!(playback.url.is_none());
        assert_eq!(
            playback.cached_path.as_deref(),
            Some(cache.join("999.mp3").to_string_lossy().as_ref())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_limit_evicts_least_recently_played() {
        let (db, root) = test_env("limit");
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        set_cache_dir(&db, cache.to_str().unwrap()).unwrap();
        let played = db.upsert_sc_track("201", "A", "X", 1000, None).unwrap();
        db.upsert_sc_track("202", "B", "Y", 1000, None).unwrap();
        std::fs::write(cache.join("201.mp3"), vec![0u8; 100]).unwrap();
        std::fs::write(cache.join("202.mp3"), vec![0u8; 100]).unwrap();
        db.mark_sc_cached("201", 100).unwrap();
        db.mark_sc_cached("202", 100).unwrap();
        // make the eviction order deterministic regardless of wall-clock seconds
        db.with_conn(|c| {
            c.execute("UPDATE tracks SET cached_at = 1 WHERE external_id = '202'", [])
                .map_err(|e| e.to_string())
        })
        .unwrap();
        db.bump_play_count(played).unwrap();

        assert_eq!(cache_limit(&db), 0);
        enforce_cache_limit(&db, &cache, 0);
        assert!(cache.join("202.mp3").exists());

        enforce_cache_limit(&db, &cache, 150);
        assert!(cache.join("201.mp3").exists());
        assert!(!cache.join("202.mp3").exists());
        let (uncached, size): (i64, i64) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT cached_at IS NULL, file_size FROM tracks WHERE external_id = '202'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(uncached, 1);
        assert_eq!(size, 0);
        drop(db);
        let _ = std::fs::remove_dir_all(&root);
    }
}
