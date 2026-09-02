use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::database::Db;
use crate::models::{
    Album, AlbumDetail, AnalyticsData, Artist, ArtistDetail, CoversCacheInfo, HistoryEntryDto,
    LibraryFolder, Playlist, PlaylistTrack, ScanPhase, ScanProgress, ScanSummary, SearchResults,
    Track,
};
use crate::scanner;

pub struct AppState {
    pub db: Arc<Db>,
    pub covers_dir: PathBuf,
    pub fonts_dir: PathBuf,
    pub backgrounds_dir: PathBuf,
    pub avatars_dir: PathBuf,
    pub sc_cache_dir: PathBuf,
}

const SCAN_EVENT: &str = "scan://progress";
const PROGRESS_INTERVAL_MS: u64 = 150;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn clean_unc(path: &Path) -> String {
    let s = path.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn is_under(path: &str, root: &str) -> bool {
    let p = path.replace('/', "\\").to_lowercase();
    let r = root.replace('/', "\\").to_lowercase();
    let r = r.trim_end_matches('\\');
    p.starts_with(&format!("{r}\\"))
}

fn emit_progress(
    app: &AppHandle,
    phase: ScanPhase,
    scanned_files: u32,
    added: u32,
    updated: u32,
    removed: u32,
    unchanged: u32,
    errors: u32,
    current_file: Option<String>,
) {
    let _ = app.emit(
        SCAN_EVENT,
        ScanProgress {
            phase,
            scanned_files,
            added,
            updated,
            removed,
            unchanged,
            errors,
            current_file,
        },
    );
}

fn scan_folder_blocking(
    db: &Db,
    covers_dir: &Path,
    app: &AppHandle,
    folder_id: i64,
    root: &str,
    force: bool,
) -> Result<ScanSummary, String> {
    let started = Instant::now();
    emit_progress(app, ScanPhase::Started, 0, 0, 0, 0, 0, 0, None);

    let known: HashMap<String, crate::models::FileStamp> = if force {
        HashMap::new()
    } else {
        db.list_file_stamps()?
            .into_iter()
            .filter(|(p, _)| is_under(p, root))
            .collect()
    };

    let last_emit = Arc::new(AtomicU64::new(now_millis()));
    let emitter_app = app.clone();
    let throttle = last_emit.clone();
    let on_tick = move |tick: scanner::Tick| {
        let now = now_millis();
        let prev = throttle.load(Ordering::Relaxed);
        if now.saturating_sub(prev) >= PROGRESS_INTERVAL_MS
            && throttle
                .compare_exchange(prev, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            emit_progress(
                &emitter_app,
                ScanPhase::Progress,
                tick.scanned_files,
                0,
                0,
                0,
                0,
                0,
                tick.current_file,
            );
        }
    };

    let outcome = scanner::scan_incremental(Path::new(root), folder_id, &known, covers_dir, &on_tick);

    let (added, updated) = db.upsert_scanned_tracks(&outcome.new, &outcome.updated)?;
    let removed_count = db.delete_tracks_by_paths(&outcome.removed)?;

    let summary = ScanSummary {
        scanned_files: outcome.scanned_files,
        added,
        updated,
        removed: removed_count,
        unchanged: outcome.unchanged,
        errors: outcome.errors,
        duration_ms: started.elapsed().as_millis() as u64,
    };
    emit_progress(
        app,
        ScanPhase::Completed,
        summary.scanned_files,
        summary.added,
        summary.updated,
        summary.removed,
        summary.unchanged,
        summary.errors,
        None,
    );
    Ok(summary)
}

fn scan_folders_sequential(
    db: &Db,
    covers_dir: &Path,
    app: &AppHandle,
    force: bool,
) -> Result<ScanSummary, String> {
    let folders = db.list_library_folders()?;
    let mut total = ScanSummary {
        scanned_files: 0,
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: 0,
        errors: 0,
        duration_ms: 0,
    };
    let mut failures = 0usize;
    for folder in folders {
        match scan_folder_blocking(db, covers_dir, app, folder.id, &folder.path, force) {
            Ok(s) => {
                total.scanned_files += s.scanned_files;
                total.added += s.added;
                total.updated += s.updated;
                total.removed += s.removed;
                total.unchanged += s.unchanged;
                total.errors += s.errors;
                total.duration_ms += s.duration_ms;
            }
            Err(_) => failures += 1,
        }
    }
    if failures > 0 && total.scanned_files == 0 {
        return Err(format!("{failures} folder(s) failed to scan"));
    }
    Ok(total)
}

fn get_folder_path(state: &AppState, folder_id: i64) -> Result<String, String> {
    state
        .db
        .list_library_folders()?
        .into_iter()
        .find(|f| f.id == folder_id)
        .map(|f| f.path)
        .ok_or_else(|| "folder not found".to_string())
}

#[tauri::command]
pub fn get_library_folders(state: State<'_, AppState>) -> Result<Vec<LibraryFolder>, String> {
    state.db.list_library_folders()
}

#[tauri::command]
pub fn add_library_folder(state: State<'_, AppState>, path: String) -> Result<LibraryFolder, String> {
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("invalid folder: {e}"))?;
    let clean = clean_unc(&canonical);
    state.db.add_library_folder(&clean)
}

