use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};

use tauri::{AppHandle, Emitter};

use crate::database::Db;

mod cache_download;

const DESKTOP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const CACHE_DIR_KEY: &str = "sc_cache_dir";
const CACHE_LIMIT_KEY: &str = "sc_cache_limit_bytes";
pub const LIBRARY_CHANGED_EVENT: &str = "library://changed";
const CACHE_AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "mp4", "aac", "ogg", "oga", "opus", "webm", "mka", "flac", "wav",
];

#[derive(Debug, Clone)]
pub struct CacheOptions {
    pub bin_dir: PathBuf,
    pub ytdlp_path: String,
}

fn cache_download_locks(
) -> &'static std::sync::Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn cache_download_lock(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = cache_download_locks()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return lock;
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(path.to_path_buf(), Arc::downgrade(&lock));
    lock
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScPlayback {
    pub url: Option<String>,
    pub cached_path: Option<String>,
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_duration: Option<f64>,
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
    std::fs::create_dir_all(path).map_err(|e| {
        format!(
            "failed to create soundcloud cache directory {}: {}",
            path, e
        )
    })?;
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
        let file = find_cached_file(dir, &external_id)
            .unwrap_or_else(|| cache_lock_path(dir, &external_id));
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
    crate::soundcloud_recording::cleanup_abandoned(&dir);
    let _ = db.reconcile_sc_cache(&dir, covers_dir);
    enforce_cache_limit(db, &dir, cache_limit(db));
}

/// Marks the freshly downloaded file as cached, links it into albums/artists
/// from the file's tags and notifies the frontend so the library refreshes.
fn finalize_cached_file(
    db: &Db,
    dir: &Path,
    covers_dir: &Path,
    sc_id: &str,
) -> Result<PathBuf, String> {
    let file = find_cached_file(dir, sc_id)
        .ok_or_else(|| "completed SoundCloud cache file is missing".to_string())?;
    let metadata = std::fs::metadata(&file)
        .map_err(|error| format!("Could not inspect SoundCloud cache file: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("completed SoundCloud cache file is empty or invalid".into());
    }
    if !has_library_row(db, sc_id)? {
        return Err("SoundCloud cache has no library row to mark complete".into());
    }
    db.mark_sc_cached(sc_id, metadata.len() as i64)?;
    // Matroska audio streams do not reliably expose SoundCloud title/artist/artwork
    // tags. A false result means the cache remains valid and the API metadata row
    // stays authoritative; actual database failures are still surfaced.
    let _ = db.enrich_sc_track_from_tags(sc_id, &file, covers_dir)?;
    Ok(file)
}

fn has_library_row(db: &Db, sc_id: &str) -> Result<bool, String> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tracks WHERE source = 'soundcloud' AND external_id = ?1)",
            [sc_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())
    })
}

