use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::{header, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::database::Db;

const API_SEARCH: &str = "https://www.theaudiodb.com/api/v1/json/123/search.php";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
// Keep API lookups below TheAudioDB's published 30 requests/minute free limit.
const REQUEST_INTERVAL_MS: u64 = 5_000;
// v2 intentionally ignores the old global block. Earlier builds treated any
// HTTP 403 (including a single CDN image denial) as a provider-wide 24h block.
const BLOCKED_UNTIL_KEY: &str = "artist_artwork.theaudiodb.api_blocked_until.v2";
const BLOCK_REASON_KEY: &str = "artist_artwork.theaudiodb.api_block_reason.v2";
const LAST_REQUEST_KEY: &str = "artist_artwork.theaudiodb.last_request_ms";
const DAY_SEC: u64 = 24 * 60 * 60;
const FORBIDDEN_COOLDOWN_SEC: u64 = 5 * 60;
const NO_MATCH_RETRY_SEC: u64 = 7 * DAY_SEC;
const ERROR_RETRY_SEC: u64 = 60 * 60;

fn unix_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn stored_number(db: &Db, key: &str) -> u64 {
    db.get_app_setting(key).ok().flatten().and_then(|value| value.parse().ok()).unwrap_or(0)
}

/// Persist the request budget as well: restarting the app must not bypass it.
async fn reserve_request(db: &Db) -> Result<(), String> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = GATE.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    if let Some(error) = api_cooldown_error(db) {
        return Err(error);
    }
    let wait = stored_number(db, LAST_REQUEST_KEY)
        .saturating_add(REQUEST_INTERVAL_MS)
        .saturating_sub(unix_millis())
        .min(REQUEST_INTERVAL_MS);
    if wait > 0 {
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
    // Another request can have received a provider response while this request was waiting.
    if let Some(error) = api_cooldown_error(db) {
        return Err(error);
    }
    db.set_app_setting(LAST_REQUEST_KEY, &unix_millis().to_string())
}

fn api_cooldown_error(db: &Db) -> Option<String> {
    let remaining = stored_number(db, BLOCKED_UNTIL_KEY).saturating_sub(unix_millis() / 1_000);
    if remaining == 0 {
        return None;
    }
    let minutes = remaining.saturating_add(59) / 60;
    let reason = db.get_app_setting(BLOCK_REASON_KEY).ok().flatten();
    Some(match reason.as_deref() {
        Some("forbidden") => format!(
            "TheAudioDB refused the artist search (HTTP 403). Tempo will retry in about {minutes} min."
        ),
        Some("rate_limit") => format!(
            "TheAudioDB rate limit is active. Tempo will retry in about {minutes} min."
        ),
        _ => format!("TheAudioDB search is paused. Tempo will retry in about {minutes} min."),
    })
}

fn set_api_cooldown(db: &Db, reason: &str, delay_sec: u64) {
    let now = unix_millis() / 1_000;
    let until = stored_number(db, BLOCKED_UNTIL_KEY).max(now + delay_sec);
    let _ = db.set_app_setting(BLOCKED_UNTIL_KEY, &until.to_string());
    let _ = db.set_app_setting(BLOCK_REASON_KEY, reason);
}

fn response_error(db: &Db, response: &reqwest::Response, is_api_request: bool) -> String {
    let status = response.status();
    // TheAudioDB documents 429 as its rate-limit response. A 403 from one
    // image URL is a resource-level denial and must not disable artist search.
    if is_api_request && status == StatusCode::FORBIDDEN {
        set_api_cooldown(db, "forbidden", FORBIDDEN_COOLDOWN_SEC);
        return api_cooldown_error(db)
            .unwrap_or_else(|| "TheAudioDB refused the artist search (HTTP 403).".into());
    } else if is_api_request && status == StatusCode::TOO_MANY_REQUESTS {
        let delay = response.headers().get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(60).clamp(60, DAY_SEC);
        set_api_cooldown(db, "rate_limit", delay);
        return api_cooldown_error(db)
            .unwrap_or_else(|| "TheAudioDB rate limit is active. Try again later.".into());
    }
    request_error(status)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistImageCandidate {
    pub artist_id: String,
    pub name: String,
    pub thumbnail_url: String,
}

#[derive(Deserialize)]
struct SearchResponse {
    artists: Option<Vec<SearchArtist>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SearchArtist {
    #[serde(rename = "idArtist")]
    id: Option<String>,
    #[serde(rename = "strArtist")]
    name: Option<String>,
    #[serde(rename = "strArtistThumb")]
    thumbnail_url: Option<String>,
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent("Tempo/0.9 (artist artwork lookup)")
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 3 || !is_theaudiodb_url(attempt.url()) {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .expect("TheAudioDB HTTP client")
    })
}

fn is_theaudiodb_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some("www.theaudiodb.com" | "theaudiodb.com" | "r2.theaudiodb.com")
        )
}