#[tauri::command]
pub fn remove_library_folder(state: State<'_, AppState>, folder_id: i64) -> Result<(), String> {
    state.db.remove_library_folder(folder_id)?;
    state.db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM artists WHERE id NOT IN (SELECT DISTINCT artist_id FROM tracks WHERE artist_id IS NOT NULL)",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn rescan_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    folder_id: i64,
    force: Option<bool>,
) -> Result<ScanSummary, String> {
    let root = get_folder_path(&state, folder_id)?;
    let db = state.db.clone();
    let covers = state.covers_dir.clone();
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        scan_folder_blocking(&db, &covers, &app, folder_id, &root, force)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rescan_library(
    app: AppHandle,
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<ScanSummary, String> {
    let db = state.db.clone();
    let covers = state.covers_dir.clone();
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || scan_folders_sequential(&db, &covers, &app, force))
        .await
        .map_err(|e| e.to_string())?
}

pub fn startup_rescan(app: AppHandle) {
    let state = app.state::<AppState>();
    let _ = scan_folders_sequential(&state.db, &state.covers_dir, &app, false);
}

#[tauri::command]
pub fn list_tracks(
    state: State<'_, AppState>,
    query: String,
    limit: i64,
    offset: i64,
    sort: Option<String>,
) -> Result<Vec<Track>, String> {
    state
        .db
        .list_tracks_sorted(&query, sort.as_deref().unwrap_or("added"), limit, offset)
}

#[tauri::command]
pub fn count_tracks(state: State<'_, AppState>) -> Result<i64, String> {
    state.db.count_tracks()
}

#[tauri::command]
pub fn search_all(state: State<'_, AppState>, query: String) -> Result<SearchResults, String> {
    state.db.search_all(&query)
}

#[tauri::command]
pub fn list_albums(state: State<'_, AppState>, query: String) -> Result<Vec<Album>, String> {
    state.db.list_albums(&query)
}

#[tauri::command]
pub fn get_album(state: State<'_, AppState>, album_id: i64) -> Result<AlbumDetail, String> {
    state
        .db
        .get_album_detail(album_id)?
        .ok_or_else(|| "album not found".to_string())
}

#[tauri::command]
pub fn list_artists(state: State<'_, AppState>, query: String) -> Result<Vec<Artist>, String> {
    state.db.list_artists(&query)
}

#[tauri::command]
pub fn get_artist(state: State<'_, AppState>, artist_id: i64) -> Result<ArtistDetail, String> {
    state
        .db
        .get_artist_detail(artist_id)?
        .ok_or_else(|| "artist not found".to_string())
}

#[tauri::command]
pub fn create_playlist(state: State<'_, AppState>, name: String) -> Result<Playlist, String> {
    state.db.create_playlist(&name)
}

#[tauri::command]
pub fn rename_playlist(state: State<'_, AppState>, playlist_id: i64, name: String) -> Result<(), String> {
    state.db.rename_playlist(playlist_id, &name)
}

#[tauri::command]
pub fn delete_playlist(state: State<'_, AppState>, playlist_id: i64) -> Result<(), String> {
    state.db.delete_playlist(playlist_id)
}

#[tauri::command]
pub fn list_playlists(state: State<'_, AppState>) -> Result<Vec<Playlist>, String> {
    state.db.list_playlists()
}

#[tauri::command]
pub fn get_playlist(state: State<'_, AppState>, playlist_id: i64) -> Result<Vec<PlaylistTrack>, String> {
    state.db.get_playlist_tracks(playlist_id)
}

#[tauri::command]
pub fn playlist_add_track(state: State<'_, AppState>, playlist_id: i64, track_id: i64) -> Result<(), String> {
    state.db.playlist_add_track(playlist_id, track_id)
}

#[tauri::command]
pub fn playlist_remove_track(state: State<'_, AppState>, playlist_id: i64, track_id: i64) -> Result<(), String> {
    state.db.playlist_remove_track(playlist_id, track_id)
}

#[tauri::command]
pub fn playlist_move_track(
    state: State<'_, AppState>,
    playlist_id: i64,
    from_pos: i64,
    to_pos: i64,
) -> Result<(), String> {
    state.db.playlist_move_track(playlist_id, from_pos, to_pos)
}

#[tauri::command]
pub fn bump_play_count(state: State<'_, AppState>, track_id: i64) -> Result<(), String> {
    state.db.bump_play_count(track_id)
}

#[tauri::command]
pub fn record_history(
    state: State<'_, AppState>,
    track_id: i64,
    listened_sec: Option<f64>,
    completed: bool,
    skipped: bool,
) -> Result<(), String> {
    state.db.record_history(track_id, listened_sec, completed, skipped)
}

fn import_file_into(dir: &Path, src: &str) -> Result<String, String> {
    let src_path = Path::new(src);
    let file_name = src_path
        .file_name()
        .ok_or_else(|| "invalid file name".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dest = dir.join(file_name);
    std::fs::copy(src_path, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn import_font(state: State<'_, AppState>, path: String) -> Result<String, String> {
    import_file_into(&state.fonts_dir, &path)
}

#[tauri::command]
pub fn import_background(state: State<'_, AppState>, path: String) -> Result<String, String> {
    import_file_into(&state.backgrounds_dir, &path)
}

#[tauri::command]
pub fn import_avatar(state: State<'_, AppState>, path: String) -> Result<String, String> {
    import_file_into(&state.avatars_dir, &path)
}

#[tauri::command]
pub fn import_artist_image(
    state: State<'_, AppState>,
    artist_id: i64,
    path: String,
) -> Result<(), String> {
    let src = PathBuf::from(&path);
    let file_name = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "invalid file name".to_string())?;
    let dir = state.avatars_dir.join("artists");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{}-{}", artist_id, file_name));
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    state.db.set_artist_image(artist_id, Some(&dest.to_string_lossy()))
}

#[tauri::command]
pub fn set_playlist_pinned(state: State<'_, AppState>, playlist_id: i64, pinned: bool) -> Result<(), String> {
    state.db.set_playlist_pinned(playlist_id, pinned)
}

#[tauri::command]
pub fn move_pinned_playlist(state: State<'_, AppState>, playlist_id: i64, new_order: i64) -> Result<(), String> {
    state.db.move_pinned_playlist(playlist_id, new_order)
}

#[tauri::command]
pub fn get_app_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    state.db.get_app_setting(&key)
}

#[tauri::command]
pub fn set_app_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    state.db.set_app_setting(&key, &value)
}

#[tauri::command]
pub fn get_track_lyrics(state: State<'_, AppState>, track_id: i64) -> Result<Option<String>, String> {
    state.db.get_track_lyrics(track_id)
}

#[tauri::command]
pub fn get_analytics(state: State<'_, AppState>, since_secs: Option<i64>) -> Result<AnalyticsData, String> {
    state.db.get_analytics(since_secs, 10, 20)
}

#[tauri::command]
pub fn get_history(state: State<'_, AppState>, limit: i64, offset: i64) -> Result<Vec<HistoryEntryDto>, String> {
    state.db.get_history_page(None, limit, offset)
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> Result<u32, String> {
    state.db.clear_history()
}

fn covers_cache_info(dir: &Path) -> CoversCacheInfo {
    let mut total_bytes = 0i64;
    let mut file_count = 0i64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total_bytes += meta.len() as i64;
                    file_count += 1;
                }
            }
        }
    }
    CoversCacheInfo {
        path: dir.to_string_lossy().into_owned(),
        total_bytes,
        file_count,
    }
}

