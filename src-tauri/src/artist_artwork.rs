use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::{header, Client, StatusCode, Url};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::database::Db;

const DEEZER_SEARCH: &str = "https://api.deezer.com/search/artist";
const WIKIPEDIA_APIS: &[(&str, &str)] = &[
    ("en", "https://en.wikipedia.org/w/api.php"),
    ("ru", "https://ru.wikipedia.org/w/api.php"),
];
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
// Deezer does not publish a limit for this endpoint. Keep combined provider
// traffic below 24 requests/minute, including manual searches.
const REQUEST_INTERVAL_MS: u64 = 2_500;
const LAST_REQUEST_KEY: &str = "artist_artwork.providers.last_request_ms.v1";
const PROVIDER_MIGRATION_KEY: &str = "artist_artwork.providers.deezer_wikimedia_migration.v1";
const NO_MATCH_RETRY_SEC: u64 = 7 * 24 * 60 * 60;
const ERROR_RETRY_SEC: u64 = 60 * 60;
const MAX_RETRY_AFTER_SEC: u64 = 24 * 60 * 60;
const USER_AGENT: &str =
    "Tempo/1.0 (artist artwork lookup; https://github.com/GLIPIYT/tempo-player)";

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn stored_number(db: &Db, key: &str) -> u64 {
    db.get_app_setting(key)
        .ok()
        .flatten()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

/// Persist request pacing so app restarts cannot burst provider requests.
async fn reserve_request(db: &Db) -> Result<(), String> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = GATE
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let wait = stored_number(db, LAST_REQUEST_KEY)
        .saturating_add(REQUEST_INTERVAL_MS)
        .saturating_sub(unix_millis())
        .min(REQUEST_INTERVAL_MS);
    if wait > 0 {
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
    db.set_app_setting(LAST_REQUEST_KEY, &unix_millis().to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistImageCandidate {
    pub artist_id: String,
    pub name: String,
    pub thumbnail_url: String,
}

#[derive(Deserialize)]
struct DeezerResponse {
    data: Option<Vec<DeezerArtist>>,
    error: Option<DeezerError>,
}

#[derive(Deserialize)]
struct DeezerError {
    message: Option<String>,
}

#[derive(Deserialize)]
struct DeezerArtist {
    id: u64,
    name: String,
    picture_xl: Option<String>,
    picture_big: Option<String>,
    picture_medium: Option<String>,
}

#[derive(Deserialize)]
struct WikipediaResponse {
    query: Option<WikipediaQuery>,
}

#[derive(Deserialize)]
struct WikipediaQuery {
    pages: Option<BTreeMap<String, WikipediaPage>>,
}

#[derive(Deserialize)]
struct WikipediaPage {
    pageid: Option<u64>,
    title: Option<String>,
    description: Option<String>,
    extract: Option<String>,
    original: Option<WikipediaImage>,
    thumbnail: Option<WikipediaImage>,
}

#[derive(Deserialize)]
struct WikipediaImage {
    source: Option<String>,
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 4 || !is_allowed_provider_url(attempt.url()) {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .expect("artist artwork HTTP client")
    })
}

fn is_allowed_provider_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }

    match url.host_str() {
        Some("api.deezer.com") => {
            url.path() == "/search/artist" || url.path().starts_with("/artist/")
        }
        Some("e-cdns-images.dzcdn.net" | "cdns-images.dzcdn.net" | "cdn-images.dzcdn.net") => {
            url.path().starts_with("/images/artist/")
        }
        Some("en.wikipedia.org" | "ru.wikipedia.org") => url.path() == "/w/api.php",
        Some("upload.wikimedia.org") => {
            url.path().starts_with("/wikipedia/commons/")
                || url.path().starts_with("/wikipedia/en/")
        }
        _ => false,
    }
}

fn has_supported_image_extension(path: &str) -> bool {
    let path = path.to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".webp"]
        .iter()
        .any(|extension| path.ends_with(extension))
}