fn validate_artist_image_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "invalid TheAudioDB image URL".to_string())?;
    let path = url.path().to_ascii_lowercase();
    if !is_theaudiodb_url(&url)
        || !path.starts_with("/images/media/artist/")
        || ![".jpg", ".jpeg", ".png", ".webp"]
            .iter()
            .any(|extension| path.ends_with(extension))
    {
        return Err("TheAudioDB returned an unsupported artist image URL".to_string());
    }
    Ok(url)
}

fn detect_image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("jpg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1A\n") {
        Some("png")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn parse_search_response(body: &str) -> Result<Vec<ArtistImageCandidate>, String> {
    let response: SearchResponse = serde_json::from_str(body)
        .map_err(|error| format!("invalid TheAudioDB response: {error}"))?;
    Ok(response
        .artists
        .unwrap_or_default()
        .into_iter()
        .filter_map(|artist| {
            let artist_id = artist.id?.trim().to_string();
            let name = artist.name?.trim().to_string();
            let thumbnail_url = artist.thumbnail_url?.trim().to_string();
            if artist_id.is_empty()
                || name.is_empty()
                || validate_artist_image_url(&thumbnail_url).is_err()
            {
                return None;
            }
            Some(ArtistImageCandidate {
                artist_id,
                name,
                thumbnail_url,
            })
        })
        .collect())
}

async fn read_limited(response: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err("TheAudioDB response is too large".to_string());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("TheAudioDB response is too large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn request_error(status: StatusCode) -> String {
    if status == StatusCode::TOO_MANY_REQUESTS {
        "TheAudioDB rate limit reached. Wait a minute and try again.".to_string()
    } else {
        format!("TheAudioDB returned HTTP {status}")
    }
}

#[tauri::command]
pub async fn search_artist_images(
    state: State<'_, crate::commands::AppState>,
    query: String,
) -> Result<Vec<ArtistImageCandidate>, String> {
    search_images(&state.db, &query).await
}

async fn search_images(db: &Db, query: &str) -> Result<Vec<ArtistImageCandidate>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.chars().count() > 150 {
        return Err("Artist name is too long".to_string());
    }

    let mut url = Url::parse(API_SEARCH).map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("s", query);
    reserve_request(db).await?;
    let response = client()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("TheAudioDB request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(response_error(db, &response, true));
    }
    let body = read_limited(response, MAX_RESPONSE_BYTES).await?;
    let body = std::str::from_utf8(&body).map_err(|error| error.to_string())?;
    parse_search_response(body)
}

#[tauri::command]
pub async fn save_artist_image_from_url(
    state: State<'_, crate::commands::AppState>,
    artist_id: i64,
    url: String,
) -> Result<String, String> {
    if artist_id <= 0 {
        return Err("invalid artist id".to_string());
    }
    let path = download_artist_image(&state.db, &state.avatars_dir, artist_id, &url).await?;
    let stored_path = path.to_string_lossy().into_owned();
    if let Err(error) = state.db.set_artist_image(artist_id, Some(&stored_path)) {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    Ok(stored_path)
}

async fn download_artist_image(
    db: &Db,
    avatars_dir: &std::path::Path,
    artist_id: i64,
    url: &str,
) -> Result<PathBuf, String> {
    let url = validate_artist_image_url(url)?;
    let response = client()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("TheAudioDB image request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(response_error(db, &response, false));
    }
    validate_artist_image_url(response.url().as_str())?;
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.to_ascii_lowercase().starts_with("image/") {
        return Err("TheAudioDB did not return an image".to_string());
    }
    let bytes = read_limited(response, MAX_IMAGE_BYTES).await?;
    let extension = detect_image_extension(&bytes)
        .ok_or_else(|| "TheAudioDB returned an unsupported image format".to_string())?;

    let directory = avatars_dir.join("artists");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let filename = format!("{artist_id}-theaudiodb-{timestamp}.{extension}");
    let destination = directory.join(&filename);
    let temporary = temporary_path(&directory, &filename);
    if let Err(error) = tokio::fs::write(&temporary, &bytes).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error.to_string());
    }
    if let Err(error) = tokio::fs::rename(&temporary, &destination).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error.to_string());
    }

    Ok(destination)
}