#[tauri::command]
pub fn get_covers_cache_info(state: State<'_, AppState>) -> Result<CoversCacheInfo, String> {
    Ok(covers_cache_info(&state.covers_dir))
}

#[tauri::command]
pub fn clear_covers_cache(state: State<'_, AppState>) -> Result<(), String> {
    let dir = &state.covers_dir;
    if dir.exists() {
        let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
        }
    }
    state.db.reset_cover_refs()?;
    Ok(())
}

#[tauri::command]
pub fn set_taskbar_progress(
    app: AppHandle,
    position: f64,
    duration: f64,
    playing: Option<bool>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let progress_state = if duration > 0.0 {
        let frac = (position / duration).clamp(0.0, 1.0);
        let status = if playing.unwrap_or(false) {
            tauri::window::ProgressBarStatus::Normal
        } else {
            tauri::window::ProgressBarStatus::Paused
        };
        tauri::window::ProgressBarState {
            status: Some(status),
            progress: Some((frac * 100.0) as u64),
        }
    } else {
        tauri::window::ProgressBarState {
            status: Some(tauri::window::ProgressBarStatus::None),
            progress: None,
        }
    };
    window.set_progress_bar(progress_state).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sc_search_tracks(query: String, limit: u32, offset: u32) -> Result<Vec<crate::soundcloud::ScTrack>, String> {
    crate::soundcloud::search_tracks(&query, limit, offset).await
}

#[tauri::command]
pub async fn sc_stream_url(track_id: String) -> Result<String, String> {
    crate::soundcloud::get_stream_url(&track_id).await
}

#[tauri::command]
pub async fn fetch_online_lyrics(
    artist: String,
    title: String,
) -> Result<Option<crate::lyrics::OnlineLyrics>, String> {
    crate::lyrics::fetch_online_lyrics(&artist, &title).await
}

#[tauri::command]
pub async fn fetch_online_lyrics_all(
    artist: String,
    title: String,
) -> Result<Vec<crate::lyrics::OnlineLyricsCandidate>, String> {
    crate::lyrics::fetch_online_lyrics_all(&artist, &title).await
}

#[tauri::command]
pub async fn sc_get_playback(
    app: AppHandle,
    state: State<'_, AppState>,
    track_id: String,
) -> Result<crate::soundcloud_store::ScPlayback, String> {
    let root = crate::soundcloud_store::cache_dir(&state.db, &state.sc_cache_dir);
    crate::soundcloud_store::get_playback(
        state.db.clone(),
        root,
        state.covers_dir.clone(),
        &track_id,
        Some(app),
    )
    .await
}

#[tauri::command]
pub async fn add_sc_track_to_playlist(
    app: AppHandle,
    state: State<'_, AppState>,
    playlist_id: i64,
    track: crate::soundcloud::ScTrack,
) -> Result<i64, String> {
    let track_id = state.db.upsert_sc_track(
        &track.id,
        &track.title,
        &track.artist,
        track.duration_ms,
        track.artwork_url.as_deref(),
    )?;
    state.db.playlist_add_track(playlist_id, track_id)?;
    let db = state.db.clone();
    let root = crate::soundcloud_store::cache_dir(&state.db, &state.sc_cache_dir);
    let covers = state.covers_dir.clone();
    let sc_id = track.id.clone();
    tauri::async_runtime::spawn(async move {
        crate::soundcloud_store::precache(db, root, covers, &sc_id, Some(app)).await;
    });
    Ok(track_id)
}

#[tauri::command]
pub fn sc_upsert_track(state: State<'_, AppState>, track: crate::soundcloud::ScTrack) -> Result<i64, String> {
    state.db.upsert_sc_track(
        &track.id,
        &track.title,
        &track.artist,
        track.duration_ms,
        track.artwork_url.as_deref(),
    )
}

#[tauri::command]
pub fn sc_cache_info(state: State<'_, AppState>) -> Result<crate::soundcloud_store::ScCacheInfo, String> {
    Ok(crate::soundcloud_store::cache_info(&state.db, &state.sc_cache_dir))
}

#[tauri::command]
pub fn set_sc_cache_dir(state: State<'_, AppState>, path: String) -> Result<(), String> {
    crate::soundcloud_store::set_cache_dir(&state.db, &path)
}

#[tauri::command]
pub fn clear_sc_cache(state: State<'_, AppState>) -> Result<(u32, u32), String> {
    crate::soundcloud_store::clear_cache(&state.db, &state.sc_cache_dir)
}

#[tauri::command]
pub fn sc_set_cache_limit(state: State<'_, AppState>, bytes: i64) -> Result<(), String> {
    crate::soundcloud_store::set_cache_limit(&state.db, &state.sc_cache_dir, bytes)
}

#[tauri::command]
pub fn like_track(state: State<'_, AppState>, track_id: i64) -> Result<(), String> {
    state.db.like_track(track_id).map(|_| ())
}

#[tauri::command]
pub fn unlike_track(state: State<'_, AppState>, track_id: i64) -> Result<(), String> {
    state.db.unlike_track(track_id).map(|_| ())
}

#[tauri::command]
pub fn list_liked_track_ids(state: State<'_, AppState>) -> Result<Vec<i64>, String> {
    state.db.list_liked_track_ids()
}

#[tauri::command]
pub fn get_top_tracks(state: State<'_, AppState>, limit: i64) -> Result<Vec<crate::models::TopTrackItem>, String> {
    state.db.get_top_tracks(limit)
}

#[tauri::command]
pub fn get_hour_picks(state: State<'_, AppState>, limit: i64) -> Result<Vec<Track>, String> {
    state.db.get_hour_picks(limit)
}

#[tauri::command]
pub fn get_daily_minutes(state: State<'_, AppState>, days: i64) -> Result<Vec<crate::models::DailyMinutes>, String> {
    state.db.get_daily_minutes(days)
}

#[tauri::command]
pub fn discord_set_presence(
    client_id: String,
    details: String,
    state: Option<String>,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    large_image: Option<String>,
    small_image: Option<String>,
    // reason: why the frontend pushed this update (debug aid, ignored here)
    reason: Option<String>,
) -> Result<(), String> {
    let _ = reason;
    crate::discord::set_presence(client_id, details, state, start_ms, end_ms, large_image, small_image);
    Ok(())
}

#[tauri::command]
pub fn discord_clear_presence() -> Result<(), String> {
    crate::discord::clear_presence();
    Ok(())
}

const IMAGE_HOST_API: &str = "https://freeimage.host/api/1/upload";
/// Published on <https://freeimage.host/api> for anyone to use, so this is a
/// default rather than a secret. Measured against Discord's media proxy: every
/// upload here was proxied on the first try, where catbox answered 502 for half
/// of them - the proxy needs an origin that sends Content-Length and caches.
const IMAGE_HOST_KEY: &str = "6d207e02198a847aa98d0a2a901485a5";
/// identifies Tempo to the image host, as its API guidelines ask for
const USER_AGENT: &str = concat!(
    "Tempo/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/GLIPIYT/tempo-player)"
);
/// the host accepts 64 MB; covers are tiny, the cap just guards against
/// accidentally pushing something absurd
const UPLOAD_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// Discord's media proxy fetches the image itself and gives up on large or slow
/// origins, so covers are normalised to a small jpeg before upload. Library
/// artwork is routinely 3000x3000 / 1.7 MB, which the proxy refused to serve.
const COVER_MAX_EDGE: u32 = 512;

fn cover_mime(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

/// Re-encodes a cover as a small jpeg. Returns None when the image cannot be
/// decoded, in which case the original bytes are uploaded as-is.
fn shrink_cover(data: &[u8]) -> Option<Vec<u8>> {
    let decoded = image::ImageReader::new(std::io::Cursor::new(data))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let sized = if decoded.width().max(decoded.height()) > COVER_MAX_EDGE {
        decoded.resize(
            COVER_MAX_EDGE,
            COVER_MAX_EDGE,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        decoded
    };
    let rgb = sized.to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
        .encode_image(&rgb)
        .ok()?;
    Some(out)
}

/// Warms Discord's media proxy for an `mp:external` reference. The proxy
/// fetches the origin lazily and answers 502 while that is in flight, so
/// without this the very first client to look at the presence sees a broken
/// image placeholder.
///
/// A reference is remembered only once it has actually been served. A failed
/// warm is forgotten, so the next presence update carrying the same reference
/// tries again - the cached url outlives this process, and giving up on it
/// permanently is what left covers broken until the file itself changed.
pub(crate) fn warm_media_proxy(url: String) {
    use std::collections::HashSet;
    use std::sync::Mutex;
    /// references already served, plus the ones being warmed right now
    static WARMED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    fn forget(url: &str) {
        if let Ok(mut guard) = WARMED.lock() {
            if let Some(seen) = guard.as_mut() {
                seen.remove(url);
            }
        }
    }
    {
        let Ok(mut guard) = WARMED.lock() else { return };
        let seen = guard.get_or_insert_with(HashSet::new);
        if !seen.insert(url.clone()) {
            return;
        }
    }
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
        else {
            forget(&url);
            return;
        };
        // the proxy can take well over ten seconds to ingest a fresh origin
        for attempt in 0..8u32 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(2 * attempt as u64)).await;
            }
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    #[cfg(debug_assertions)]
                    eprintln!("[tempo proxy] warmed after {} attempt(s)", attempt + 1);
                    return;
                }
                _ => continue,
            }
        }
        eprintln!("[tempo proxy] could not warm {url} - will retry on the next update");
        forget(&url);
    });
}