pub fn cache_info(db: &Db, default_root: &Path) -> ScCacheInfo {
    let dir = cache_dir(db, default_root);
    let mut total_bytes = 0i64;
    let mut file_count = 0i64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_cached_audio_file(&path)
                || !path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(|stem| {
                        !stem.is_empty()
                            && stem.len() <= 32
                            && stem.bytes().all(|byte| byte.is_ascii_digit())
                    })
            {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() && meta.len() > 0 {
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

/// `wait_for_cache` blocks until a complete local file is available. Otherwise
/// playback starts from the remote URL while the same cache path runs in the
/// background.
pub async fn get_playback(
    db: Arc<Db>,
    default_root: PathBuf,
    covers_dir: PathBuf,
    track_id: &str,
    permalink_url: Option<&str>,
    ytdlp_configured: &str,
    bin_dir: &Path,
    force_ytdlp: bool,
    app: Option<AppHandle>,
    wait_for_cache: bool,
) -> Result<ScPlayback, String> {
    let dir = cache_dir(&db, &default_root);
    if track_id.is_empty()
        || track_id.len() > 32
        || !track_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("invalid SoundCloud track ID".to_string());
    }
    if let Some(cached) = find_cached_file(&dir, track_id) {
        // Older cache files can outlive their catalog rows. Playback remains
        // offline-capable; creating a new row still requires source metadata.
        if has_library_row(&db, track_id)? {
            finalize_cached_file(&db, &dir, &covers_dir, track_id)?;
        }
        return Ok(local_playback(&cached));
    }

    let options = CacheOptions {
        bin_dir: bin_dir.to_path_buf(),
        ytdlp_path: ytdlp_configured.to_string(),
    };
    let stream_info = if force_ytdlp {
        resolve_browser_stream(app.as_ref(), track_id, permalink_url).await
    } else {
        resolve_cache_stream(app.as_ref(), track_id, permalink_url).await
    };
    let info = match stream_info {
        Ok(crate::soundcloud::TrackStream::Clear(info)) => info,
        Ok(crate::soundcloud::TrackStream::Protected { duration }) => {
            crate::soundcloud_browser::reserve_startup();
            // Playback must not wait for a full browser recording, even when
            // cache-before-play is enabled. The common per-ID lock deduplicates
            // this job with likes, playlist imports and recommendation caching.
            if let Some(cache_app) = app.clone() {
                let track_id = track_id.to_string();
                let permalink = permalink_url.map(str::to_string);
                tokio::spawn(async move {
                    let _ = ensure_cached_file(db, dir, covers_dir, &track_id,
                        permalink.as_deref(), CacheResolution::Protected(duration), options,
                        Some(cache_app.clone()), None, true, Some(cache_app)).await;
                });
            }
            return Ok(ScPlayback { url: None, cached_path: None, format: None, browser_duration: Some(duration) });
        }
        Err(stream_error) => {
            let cached = ensure_cached_file(
                db.clone(),
                dir.clone(),
                covers_dir.clone(),
                track_id,
                permalink_url,
                CacheResolution::YtDlpOnly(stream_error.clone()),
                options,
                app.clone(),
                None,
                true,
                app.clone(),
            )
            .await
            .map_err(|fallback_error| {
                format!("{stream_error}; yt-dlp download fallback: {fallback_error}")
            })?;
            return Ok(local_playback(&cached));
        }
    };
    let format = Some(info.format.clone());

    // A concurrent prefetch may have completed while stream metadata was
    // loading. Prefer the local copy instead of reopening the remote URL.
    if let Some(cached) = find_cached_file(&dir, track_id) {
        if has_library_row(&db, track_id)? {
            finalize_cached_file(&db, &dir, &covers_dir, track_id)?;
        }
        return Ok(local_playback(&cached));
    }
    if wait_for_cache || force_ytdlp {
        match ensure_cached_file(
            db.clone(),
            dir.clone(),
            covers_dir.clone(),
            track_id,
            permalink_url,
            CacheResolution::Known(info.clone()),
            options.clone(),
            app.clone(),
            None,
            true,
            app.clone(),
        )
        .await
        {
            Ok(cached) => return Ok(local_playback(&cached)),
            Err(error) => {
                if force_ytdlp {
                    return Err(format!(
                        "could not create a local SoundCloud fallback for track {track_id}: {error}"
                    ));
                }
                eprintln!("[tempo SoundCloud cache] cache-before-play failed for track {track_id}: {error}");
                return Ok(ScPlayback {
                    url: Some(info.url),
                    cached_path: None,
                    format,
                    browser_duration: None,
                });
            }
        }
    }
    let background_track_id = track_id.to_string();
    let background_info = info.clone();
    let remote_url = info.url.clone();
    let background_db = db.clone();
    let background_dir = dir.clone();
    let background_covers_dir = covers_dir.clone();
    let background_app = app.clone();
    let background_options = options.clone();
    let background_permalink = permalink_url.map(str::to_string);
    tokio::spawn(async move {
        if let Err(error) = ensure_cached_file(
            background_db,
            background_dir,
            background_covers_dir,
            &background_track_id,
            background_permalink.as_deref(),
            CacheResolution::Known(background_info),
            background_options,
            background_app.clone(),
            None,
            true,
            background_app,
        )
        .await
        {
            eprintln!("[tempo SoundCloud cache] background cache failed for track {background_track_id}: {error}");
        }
    });
    Ok(ScPlayback {
        url: Some(remote_url),
        cached_path: None,
        format,
        browser_duration: None,
    })
}

async fn resolve_cache_stream(
    app: Option<&AppHandle>,
    track_id: &str,
    permalink_url: Option<&str>,
) -> Result<crate::soundcloud::TrackStream, String> {
    match crate::soundcloud::get_track_stream(track_id).await {
        Ok(info) => Ok(info),
        Err(native_error) => match resolve_browser_stream(app, track_id, permalink_url).await {
            Ok(info) => Ok(info),
            Err(browser_error) => Err(format!(
                "{native_error}; browser stream fallback: {browser_error}"
            )),
        },
    }
}

async fn resolve_browser_stream(
    app: Option<&AppHandle>,
    track_id: &str,
    permalink_url: Option<&str>,
) -> Result<crate::soundcloud::TrackStream, String> {
    let app = app.ok_or_else(|| {
        "SoundCloud browser stream fallback requires the application context".to_string()
    })?;
    crate::soundcloud_web::resolve_track(app.clone(), track_id, permalink_url).await
}

fn local_playback(path: &Path) -> ScPlayback {
    ScPlayback {
        url: None,
        cached_path: Some(path.to_string_lossy().to_string()),
        format: None,
        browser_duration: None,
    }
}

async fn precache_for_job(
    db: Arc<Db>,
    default_root: PathBuf,
    covers_dir: PathBuf,
    track_id: &str,
    options: CacheOptions,
    progress_app: AppHandle,
) -> Result<(), String> {
    let dir = cache_dir(&db, &default_root);
    ensure_cached_file(
        db,
        dir,
        covers_dir,
        track_id,
        None,
        CacheResolution::Resolve,
        options,
        Some(progress_app.clone()),
        None,
        false,
        Some(progress_app),
    )
    .await
    .map(|_| ())
}

/// Downloads a queued SoundCloud track and creates its library row only after
/// the file exists. This prevents an ahead-of-play download from being exposed
/// as an uncached, metadata-free library item if the download fails.
pub async fn precache_track(
    db: Arc<Db>,
    default_root: PathBuf,
    covers_dir: PathBuf,
    track: &crate::soundcloud::ScTrack,
    options: CacheOptions,
    app: Option<AppHandle>,
) -> Result<(), String> {
    if track.id.is_empty()
        || track.id.len() > 32
        || !track.id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("invalid SoundCloud track ID".into());
    }
    let dir = cache_dir(&db, &default_root);
    ensure_cached_file(
        db,
        dir,
        covers_dir,
        &track.id,
        track.permalink_url.as_deref(),
        CacheResolution::Resolve,
        options,
        app.clone(),
        Some(track),
        true,
        app,
    )
    .await
    .map(|_| ())
}

enum CacheResolution {
    Resolve,
    Known(crate::soundcloud::StreamInfo),
    YtDlpOnly(String),
    Protected(f64),
}

/// Downloads one ID once even when playback and queue prefetch reach it at the
/// same time. The completed path is checked again under the per-file lock,
/// before either path writes the shared temporary file.
async fn ensure_cached_file(
    db: Arc<Db>,
    dir: PathBuf,
    covers_dir: PathBuf,
    track_id: &str,
    permalink_url: Option<&str>,
    resolution: CacheResolution,
    options: CacheOptions,
    app: Option<AppHandle>,
    library_track: Option<&crate::soundcloud::ScTrack>,
    notify_library: bool,
    progress_app: Option<AppHandle>,
) -> Result<PathBuf, String> {
    if track_id.is_empty()
        || track_id.len() > 32
        || !track_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("invalid SoundCloud track ID".into());
    }
    let result = ensure_cached_file_locked(
        db,
        dir,
        covers_dir,
        track_id,
        permalink_url,
        resolution,
        options,
        app.clone(),
        library_track,
        notify_library,
        progress_app.as_ref(),
    )
    .await;
    match &result {
        Ok(path) => {
            let size = std::fs::metadata(path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            emit_track_cache_progress(progress_app.as_ref(), track_id, size, size, "done", None);
        }
        Err(error) => {
            emit_track_cache_progress(progress_app.as_ref(), track_id, 0, 0, "failed", Some(error))
        }
    }
    result
}

async fn ensure_cached_file_locked(
    db: Arc<Db>,
    dir: PathBuf,
    covers_dir: PathBuf,
    track_id: &str,
    permalink_url: Option<&str>,
    resolution: CacheResolution,
    options: CacheOptions,
    app: Option<AppHandle>,
    library_track: Option<&crate::soundcloud::ScTrack>,
    notify_library: bool,
    progress_app: Option<&AppHandle>,
) -> Result<PathBuf, String> {
    let lock = cache_download_lock(&cache_lock_path(&dir, track_id));
    let _guard = lock.lock().await;
    if find_cached_file(&dir, track_id).is_some() {
        if let Some(track) = library_track {
            db.upsert_sc_track(
                &track.id,
                &track.title,
                &track.artist,
                track.duration_ms,
                track.artwork_url.as_deref(),
            )?;
        }
        let path = finalize_cached_file(&db, &dir, &covers_dir, track_id)?;
        if notify_library {
            if let Some(app) = app.as_ref() {
                let _ = app.emit(LIBRARY_CHANGED_EVENT, track_id.to_string());
            }
        }
        return Ok(path);
    }

    emit_track_cache_progress(progress_app, track_id, 0, 0, "running", None);

    let mut errors = Vec::new();
    let mut attempted_urls = HashSet::new();
    let mut first_info = None;
    let try_browser_after_stream = match resolution {
        CacheResolution::Resolve => match crate::soundcloud::get_track_stream(track_id).await {
            Ok(crate::soundcloud::TrackStream::Clear(info)) => {
                first_info = Some(info);
                true
            }
            Ok(crate::soundcloud::TrackStream::Protected { duration }) => {
                return record_protected_cache(&db, &dir, &covers_dir, track_id, duration,
                    library_track, notify_library, app.as_ref(), progress_app).await;
            }
            Err(error) => {
                errors.push(error);
                true
            }
        },
        CacheResolution::Known(info) => {
            first_info = Some(info);
            true
        }
        CacheResolution::YtDlpOnly(error) => {
            errors.push(error);
            false
        }
        CacheResolution::Protected(duration) => {
            return record_protected_cache(&db, &dir, &covers_dir, track_id, duration,
                library_track, notify_library, app.as_ref(), progress_app).await;
        }
    };

    if let Some(info) = first_info {
        attempted_urls.insert(info.url.clone());
        match cache_download::download_stream(&info, &dir, track_id, &options.bin_dir, progress_app)
            .await
        {
            Ok(path) => {
                return finalize_completed_download(
                    &db,
                    &dir,
                    &covers_dir,
                    track_id,
                    path,
                    library_track,
                    notify_library,
                    app.as_ref(),
                )
            }
            Err(error) => errors.push(error),
        }
    }

    if try_browser_after_stream {
        if let Some(app_handle) = app.as_ref() {
            match crate::soundcloud_web::resolve_track(app_handle.clone(), track_id, permalink_url)
                .await
            {
                Ok(crate::soundcloud::TrackStream::Protected { duration }) => {
                    return record_protected_cache(&db, &dir, &covers_dir, track_id, duration,
                        library_track, notify_library, app.as_ref(), progress_app).await;
                }
                Ok(crate::soundcloud::TrackStream::Clear(info)) if attempted_urls.insert(info.url.clone()) => {
                    match cache_download::download_stream(
                        &info,
                        &dir,
                        track_id,
                        &options.bin_dir,
                        progress_app,
                    )
                    .await
                    {
                        Ok(path) => {
                            return finalize_completed_download(
                                &db,
                                &dir,
                                &covers_dir,
                                track_id,
                                path,
                                library_track,
                                notify_library,
                                app.as_ref(),
                            )
                        }
                        Err(error) => errors.push(error),
                    }
                }
                Ok(_) => {}
                Err(error) => errors.push(format!("browser stream fallback: {error}")),
            }
        }
    }

    match download_ytdlp_to_cache(&dir, track_id, permalink_url, &options, progress_app).await {
        Ok(path) => {
            return finalize_completed_download(
                &db,
                &dir,
                &covers_dir,
                track_id,
                path,
                library_track,
                notify_library,
                app.as_ref(),
            )
        }
        Err(error) => errors.push(format!("yt-dlp fallback: {error}")),
    }

    Err(if errors.is_empty() {
        "SoundCloud track has no downloadable stream".into()
    } else {
        errors.join("; ")
    })
}

async fn record_protected_cache(
    db: &Db, dir: &Path, covers_dir: &Path, track_id: &str, duration: f64,
    library_track: Option<&crate::soundcloud::ScTrack>, notify_library: bool,
    app: Option<&AppHandle>, progress_app: Option<&AppHandle>,
) -> Result<PathBuf, String> {
    let app = app.ok_or("SoundCloud browser recording requires the running player")?;
    let session = crate::soundcloud_session::status(app.clone()).await?;
    if !session.browser_available {
        return Err("Sign in to SoundCloud in Settings → About to cache this track".into());
    }
    let stage = cache_download::unique_stage_path(dir, track_id, "opus.part");
    let progress_app = progress_app.cloned();
    let progress_id = track_id.to_owned();
    let progress = Arc::new(move |fraction: f64| {
        if let Some(app) = progress_app.as_ref() {
            let _ = app.emit(CACHE_TRACK_PROGRESS_EVENT, serde_json::json!({
                "trackId": progress_id, "downloadedBytes": 0, "totalBytes": 0,
                "state": "running", "progress": fraction.clamp(0.0, 0.99),
                "phase": if fraction >= 0.9 { "finalizing" } else { "recording" }
            }));
        }
    });
    let result = crate::soundcloud_recording::capture(app.clone(), track_id, duration, &stage,
        Arc::new(std::sync::atomic::AtomicBool::new(false)), progress).await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&stage).await;
        return Err(error);
    }
    let final_path = dir.join(format!("{track_id}.opus"));
    if let Err(error) = cache_download::promote_staged_file(&stage, &final_path) {
        let _ = tokio::fs::remove_file(&stage).await;
        return Err(error);
    }
    finalize_completed_download(db, dir, covers_dir, track_id, final_path,
        library_track, notify_library, Some(app))
}