fn temporary_path(directory: &std::path::Path, filename: &str) -> PathBuf {
    directory.join(format!(".{filename}.part"))
}

fn normalized_artist_name(name: &str) -> String {
    // Keep punctuation/diacritics: loose matching risks using another artist's
    // portrait. Only casing and whitespace are insignificant here.
    name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn next_missing_artist(db: &Db) -> Result<Option<(i64, String)>, String> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT a.id, a.name FROM artists a
             LEFT JOIN artist_artwork_lookup l ON l.artist_id = a.id
             WHERE (a.image_path IS NULL OR trim(a.image_path) = '')
               AND length(trim(a.name)) BETWEEN 1 AND 150
               AND lower(trim(a.name)) NOT IN ('unknown artist', 'неизвестный исполнитель')
               AND (l.artist_id IS NULL OR l.artist_name <> a.name OR l.next_attempt_at <= ?1)
             ORDER BY a.id LIMIT 1",
            params![unix_millis() / 1_000],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|error| error.to_string())
    })
}

fn record_lookup(
    db: &Db,
    artist_id: i64,
    name: &str,
    status: &str,
    candidate: Option<&ArtistImageCandidate>,
    error: Option<&str>,
    retry_sec: u64,
) -> Result<(), String> {
    let now = unix_millis() / 1_000;
    let bounded_error = error.map(|value| value.chars().take(500).collect::<String>());
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO artist_artwork_lookup
               (artist_id, artist_name, status, provider_id, source_url, error, next_attempt_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE EXISTS(SELECT 1 FROM artists WHERE id = ?1)
             ON CONFLICT(artist_id) DO UPDATE SET
               artist_name = excluded.artist_name, status = excluded.status,
               provider_id = excluded.provider_id, source_url = excluded.source_url,
               error = excluded.error, next_attempt_at = excluded.next_attempt_at,
               updated_at = excluded.updated_at",
            params![artist_id, name, status, candidate.map(|value| &value.artist_id),
                candidate.map(|value| &value.thumbnail_url), bounded_error, now + retry_sec, now],
        ).map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn artwork_retry_delay(db: &Db, error: &str) -> u64 {
    let lower = error.to_ascii_lowercase();
    let minimum = if lower.contains("http 403") {
        FORBIDDEN_COOLDOWN_SEC
    } else if lower.contains("rate limit") {
        60
    } else if lower.contains("request failed") {
        FORBIDDEN_COOLDOWN_SEC
    } else {
        return ERROR_RETRY_SEC;
    };
    stored_number(db, BLOCKED_UNTIL_KEY)
        .saturating_sub(unix_millis() / 1_000)
        .max(minimum)
}

/// Previous builds could strand each failed artist behind a stale retry after
/// the provider's global cooldown had been fixed. Release only that known error
/// so the worker can retry automatically with the corrected cooldown policy.
fn release_legacy_unavailable_lookups(db: &Db) -> Result<(), String> {
    let now = unix_millis() / 1_000;
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE artist_artwork_lookup
             SET status = 'queued', error = NULL, next_attempt_at = ?1, updated_at = ?1
             WHERE status = 'error'
               AND error = 'TheAudioDB is temporarily unavailable. Tempo will retry later.'",
            params![now],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn store_missing_image(db: &Db, artist_id: i64, name: &str, path: &str) -> Result<usize, String> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE artists SET image_path = ?1 WHERE id = ?2 AND name = ?3
             AND (image_path IS NULL OR trim(image_path) = '')",
            params![path, artist_id, name],
        ).map_err(|error| error.to_string())
    })
}