/// Pulls `image.url` out of the host's JSON reply, or the error it reported.
fn parse_upload_reply(body: &str) -> Result<String, String> {
    let reply: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("image host returned invalid json: {e}"))?;
    if let Some(url) = reply["image"]["url"].as_str() {
        if url.starts_with("https://") {
            return Ok(url.to_string());
        }
        return Err(format!("image host returned a non-https url: {url}"));
    }
    let reason = reply["error"]["message"]
        .as_str()
        .or_else(|| reply["status_txt"].as_str())
        .unwrap_or("no image url in reply");
    Err(format!("image host rejected the upload: {reason}"))
}

/// Uploads a local cover to a public image host and returns the HTTPS URL.
/// Discord Rich Presence only renders artwork from public URLs, so this is the
/// bridge for local covers. The URL is cached in sqlite keyed by the cover
/// path, so each cover is uploaded exactly once; the host also deduplicates by
/// content, so a cache miss cannot pile up copies of the same artwork.
#[tauri::command]
pub async fn upload_cover(
    state: State<'_, AppState>,
    cover_path: String,
) -> Result<String, String> {
    if let Some(url) = state.db.get_cover_upload(&cover_path) {
        return Ok(url);
    }
    let path = PathBuf::from(&cover_path);
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("cover unreadable: {e}"))?;
    if !meta.is_file() {
        return Err("cover path is not a file".into());
    }
    if meta.len() > UPLOAD_MAX_BYTES {
        return Err("cover is too large to upload".into());
    }
    let original = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("cover unreadable: {e}"))?;
    let fallback_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("cover.jpg")
        .to_string();
    let fallback_mime = cover_mime(&cover_path);
    let (data, name, mime) = match tokio::task::spawn_blocking(move || {
        let shrunk = shrink_cover(&original);
        (original, shrunk)
    })
    .await
    .map_err(|e| e.to_string())?
    {
        (_, Some(small)) => (small, "cover.jpg".to_string(), "image/jpeg"),
        (raw, None) => (raw, fallback_name, fallback_mime),
    };
    let part = reqwest::multipart::Part::bytes(data)
        .file_name(name)
        .mime_str(mime)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("key", IMAGE_HOST_KEY)
        .text("action", "upload")
        .text("format", "json")
        .part("source", part);
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .post(IMAGE_HOST_API)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("upload request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    // the host reports "invalid key" / "file too big" as a 400 with the reason
    // in the body, so parse first and only fall back to the bare status
    let url = match parse_upload_reply(&body) {
        Ok(url) if status.is_success() => url,
        Ok(_) => return Err(format!("image host responded with HTTP {status}")),
        Err(reason) if !status.is_success() => {
            return Err(format!("{reason} (HTTP {status})"));
        }
        Err(reason) => return Err(reason),
    };
    // Cached unconditionally: the host answered 200 with a url, and a freshly
    // uploaded file can legitimately need a moment before it serves. Probing
    // the origin here used to discard valid uploads and re-upload them forever.
    let _ = state.db.save_cover_upload(&cover_path, &url);
    Ok(url)
}