fn finalize_completed_download(
    db: &Db,
    dir: &Path,
    covers_dir: &Path,
    track_id: &str,
    path: PathBuf,
    library_track: Option<&crate::soundcloud::ScTrack>,
    notify_library: bool,
    app: Option<&AppHandle>,
) -> Result<PathBuf, String> {
    if let Some(track) = library_track {
        db.upsert_sc_track(
            &track.id,
            &track.title,
            &track.artist,
            track.duration_ms,
            track.artwork_url.as_deref(),
        )?;
    }
    let finalized = finalize_cached_file(db, dir, covers_dir, track_id)?;
    enforce_cache_limit(db, dir, cache_limit(db));
    if find_cached_file(dir, track_id).is_none() {
        return Err(
            "the completed SoundCloud cache file was evicted by the configured cache limit".into(),
        );
    }
    if finalized != path {
        return Err(
            "SoundCloud cache finalization selected a different file than the completed download"
                .into(),
        );
    }
    if notify_library {
        if let Some(app) = app {
            let _ = app.emit(LIBRARY_CHANGED_EVENT, track_id.to_string());
        }
    }
    Ok(finalized)
}

async fn download_ytdlp_to_cache(
    dir: &Path,
    track_id: &str,
    _permalink: Option<&str>,
    options: &CacheOptions,
    progress_app: Option<&AppHandle>,
) -> Result<PathBuf, String> {
    // A permalink can be renamed or stale; never cache another slug's audio
    // under the requested ID. `ensure_cached_file` validates the numeric ID.
    let permalink = format!("https://api.soundcloud.com/tracks/{track_id}");
    let dir = dir.to_path_buf();
    let track_id = track_id.to_string();
    let permalink = permalink.to_string();
    let configured = options.ytdlp_path.clone();
    let bin_dir = options.bin_dir.clone();
    let output_base = cache_download::unique_stage_base(&dir, &track_id);
    let cleanup_base = output_base.clone();
    emit_track_cache_progress(progress_app, &track_id, 0, 0, "running", None);
    let download = match tokio::task::spawn_blocking(move || {
        crate::ytdlp::download_soundcloud(&configured, &bin_dir, &permalink, &output_base)
    })
    .await
    {
        Ok(Ok(path)) => path,
        Ok(Err(error)) => {
            cache_download::cleanup_staged_base(&dir, &cleanup_base);
            return Err(error);
        }
        Err(error) => {
            cache_download::cleanup_staged_base(&dir, &cleanup_base);
            return Err(format!("yt-dlp worker failed: {error}"));
        }
    };

    let result = (|| {
        if !is_cached_audio_file(&download) {
            return Err("yt-dlp returned an unsupported audio container".into());
        }
        let metadata = std::fs::metadata(&download)
            .map_err(|error| format!("Could not inspect yt-dlp output: {error}"))?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err("yt-dlp produced an empty audio file".into());
        }
        let extension = download
            .extension()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "yt-dlp output has no audio extension".to_string())?;
        let final_path = dir.join(format!("{track_id}.{}", extension.to_ascii_lowercase()));
        cache_download::promote_staged_file(&download, &final_path)?;
        Ok(final_path)
    })();
    cache_download::cleanup_staged_base(&dir, &cleanup_base);
    result
}