fn validate_artist_image_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "invalid artist image URL".to_string())?;
    let valid_image_path = match url.host_str() {
        Some("e-cdns-images.dzcdn.net" | "cdns-images.dzcdn.net" | "cdn-images.dzcdn.net") => {
            url.path().starts_with("/images/artist/")
        }
        Some("upload.wikimedia.org") => {
            url.path().starts_with("/wikipedia/commons/")
                || url.path().starts_with("/wikipedia/en/")
        }
        _ => false,
    };
    if !is_allowed_provider_url(&url)
        || !valid_image_path
        || !has_supported_image_extension(url.path())
    {
        return Err("provider returned an unsupported artist image URL".to_string());
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

fn normalized_artist_name(name: &str) -> String {
    // Keep punctuation and diacritics: loose matching risks saving another
    // artist's portrait. Only casing and whitespace are insignificant.
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn candidate_order(candidates: &mut [ArtistImageCandidate], query: &str) {
    let normalized_query = normalized_artist_name(query);
    candidates.sort_by_key(|candidate| {
        (
            normalized_artist_name(&candidate.name) != normalized_query,
            candidate.name.to_lowercase(),
        )
    });
}

fn parse_deezer_response(body: &str) -> Result<Vec<ArtistImageCandidate>, String> {
    let response: DeezerResponse =
        serde_json::from_str(body).map_err(|error| format!("invalid Deezer response: {error}"))?;
    if let Some(error) = response.error {
        return Err(format!(
            "Deezer search failed: {}",
            error
                .message
                .unwrap_or_else(|| "provider returned an error".into())
        ));
    }

    Ok(response
        .data
        .unwrap_or_default()
        .into_iter()
        .filter_map(|artist| {
            let name = artist.name.trim().to_string();
            let thumbnail_url = artist
                .picture_xl
                .or(artist.picture_big)
                .or(artist.picture_medium)?
                .trim()
                .to_string();
            if name.is_empty() || validate_artist_image_url(&thumbnail_url).is_err() {
                return None;
            }
            Some(ArtistImageCandidate {
                artist_id: artist.id.to_string(),
                name,
                thumbnail_url,
            })
        })
        .collect())
}

fn has_music_description(page: &WikipediaPage) -> bool {
    let text = format!(
        "{} {}",
        page.description.as_deref().unwrap_or_default(),
        page.extract.as_deref().unwrap_or_default()
    )
    .to_lowercase();
    [
        "artist",
        "singer",
        "musician",
        "music",
        "band",
        "rapper",
        "vocalist",
        "songwriter",
        "composer",
        "producer",
        "duo",
        "trio",
        "исполнител",
        "пев",
        "музык",
        "групп",
        "вокал",
        "рэпер",
        "композитор",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn parse_wikipedia_response(
    body: &str,
    language: &str,
) -> Result<Vec<ArtistImageCandidate>, String> {
    let response: WikipediaResponse = serde_json::from_str(body)
        .map_err(|error| format!("invalid Wikipedia response: {error}"))?;
    let Some(pages) = response.query.and_then(|query| query.pages) else {
        return Ok(Vec::new());
    };

    Ok(pages
        .into_values()
        .filter_map(|page| {
            if !has_music_description(&page) {
                return None;
            }
            let name = page.title?.trim().to_string();
            let page_id = page.pageid?;
            let thumbnail_url = page
                .original
                .and_then(|image| image.source)
                .filter(|source| validate_artist_image_url(source).is_ok())
                .or_else(|| {
                    page.thumbnail
                        .and_then(|image| image.source)
                        .filter(|source| validate_artist_image_url(source).is_ok())
                })?;
            if name.is_empty() {
                return None;
            }
            Some(ArtistImageCandidate {
                artist_id: format!("wikipedia-{language}-{page_id}"),
                name,
                thumbnail_url,
            })
        })
        .collect())
}

async fn read_limited(
    response: reqwest::Response,
    max_bytes: usize,
    provider: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err(format!("{provider} response is too large"));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("{provider} response failed: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("{provider} response is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn response_error(provider: &str, response: &reqwest::Response) -> String {
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(120)
            .clamp(60, MAX_RETRY_AFTER_SEC);
        return format!("{provider} rate limit reached; retry after {retry_after} seconds");
    }
    format!("{provider} returned HTTP {status}")
}

async fn get_json(db: &Db, url: Url, provider: &str) -> Result<Vec<u8>, String> {
    reserve_request(db).await?;
    let response = client()
        .get(url)
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("{provider} request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(provider, &response));
    }
    read_limited(response, MAX_RESPONSE_BYTES, provider).await
}

async fn search_deezer(db: &Db, query: &str) -> Result<Vec<ArtistImageCandidate>, String> {
    let mut url = Url::parse(DEEZER_SEARCH).map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("q", query);
    let body = get_json(db, url, "Deezer").await?;
    let body = std::str::from_utf8(&body).map_err(|error| error.to_string())?;
    let mut candidates = parse_deezer_response(body)?;
    candidate_order(&mut candidates, query);
    Ok(candidates)
}

async fn search_wikipedia_images(
    db: &Db,
    query: &str,
) -> Result<Vec<ArtistImageCandidate>, String> {
    let mut candidates = Vec::new();
    let mut failures = Vec::new();
    let mut successful_requests = 0;

    for (language, endpoint) in WIKIPEDIA_APIS {
        let mut url = Url::parse(endpoint).map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("action", "query")
            .append_pair("format", "json")
            .append_pair("generator", "search")
            .append_pair("gsrsearch", query)
            .append_pair("gsrnamespace", "0")
            .append_pair("gsrlimit", "10")
            .append_pair("prop", "pageimages|description|extracts")
            .append_pair("piprop", "original|thumbnail")
            .append_pair("pithumbsize", "1200")
            .append_pair("exintro", "1")
            .append_pair("explaintext", "1")
            .append_pair("exsentences", "2");

        match get_json(db, url, "Wikimedia").await {
            Ok(body) => {
                successful_requests += 1;
                let body = std::str::from_utf8(&body).map_err(|error| error.to_string())?;
                candidates.extend(parse_wikipedia_response(body, language)?);
            }
            Err(error) => failures.push(error),
        }
    }

    if successful_requests == 0 {
        return Err(failures.join("; "));
    }

    // Prefer the English result when the same exact title exists in both
    // editions. A duplicate localized page would otherwise block safe auto-save.
    let mut seen_names = std::collections::HashSet::new();
    candidates.retain(|candidate| seen_names.insert(normalized_artist_name(&candidate.name)));
    candidate_order(&mut candidates, query);
    Ok(candidates)
}

async fn search_images(db: &Db, query: &str) -> Result<Vec<ArtistImageCandidate>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.chars().count() > 150 {
        return Err("Artist name is too long".to_string());
    }

    let deezer = search_deezer(db, query).await;
    if let Ok(candidates) = &deezer {
        let normalized_query = normalized_artist_name(query);
        if candidates
            .iter()
            .any(|candidate| normalized_artist_name(&candidate.name) == normalized_query)
        {
            return Ok(candidates.clone());
        }
    }

    match search_wikipedia_images(db, query).await {
        Ok(candidates) if !candidates.is_empty() => Ok(candidates),
        Ok(_) => match deezer {
            Ok(candidates) => Ok(candidates),
            Err(error) => Err(format!(
                "{error}; Wikimedia found no matching artist images"
            )),
        },
        Err(wikipedia_error) => match deezer {
            Ok(candidates) if !candidates.is_empty() => Ok(candidates),
            Ok(_) => Err(format!("Deezer found no artist images; {wikipedia_error}")),
            Err(deezer_error) => Err(format!("{deezer_error}; {wikipedia_error}")),
        },
    }
}

#[tauri::command]
pub async fn search_artist_images(
    state: State<'_, crate::commands::AppState>,
    query: String,
) -> Result<Vec<ArtistImageCandidate>, String> {
    search_images(&state.db, &query).await
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
    let path = download_artist_image(&state.avatars_dir, artist_id, &url).await?;
    let stored_path = path.to_string_lossy().into_owned();
    if let Err(error) = state.db.set_artist_image(artist_id, Some(&stored_path)) {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    Ok(stored_path)
}

async fn download_artist_image(
    avatars_dir: &std::path::Path,
    artist_id: i64,
    raw_url: &str,
) -> Result<PathBuf, String> {
    let url = validate_artist_image_url(raw_url)?;
    let response = client()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("artist image request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error("Image host", &response));
    }
    validate_artist_image_url(response.url().as_str())?;
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.to_ascii_lowercase().starts_with("image/") {
        return Err("provider did not return an image".to_string());
    }
    let bytes = read_limited(response, MAX_IMAGE_BYTES, "artist image").await?;
    let extension = detect_image_extension(&bytes)
        .ok_or_else(|| "provider returned an unsupported image format".to_string())?;

    let directory = avatars_dir.join("artists");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let filename = format!("{artist_id}-artist-artwork-{timestamp}.{extension}");
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
        )
        .optional()
        .map_err(|error| error.to_string())
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
            params![
                artist_id,
                name,
                status,
                candidate.map(|value| &value.artist_id),
                candidate.map(|value| &value.thumbnail_url),
                bounded_error,
                now + retry_sec,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn artwork_retry_delay(error: &str) -> u64 {
    let lower = error.to_ascii_lowercase();
    if let Some(retry_after) = lower.find("retry after ").map(|index| &lower[index + 12..]) {
        let seconds = retry_after
            .split_whitespace()
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(120);
        return seconds.clamp(60, MAX_RETRY_AFTER_SEC);
    }
    if lower.contains("http 403") || lower.contains("forbidden") {
        6 * 60 * 60
    } else if lower.contains("request failed") || lower.contains("response failed") {
        10 * 60
    } else {
        ERROR_RETRY_SEC
    }
}

/// Requeue previous provider misses once when switching from TheAudioDB.
/// The new versioned marker makes this independent of old cooldown settings.
fn migrate_old_lookups_once(db: &Db) -> Result<(), String> {
    if db.get_app_setting(PROVIDER_MIGRATION_KEY)?.as_deref() == Some("done") {
        return Ok(());
    }
    let now = unix_millis() / 1_000;
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let migration = (|| {
            conn.execute(
                "UPDATE artist_artwork_lookup
                 SET status = 'queued', provider_id = NULL, source_url = NULL,
                     error = NULL, next_attempt_at = ?1, updated_at = ?1
                 WHERE status IN ('error', 'not_found')
                   AND EXISTS (
                     SELECT 1 FROM artists a
                     WHERE a.id = artist_artwork_lookup.artist_id
                       AND (a.image_path IS NULL OR trim(a.image_path) = '')
                   )",
                params![now],
            )
            .map_err(|error| error.to_string())?;
            conn.execute(
                "INSERT INTO app_settings(key, value) VALUES(?1, 'done')
                 ON CONFLICT(key) DO UPDATE SET value = 'done'",
                params![PROVIDER_MIGRATION_KEY],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })();

        match migration {
            Ok(()) => conn
                .execute_batch("COMMIT")
                .map_err(|error| error.to_string()),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

fn store_missing_image(db: &Db, artist_id: i64, name: &str, path: &str) -> Result<usize, String> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE artists SET image_path = ?1 WHERE id = ?2 AND name = ?3
             AND (image_path IS NULL OR trim(image_path) = '')",
            params![path, artist_id, name],
        )
        .map_err(|error| error.to_string())
    })
}

async fn lookup_missing_artist(
    db: &Db,
    avatars_dir: &std::path::Path,
    app: &AppHandle,
    artist_id: i64,
    name: &str,
) -> Result<(), String> {
    // If the process exits mid-request, retry after a delay instead of
    // immediately repeating provider requests on every launch.
    record_lookup(
        db,
        artist_id,
        name,
        "searching",
        None,
        None,
        ERROR_RETRY_SEC,
    )?;
    let normalized_name = normalized_artist_name(name);
    let candidates = search_images(db, name).await?;
    let matches: Vec<_> = candidates
        .iter()
        .filter(|candidate| normalized_artist_name(&candidate.name) == normalized_name)
        .collect();
    if matches.len() != 1 {
        return record_lookup(
            db,
            artist_id,
            name,
            if matches.is_empty() {
                "not_found"
            } else {
                "ambiguous"
            },
            None,
            None,
            NO_MATCH_RETRY_SEC,
        );
    }

    let candidate = matches[0];
    let path = download_artist_image(avatars_dir, artist_id, &candidate.thumbnail_url).await?;
    let stored_path = path.to_string_lossy().into_owned();
    match store_missing_image(db, artist_id, name, &stored_path) {
        Ok(changed) => {
            if changed == 0 {
                // The user may have chosen a portrait while the download ran.
                let _ = tokio::fs::remove_file(path).await;
            } else {
                let _ = app.emit(
                    crate::soundcloud_store::LIBRARY_CHANGED_EVENT,
                    String::new(),
                );
            }
            record_lookup(
                db,
                artist_id,
                name,
                if changed > 0 { "ready" } else { "superseded" },
                Some(candidate),
                None,
                NO_MATCH_RETRY_SEC,
            )
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
        if let Err(error) = migrate_old_lookups_once(&db) {
            eprintln!("Tempo could not migrate artist artwork retries: {error}");
        }
        loop {
            match next_missing_artist(&db) {
                Ok(Some((artist_id, name))) => {
                    if let Err(error) =
                        lookup_missing_artist(&db, &avatars_dir, &app, artist_id, &name).await
                    {
                        let retry_after = artwork_retry_delay(&error);
                        let _ = record_lookup(
                            &db,
                            artist_id,
                            &name,
                            "error",
                            None,
                            Some(&error),
                            retry_after,
                        );
                        eprintln!(
                            "Tempo artist artwork lookup failed for artist {artist_id}: {error}"
                        );
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
        assert_eq!(
            normalized_artist_name("  Arctic   MONKEYS "),
            "arctic monkeys"
        );
        assert_ne!(normalized_artist_name("A.B"), normalized_artist_name("AB"));
        assert_ne!(
            normalized_artist_name("Beyoncé"),
            normalized_artist_name("Beyonce")
        );
    }

    #[test]
    fn deezer_parser_keeps_supported_exact_artwork() {
        let response = r#"{
            "data": [
                {
                    "id": 123,
                    "name": "Coldplay",
                    "picture_xl": "https://e-cdns-images.dzcdn.net/images/artist/abc/1000x1000-000000-80-0-0.jpg"
                },
                {
                    "id": 456,
                    "name": "No image",
                    "picture_xl": null,
                    "picture_big": "https://example.com/no.jpg"
                }
            ]
        }"#;
        let candidates = parse_deezer_response(response).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].artist_id, "123");
        assert_eq!(candidates[0].name, "Coldplay");
    }

    #[test]
    fn wikipedia_parser_requires_music_description_and_local_image() {
        let response = r#"{
            "query": {
                "pages": {
                    "1": {
                        "pageid": 1,
                        "title": "Coldplay",
                        "description": "British rock band",
                        "extract": "Coldplay are a British rock band.",
                        "original": {"source": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Coldplay.jpg"}
                    },
                    "2": {
                        "pageid": 2,
                        "title": "Coldplay discography",
                        "description": "Discography",
                        "extract": "List of songs.",
                        "original": {"source": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Coldplay.jpg"}
                    }
                }
            }
        }"#;
        let candidates = parse_wikipedia_response(response, "en").unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].artist_id, "wikipedia-en-1");
        assert_eq!(candidates[0].name, "Coldplay");
    }

    #[test]
    fn only_provider_api_and_image_hosts_are_allowed() {
        assert!(is_allowed_provider_url(
            &Url::parse("https://api.deezer.com/search/artist?q=Coldplay").unwrap()
        ));
        assert!(validate_artist_image_url(
            "https://e-cdns-images.dzcdn.net/images/artist/abc/500x500.jpg"
        )
        .is_ok());
        assert!(validate_artist_image_url(
            "https://upload.wikimedia.org/wikipedia/commons/a/ab/Coldplay.jpg"
        )
        .is_ok());
        assert!(validate_artist_image_url(
            "http://upload.wikimedia.org/wikipedia/commons/a/ab/Coldplay.jpg"
        )
        .is_err());
        assert!(validate_artist_image_url("https://example.com/artist.jpg").is_err());
        assert!(is_allowed_provider_url(
            &Url::parse("https://en.wikipedia.org/w/api.php?action=query").unwrap()
        ));
        assert!(!is_allowed_provider_url(
            &Url::parse("https://en.wikipedia.org/wiki/Coldplay").unwrap()
        ));
    }

    #[test]
    fn automatic_save_cannot_overwrite_a_manual_choice_or_renamed_artist() {
        let db = Db::open_at(std::path::Path::new(":memory:")).unwrap();
        let artist = db.ensure_artist("Original Artist").unwrap();
        db.set_artist_image(artist, Some("manual.png")).unwrap();
        assert_eq!(
            store_missing_image(&db, artist, "Original Artist", "auto.png").unwrap(),
            0
        );
        db.set_artist_image(artist, None).unwrap();
        assert_eq!(
            store_missing_image(&db, artist, "Old Name", "auto.png").unwrap(),
            0
        );
        assert_eq!(
            store_missing_image(&db, artist, "Original Artist", "auto.png").unwrap(),
            1
        );
        assert_eq!(
            store_missing_image(&db, artist, "Original Artist", "second.png").unwrap(),
            0
        );
    }

    #[test]
    fn provider_migration_requeues_failed_and_missing_lookups_only_once() {
        let db = Db::open_at(std::path::Path::new(":memory:")).unwrap();
        let failed = db.ensure_artist("Failed Artist").unwrap();
        let missing = db.ensure_artist("Missing Artist").unwrap();
        record_lookup(
            &db,
            failed,
            "Failed Artist",
            "error",
            None,
            Some("HTTP 403"),
            3600,
        )
        .unwrap();
        record_lookup(
            &db,
            missing,
            "Missing Artist",
            "not_found",
            None,
            None,
            NO_MATCH_RETRY_SEC,
        )
        .unwrap();

        migrate_old_lookups_once(&db).unwrap();
        let migrated = db
            .with_conn(|conn| {
                let status: String = conn
                    .query_row(
                        "SELECT status FROM artist_artwork_lookup WHERE artist_id = ?1",
                        params![failed],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok(status)
            })
            .unwrap();
        assert_eq!(migrated, "queued");

        record_lookup(
            &db,
            failed,
            "Failed Artist",
            "error",
            None,
            Some("new error"),
            3600,
        )
        .unwrap();
        migrate_old_lookups_once(&db).unwrap();
        let status = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM artist_artwork_lookup WHERE artist_id = ?1",
                    params![failed],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(status, "error");
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