#[tauri::command]
pub fn set_track_lyrics(state: State<'_, AppState>, track_id: i64, lyrics: String) -> Result<(), String> {
    state.db.set_track_lyrics(track_id, &lyrics)
}

#[tauri::command]
pub fn toggle_favorite_artist(state: State<'_, AppState>, artist_id: i64) -> Result<bool, String> {
    state.db.toggle_favorite_artist(artist_id)
}

#[tauri::command]
pub fn list_favorite_artists(state: State<'_, AppState>) -> Result<Vec<crate::models::Artist>, String> {
    state.db.list_favorite_artists()
}

#[tauri::command]
pub fn is_favorite_artist(state: State<'_, AppState>, artist_id: i64) -> Result<bool, String> {
    state.db.is_favorite_artist(artist_id)
}

#[tauri::command]
pub fn toggle_favorite_album(state: State<'_, AppState>, album_id: i64) -> Result<bool, String> {
    state.db.toggle_favorite_album(album_id)
}

#[tauri::command]
pub fn list_favorite_albums(state: State<'_, AppState>) -> Result<Vec<crate::models::Album>, String> {
    state.db.list_favorite_albums()
}

#[tauri::command]
pub fn is_favorite_album(state: State<'_, AppState>, album_id: i64) -> Result<bool, String> {
    state.db.is_favorite_album(album_id)
}