async fn lookup_missing_artist(
    db: &Db,
    avatars_dir: &std::path::Path,
    app: &AppHandle,
    artist_id: i64,
    name: &str,
) -> Result<(), String> {
    // If the process exits mid-request, it retries after this cooldown rather
    // than making the same request immediately on every launch.
    record_lookup(db, artist_id, name, "searching", None, None, ERROR_RETRY_SEC)?;
    let normalized_name = normalized_artist_name(name);
    let candidates = search_images(db, name).await?;
    let matches: Vec<_> = candidates.iter()
        .filter(|candidate| normalized_artist_name(&candidate.name) == normalized_name)
        .collect();
    if matches.len() != 1 {
        return record_lookup(db, artist_id, name,
            if matches.is_empty() { "not_found" } else { "ambiguous" },
            None, None, NO_MATCH_RETRY_SEC);
    }
    let candidate = matches[0];
    let path = download_artist_image(db, avatars_dir, artist_id, &candidate.thumbnail_url).await?;
    let stored_path = path.to_string_lossy().into_owned();
    let saved = store_missing_image(db, artist_id, name, &stored_path);
    match saved {
        Ok(changed) => {
            if changed == 0 {
                // The user may have chosen a portrait while the download ran.
                let _ = tokio::fs::remove_file(path).await;
            } else {
                // A non-track change must not look like a SoundCloud cache ID
                // to the playback cache-ready listener.
                let _ = app.emit(crate::soundcloud_store::LIBRARY_CHANGED_EVENT, String::new());
            }
            record_lookup(db, artist_id, name, if changed > 0 { "ready" } else { "superseded" },
                Some(candidate), None, NO_MATCH_RETRY_SEC)
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(path).await;
            Err(error)
        }
    }
}