/// Emitted while a cache job runs: `{ jobId, label, done, total, failed, state }`.
pub const CACHE_PROGRESS_EVENT: &str = "sc-cache://progress";
pub const CACHE_TRACK_PROGRESS_EVENT: &str = "sc-cache://track-progress";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTrackProgress {
    pub track_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn emit_track_cache_progress(
    app: Option<&AppHandle>,
    track_id: &str,
    downloaded_bytes: u64,
    total_bytes: u64,
    state: &'static str,
    error: Option<&str>,
) {
    let Some(app) = app else { return };
    let _ = app.emit(
        CACHE_TRACK_PROGRESS_EVENT,
        CacheTrackProgress {
            track_id: track_id.to_string(),
            downloaded_bytes,
            total_bytes,
            state,
            error: error.map(str::to_string),
        },
    );
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheProgress {
    pub job_id: String,
    pub label: String,
    pub done: u32,
    pub total: u32,
    pub failed: u32,
    /// "running" | "done" | "cancelled"
    pub state: &'static str,
}

fn active_jobs() -> &'static tokio::sync::Mutex<HashMap<String, bool>> {
    static ACTIVE: OnceLock<tokio::sync::Mutex<HashMap<String, bool>>> = OnceLock::new();
    ACTIVE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// Asks a running job to stop once the track it is on has finished.
pub async fn cancel_job(job_id: &str) {
    if let Some(cancelled) = active_jobs().lock().await.get_mut(job_id) {
        *cancelled = true;
    }
}

async fn job_cancelled(job_id: &str) -> bool {
    active_jobs()
        .lock()
        .await
        .get(job_id)
        .copied()
        .unwrap_or(false)
}

fn emit_cache_progress(
    app: &AppHandle,
    job_id: &str,
    label: &str,
    done: u32,
    total: u32,
    failed: u32,
    state: &'static str,
) {
    let _ = app.emit(
        CACHE_PROGRESS_EVENT,
        CacheProgress {
            job_id: job_id.to_string(),
            label: label.to_string(),
            done,
            total,
            failed,
            state,
        },
    );
}

/// Downloads a list of tracks one after another, reporting progress as it goes.
///
/// Serial on purpose: SoundCloud throttles, and firing fifty downloads at once
/// is a good way to have the whole lot refused. Cancellation is checked between
/// tracks rather than mid-download, so a track already coming in finishes
/// instead of leaving a half-written file behind.
pub async fn run_cache_job(
    app: AppHandle,
    db: Arc<Db>,
    default_root: PathBuf,
    covers_dir: PathBuf,
    job_id: String,
    label: String,
    track_ids: Vec<String>,
    options: CacheOptions,
) {
    active_jobs().lock().await.insert(job_id.clone(), false);
    let total = track_ids.len() as u32;
    let mut done = 0u32;
    let mut failed = 0u32;
    let mut state: &'static str = "done";

    emit_cache_progress(&app, &job_id, &label, done, total, failed, "running");

    for id in track_ids {
        if job_cancelled(&job_id).await {
            state = "cancelled";
            break;
        }
        // `None` for the app handle: letting each track emit its own library
        // change would make the library refetch once per track. One event at
        // the end is enough.
        if precache_for_job(
            db.clone(),
            default_root.clone(),
            covers_dir.clone(),
            &id,
            options.clone(),
            app.clone(),
        )
        .await
        .is_err()
        {
            failed += 1;
        } else {
            // A track only gains a cover once it is downloaded and its tags are
            // read, so its album can only pick one up now.
            let _ = db.fill_album_cover_for_sc(&id);
        }
        done += 1;
        emit_cache_progress(&app, &job_id, &label, done, total, failed, "running");
    }

    active_jobs().lock().await.remove(&job_id);
    let _ = app.emit(LIBRARY_CHANGED_EVENT, String::new());
    emit_cache_progress(&app, &job_id, &label, done, total, failed, state);
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

fn cache_lock_path(dir: &Path, track_id: &str) -> PathBuf {
    dir.join(format!("{track_id}.cache-lock"))
}

/// Finds a cached file regardless of the audio container selected by yt-dlp.
pub fn find_cached_file(dir: &Path, track_id: &str) -> Option<PathBuf> {
    if track_id.is_empty() || !track_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    CACHE_AUDIO_EXTENSIONS
        .iter()
        .map(|extension| dir.join(format!("{track_id}.{extension}")))
        .find(|path| {
            path.metadata()
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
        })
}

pub fn is_cached_audio_file(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    CACHE_AUDIO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
}

/// Cache-only read: never resolves a stream, starts a download or creates dirs.
pub fn existing_cached_file(
    db: &Db,
    default_root: &Path,
    track_id: &str,
) -> Result<Option<PathBuf>, String> {
    if track_id.is_empty() || track_id.len() > 32 || !track_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid SoundCloud track ID".into());
    }
    let root = db
        .get_app_setting(CACHE_DIR_KEY)?
        .map(PathBuf::from)
        .unwrap_or_else(|| default_root.to_path_buf());
    let root = match std::fs::canonicalize(root) {
        Ok(root) => root,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let Some(path) = find_cached_file(&root, track_id) else {
        return Ok(None);
    };
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if canonical.parent() != Some(root.as_path()) {
        return Err("SoundCloud cache file is outside its cache directory".into());
    }
    Ok(Some(canonical))
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
        std::fs::write(cache.join("101.mp3"), vec![0u8; 100]).unwrap();
        std::fs::write(cache.join("102.mp3"), vec![0u8; 25]).unwrap();
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
        let bin_dir = root.join("bin");
        let playback = get_playback(
            Arc::new(db),
            root.join("default"),
            root.join("covers"),
            "999",
            None,
            "",
            &bin_dir,
            false,
            None,
            false,
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
            c.execute(
                "UPDATE tracks SET cached_at = 1 WHERE external_id = '202'",
                [],
            )
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