#[tauri::command]
pub fn export_playlist_m3u8(
    state: State<'_, AppState>,
    playlist_id: i64,
    path: String,
) -> Result<usize, String> {
    let rows = state.db.get_playlist_tracks(playlist_id)?;
    let cache_dir = crate::soundcloud_store::cache_dir(&state.db, &state.sc_cache_dir);
    let mut out = String::from("#EXTM3U\n");
    let mut count = 0usize;
    for row in rows {
        let track = &row.track;
        let location = match track.source.as_str() {
            "soundcloud" => {
                let Some(external_id) = &track.external_id else { continue };
                let file = cache_dir.join(format!("{}.mp3", external_id));
                if !file.exists() {
                    continue;
                }
                file.to_string_lossy().into_owned()
            }
            _ => track.path.clone(),
        };
        let artist = track.artist_name.clone().unwrap_or_default();
        let dur = track.duration_sec.map(|d| d.round() as i64).unwrap_or(-1);
        out.push_str(&format!("#EXTINF:{},{} - {}\n{}\n", dur, artist, track.title, location));
        count += 1;
    }
    std::fs::write(&path, out).map_err(|e| format!("failed to write m3u8: {e}"))?;
    Ok(count)
}

#[tauri::command]
pub fn import_playlist_m3u8(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<Playlist, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| format!("failed to read m3u8: {e}"))?;
    let mut track_ids: Vec<i64> = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let clean = line.strip_prefix(r"file://").unwrap_or(line);
        let clean = clean.strip_prefix(r"file:///").unwrap_or(clean);
        if let Some(id) = state.db.find_track_id_by_path(clean)? {
            if !track_ids.contains(&id) {
                track_ids.push(id);
            }
        }
    }
    let playlist = state.db.create_playlist(&name)?;
    for id in &track_ids {
        state.db.playlist_add_track(playlist.id, *id)?;
    }
    Ok(playlist)
}