/// One worker per application, independent of mounted pages. Idle polling also
/// picks up artists imported after startup without tying requests to rendering.
pub fn start_automatic_lookup(app: AppHandle) {
    let state = app.state::<crate::commands::AppState>();
    let db: Arc<Db> = state.db.clone();
    let avatars_dir = state.avatars_dir.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        if let Err(error) = release_legacy_unavailable_lookups(&db) {
            eprintln!("Tempo could not release old artist artwork retries: {error}");
        }
        loop {
            let remaining = stored_number(&db, BLOCKED_UNTIL_KEY)
                .saturating_sub(unix_millis() / 1_000);
            if remaining > 0 {
                tokio::time::sleep(Duration::from_secs(remaining.min(60))).await;
                continue;
            }
            match next_missing_artist(&db) {
                Ok(Some((artist_id, name))) => {
                    if let Err(error) = lookup_missing_artist(&db, &avatars_dir, &app, artist_id, &name).await {
                        let retry_after = artwork_retry_delay(&db, &error);
                        let _ = record_lookup(&db, artist_id, &name, "error", None, Some(&error), retry_after);
                        eprintln!("Tempo artist artwork lookup failed for artist {artist_id}: {error}");
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                Ok(None) => tokio::time::sleep(Duration::from_secs(60)).await,
                Err(error) => {
                    eprintln!("Tempo artist artwork queue unavailable: {error}");
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_keeps_identity_beyond_case_and_whitespace() {
        assert_eq!(normalized_artist_name("  Arctic   MONKEYS "), "arctic monkeys");
        assert_ne!(normalized_artist_name("A.B"), normalized_artist_name("AB"));
        assert_ne!(normalized_artist_name("Beyoncé"), normalized_artist_name("Beyonce"));
    }

    #[test]
    fn missing_queue_honors_cached_misses_and_later_imports() {
        let db = Db::open_at(std::path::Path::new(":memory:")).unwrap();
        let first = db.ensure_artist("First Artist").unwrap();
        let manual = db.ensure_artist("Manual Artist").unwrap();
        db.set_artist_image(manual, Some("manual.png")).unwrap();
        assert_eq!(next_missing_artist(&db).unwrap().unwrap().0, first);
        record_lookup(&db, first, "First Artist", "not_found", None, None, NO_MATCH_RETRY_SEC).unwrap();
        assert!(next_missing_artist(&db).unwrap().is_none());
        let later = db.ensure_artist("Later Artist").unwrap();
        assert_eq!(next_missing_artist(&db).unwrap().unwrap().0, later);
        // A rename must not retain the old name's negative cache.
        db.with_conn(|conn| {
            conn.execute("UPDATE artists SET name = 'Renamed Artist' WHERE id = ?1", params![first])
                .map_err(|error| error.to_string())?;
            Ok(())
        }).unwrap();
        assert_eq!(next_missing_artist(&db).unwrap().unwrap().0, first);
    }

    #[test]
    fn automatic_save_cannot_overwrite_a_manual_choice_or_renamed_artist() {
        let db = Db::open_at(std::path::Path::new(":memory:")).unwrap();
        let artist = db.ensure_artist("Original Artist").unwrap();
        db.set_artist_image(artist, Some("manual.png")).unwrap();
        assert_eq!(store_missing_image(&db, artist, "Original Artist", "auto.png").unwrap(), 0);
        db.set_artist_image(artist, None).unwrap();
        assert_eq!(store_missing_image(&db, artist, "Old Name", "auto.png").unwrap(), 0);
        assert_eq!(store_missing_image(&db, artist, "Original Artist", "auto.png").unwrap(), 1);
        assert_eq!(store_missing_image(&db, artist, "Original Artist", "second.png").unwrap(), 0);
    }

    #[test]
    fn parses_artist_candidates_and_ignores_missing_thumbnails() {
        let response = r#"{
            "artists": [
                {
                    "idArtist": "111239",
                    "strArtist": "Coldplay",
                    "strArtistThumb": "https://r2.theaudiodb.com/images/media/artist/thumb/coldplay.jpg"
                },
                {
                    "idArtist": "222222",
                    "strArtist": "Missing Image",
                    "strArtistThumb": null
                }
            ]
        }"#;

        let candidates = parse_search_response(response).unwrap();

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].artist_id, "111239");
        assert_eq!(candidates[0].name, "Coldplay");
        assert_eq!(
            candidates[0].thumbnail_url,
            "https://r2.theaudiodb.com/images/media/artist/thumb/coldplay.jpg"
        );
    }

    #[test]
    fn accepts_only_https_artist_images_from_theaudiodb_hosts() {
        assert!(validate_artist_image_url(
            "https://r2.theaudiodb.com/images/media/artist/thumb/artist.jpg"
        )
        .is_ok());
        assert!(validate_artist_image_url(
            "https://www.theaudiodb.com/images/media/artist/thumb/artist.png"
        )
        .is_ok());
        assert!(validate_artist_image_url(
            "http://r2.theaudiodb.com/images/media/artist/thumb/artist.jpg"
        )
        .is_err());
        assert!(validate_artist_image_url(
            "https://example.com/images/media/artist/thumb/artist.jpg"
        )
        .is_err());
        assert!(validate_artist_image_url(
            "https://r2.theaudiodb.com/images/media/album/thumb/cover.jpg"
        )
        .is_err());
    }

    #[test]
    fn recognizes_image_bytes_before_saving_them() {
        assert_eq!(detect_image_extension(b"\xFF\xD8\xFF\xE0jpeg"), Some("jpg"));
        assert_eq!(
            detect_image_extension(b"\x89PNG\r\n\x1A\nimage"),
            Some("png")
        );
        assert_eq!(detect_image_extension(b"RIFFxxxxWEBPdata"), Some("webp"));
        assert_eq!(detect_image_extension(b"not an image"), None);
    }
}