#[tauri::command]
pub fn get_artist_tracks(state: State<'_, AppState>, artist_id: i64) -> Result<Vec<Track>, String> {
    state.db.get_artist_tracks(artist_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_reply_yields_the_image_url() {
        let ok = r#"{"status_code":200,"image":{"name":"cover","url":"https://iili.io/nH7ZrWx.jpg","size":"22841"},"status_txt":"OK"}"#;
        assert_eq!(
            parse_upload_reply(ok).unwrap(),
            "https://iili.io/nH7ZrWx.jpg"
        );
    }

    #[test]
    fn upload_reply_errors_are_reported_not_cached() {
        // the host reports failures as a 400 whose body carries the reason
        let denied = r#"{"status_code":400,"error":{"message":"Invalid API v1 key.","code":100},"status_txt":"Bad Request"}"#;
        let err = parse_upload_reply(denied).unwrap_err();
        assert!(err.contains("Invalid API v1 key"), "got: {err}");

        assert!(parse_upload_reply("not json at all").is_err());
        assert!(parse_upload_reply("{}").is_err());

        // discord only renders https assets, so a plain-http url is a failure
        let insecure = r#"{"image":{"url":"http://iili.io/x.jpg"}}"#;
        assert!(parse_upload_reply(insecure).is_err());
    }

    #[test]
    fn cover_mime_follows_the_extension() {
        assert_eq!(cover_mime("C:/covers/a.png"), "image/png");
        assert_eq!(cover_mime("C:/covers/a.WEBP"), "image/webp");
        // unknown and extensionless paths fall back to jpeg
        assert_eq!(cover_mime("C:/covers/a.bin"), "image/jpeg");
        assert_eq!(cover_mime("C:/covers/a"), "image/jpeg");
    }

    #[test]
    fn shrink_cover_downscales_to_the_proxy_friendly_edge() {
        let wide = image::DynamicImage::new_rgb8(1200, 900);
        let mut png = Vec::new();
        wide.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode fixture");

        let small = shrink_cover(&png).expect("a valid png must shrink");
        let decoded = image::ImageReader::new(std::io::Cursor::new(&small))
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        assert!(decoded.width().max(decoded.height()) <= COVER_MAX_EDGE);
        assert!(small.len() < png.len());

        // undecodable bytes are uploaded as-is rather than dropped
        assert!(shrink_cover(b"definitely not an image").is_none());
    }

    /// Live round trip against the image host, excluded from CI because it needs
    /// the network. Run it to re-validate the host (or the baked-in key) after a
    /// broken-cover report:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn live_upload_round_trip() {
        let cover = image::DynamicImage::new_rgb8(900, 900);
        let mut png = Vec::new();
        cover
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode fixture");
        let jpeg = shrink_cover(&png).expect("shrink");

        let part = reqwest::multipart::Part::bytes(jpeg)
            .file_name("cover.jpg")
            .mime_str("image/jpeg")
            .unwrap();
        let form = reqwest::multipart::Form::new()
            .text("key", IMAGE_HOST_KEY)
            .text("action", "upload")
            .text("format", "json")
            .part("source", part);
        let resp = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .unwrap()
            .post(IMAGE_HOST_API)
            .multipart(form)
            .send()
            .await
            .expect("upload");
        let status = resp.status();
        let body = resp.text().await.unwrap();
        assert!(status.is_success(), "HTTP {status}: {body}");
        let url = parse_upload_reply(&body).expect("reply carries an image url");
        println!("uploaded to {url}");

        // the url must be fetchable, otherwise discord's proxy cannot ingest it
        let check = reqwest::get(&url).await.expect("fetch back");
        assert!(check.status().is_success(), "origin served {}", check.status());
    }
}
