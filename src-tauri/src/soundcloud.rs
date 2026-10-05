use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::{Mutex, RwLock, Semaphore};

const SITE: &str = "https://soundcloud.com";
const API: &str = "https://api-v2.soundcloud.com";
const DESKTOP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const STREAM_TTL: Duration = Duration::from_secs(20 * 60);

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration_ms: i64,
    pub artwork_url: Option<String>,
    /// The SoundCloud uploader's profile artwork. This is only copied into the
    /// local artist catalog when the track is explicitly saved or cached.
    #[serde(default)]
    pub artist_avatar_url: Option<String>,
    #[serde(default)]
    pub permalink_url: Option<String>,
    // sent by the SoundCloud API; the player's lightweight upsert omits them
    #[serde(default)]
    pub streamable: bool,
    #[serde(default)]
    pub has_progressive: bool,
    #[serde(default)]
    pub has_hls: bool,
    #[serde(default)]
    pub uploader_id: Option<String>,
    #[serde(default)]
    pub uploader_name: Option<String>,
    #[serde(default)]
    pub metadata_artist: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub isrc: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub url: String,
    pub format: String,
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(DESKTOP_UA)
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client")
    })
}

fn client_id_slot() -> &'static RwLock<Option<String>> {
    static SLOT: OnceLock<RwLock<Option<String>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(None))
}

async fn fetch_client_id() -> Result<String, String> {
    let html = client()
        .get(SITE)
        .send()
        .await
        .map_err(|e| format!("soundcloud unreachable: {e}"))?
        .error_for_status()
        .map_err(|e| format!("soundcloud page: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let re = Regex::new(r#""hydratable":"apiClient","data":\{"id":"([^"]+)""#).map_err(|e| e.to_string())?;
    let id = re
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| "client_id not found in soundcloud html".to_string())?;
    *client_id_slot().write().await = Some(id.clone());
    Ok(id)
}

async fn get_client_id() -> Result<String, String> {
    if let Some(id) = client_id_slot().read().await.clone() {
        return Ok(id);
    }
    fetch_client_id().await
}

async fn get_json(url: &str) -> Result<Value, String> {
    let resp = client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if status.is_client_error() {
        // The path is named so a failure says *which* endpoint refused, and the
        // query is dropped because it carries the client id.
        let path = url.split('?').next().unwrap_or(url);
        return Err(format!("SC_CLIENT_ERROR {} {path}", status.as_u16()));
    }
    resp.error_for_status()
        .map_err(|e| format!("soundcloud api: {e}"))?
        .json::<Value>()
        .await
        .map_err(|e| format!("bad json: {e}"))
}

async fn get_json_with_fresh_client(url: &str) -> Result<Value, String> {
    let cid = get_client_id().await?;
    match get_json(&format!("{url}{cid}")).await {
        Err(e) if e.starts_with("SC_CLIENT_ERROR 401 ") || e.starts_with("SC_CLIENT_ERROR 403 ") => {
            fetch_client_id().await?;
            get_json(&format!("{url}{}", get_client_id().await?)).await
        }
        other => other,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TranscodingProtocol {
    Progressive,
    Hls,
}

fn is_encrypted(t: &Value) -> bool {
    let protocol = t.pointer("/format/protocol").and_then(Value::as_str).unwrap_or_default();
    let url = t.get("url").and_then(Value::as_str).unwrap_or_default();
    let is_hls = protocol == "hls" || protocol.contains("hls") || url.to_ascii_lowercase().contains("/hls");
    if !is_hls {
        return false;
    }
    if protocol.contains("encrypted") || protocol.starts_with("ctr-") || protocol.starts_with("cbc-")
        || url.to_ascii_lowercase().contains("/encrypted-hls") {
        return true;
    }
    let preset = t.get("preset").and_then(|v| v.as_str()).unwrap_or_default();
    if preset.contains("encrypted") {
        return true;
    }
    if t.get("snipped").and_then(|v| v.as_bool()).unwrap_or(false) {
        return true;
    }
    let mime = t.pointer("/format/mime_type").and_then(|v| v.as_str()).unwrap_or_default();
    mime.contains("encrypted")
}

/// SoundCloud clients sometimes label the HLS URL as `http`; yt-dlp handles
/// the same API inconsistency by identifying the protocol from the stream URL.
fn transcoding_protocol(t: &Value) -> Option<TranscodingProtocol> {
    let protocol = t.pointer("/format/protocol").and_then(Value::as_str).unwrap_or_default();
    if protocol == "progressive" {
        return Some(TranscodingProtocol::Progressive);
    }
    if is_encrypted(t) {
        return None;
    }
    let url = t.get("url").and_then(Value::as_str).unwrap_or_default();
    if protocol == "hls" || url.to_ascii_lowercase().contains("/hls") {
        Some(TranscodingProtocol::Hls)
    } else {
        None
    }
}

fn map_track(item: &Value) -> Option<ScTrack> {
    if item.get("kind").and_then(|k| k.as_str()) != Some("track") {
        return None;
    }
    let id = item.get("id").and_then(|v| v.as_i64())?.to_string();
    let title = item.get("title").and_then(|v| v.as_str())?.to_string();
    let artist = item
        .pointer("/user/username")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();
    let duration_ms = item.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
    let artwork_url = item.get("artwork_url").and_then(|v| v.as_str()).map(upscale_artwork);
    let artist_avatar_url = item
        .pointer("/user/avatar_url")
        .and_then(|v| v.as_str())
        .map(upscale_artwork);
    let permalink_url = item
        .get("permalink_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let streamable = item.get("streamable").and_then(|v| v.as_bool()).unwrap_or(false);
    let full_access = item.get("policy").and_then(Value::as_str) != Some("SNIP");
    let has_progressive = item
        .pointer("/media/transcodings")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter().any(|t| transcoding_protocol(t) == Some(TranscodingProtocol::Progressive)
                && !t.get("snipped").and_then(Value::as_bool).unwrap_or(false))
        })
        .unwrap_or(false) && full_access;
    let has_hls = item
        .pointer("/media/transcodings")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .any(|t| transcoding_protocol(t) == Some(TranscodingProtocol::Hls))
        })
        .unwrap_or(false) && full_access;
    if !streamable {
        return None;
    }
    Some(ScTrack {
        id,
        title,
        artist,
        duration_ms,
        artwork_url,
        artist_avatar_url,
        permalink_url,
        streamable,
        has_progressive,
        has_hls,
        uploader_id: item.pointer("/user/id").and_then(Value::as_i64).map(|id| id.to_string()),
        uploader_name: item.pointer("/user/username").and_then(Value::as_str).map(str::to_string),
        metadata_artist: item.get("metadata_artist").and_then(Value::as_str)
            .or_else(|| item.pointer("/publisher_metadata/artist").and_then(Value::as_str))
            .filter(|s| !s.trim().is_empty()).map(str::to_string),
        genre: item.get("genre").and_then(Value::as_str).map(str::to_string),
        tags: item.get("tag_list").and_then(Value::as_str).map(|tags| {
            Regex::new(r#""([^"]+)"|(\S+)"#).expect("tag regex").captures_iter(tags)
                .filter_map(|c| c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_string()))
                .take(64).collect()
        }),
        description: item.get("description").and_then(Value::as_str).map(|s| s.chars().take(4096).collect()),
        bpm: item.get("bpm").and_then(Value::as_f64).filter(|bpm| *bpm > 0.0 && bpm.is_finite()),
        isrc: item.get("isrc").and_then(Value::as_str)
            .or_else(|| item.pointer("/publisher_metadata/isrc").and_then(Value::as_str)).map(str::to_string),
    })
}

/// SoundCloud hands back a 100px thumbnail by default; the 500px one is the
/// same URL with a different suffix.
fn upscale_artwork(url: &str) -> String {
    url.replace("-large.jpg", "-t500x500.jpg")
        .replace("-large.png", "-t500x500.png")
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScPlaylist {
    pub id: String,
    pub title: String,
    pub user: String,
    pub track_count: u32,
    pub duration_ms: i64,
    /// SoundCloud marks a release as `playlist_type: "album"`, which is the only
    /// way to tell an album from a playlist someone assembled by hand.
    pub is_album: bool,
    pub artwork_url: Option<String>,
    pub permalink_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScArtist {
    pub id: String,
    pub username: String,
    pub track_count: u32,
    pub avatar_url: Option<String>,
    pub permalink_url: Option<String>,
    pub verified: bool,
}

fn map_playlist(item: &Value) -> Option<ScPlaylist> {
    if item.get("kind").and_then(|k| k.as_str()) != Some("playlist") {
        return None;
    }
    let id = item.get("id").and_then(|v| v.as_i64())?.to_string();
    let title = item.get("title").and_then(|v| v.as_str())?.to_string();
    let user = item
        .pointer("/user/username")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();
    // More often than not a playlist has no artwork of its own; SoundCloud's
    // own UI falls back to the first track's, so this does too.
    let artwork_url = item
        .get("artwork_url")
        .and_then(|v| v.as_str())
        .or_else(|| item.pointer("/tracks/0/artwork_url").and_then(|v| v.as_str()))
        .map(upscale_artwork);
    Some(ScPlaylist {
        id,
        title,
        user,
        track_count: item.get("track_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        duration_ms: item.get("duration").and_then(|v| v.as_i64()).unwrap_or(0),
        is_album: item.get("playlist_type").and_then(|v| v.as_str()) == Some("album"),
        artwork_url,
        permalink_url: item
            .get("permalink_url")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

fn map_artist(item: &Value) -> Option<ScArtist> {
    if item.get("kind").and_then(|k| k.as_str()) != Some("user") {
        return None;
    }
    let id = item.get("id").and_then(|v| v.as_i64())?.to_string();
    let username = item.get("username").and_then(|v| v.as_str())?.to_string();
    Some(ScArtist {
        id,
        username,
        track_count: item.get("track_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        avatar_url: item.get("avatar_url").and_then(|v| v.as_str()).map(upscale_artwork),
        permalink_url: item
            .get("permalink_url")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        verified: item.get("verified").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

/// Every listing endpoint here answers with the same envelope: a `collection`
/// array of items of one kind. Mapping is passed in so the response is never
/// cloned just to outlive the borrow.
async fn collection_map<T>(
    path: &str,
    query: Option<&str>,
    limit: u32,
    offset: u32,
    map: fn(&Value) -> Option<T>,
) -> Result<Vec<T>, String> {
    let mut params = format!("limit={}&offset={}", limit.clamp(1, 200), offset);
    if let Some(q) = query {
        params = format!("q={}&{params}", queryencode(q));
    }
    let url = format!("{API}{path}?{params}&client_id=");
    let json = get_json_with_fresh_client(&url).await?;
    let collection = json
        .get("collection")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "unexpected listing response".to_string())?;
    Ok(collection.iter().filter_map(map).collect())
}

/// The per-kind endpoints rather than the mixed `/search`, so `limit` is a
/// count of the thing that was asked for rather than a share of a mixture.
pub async fn search_tracks(query: &str, limit: u32, offset: u32) -> Result<Vec<ScTrack>, String> {
    collection_map("/search/tracks", Some(query), limit, offset, map_track).await
}

pub async fn search_playlists(query: &str, limit: u32, offset: u32) -> Result<Vec<ScPlaylist>, String> {
    collection_map("/search/playlists", Some(query), limit, offset, map_playlist).await
}

pub async fn search_artists(query: &str, limit: u32, offset: u32) -> Result<Vec<ScArtist>, String> {
    collection_map("/search/users", Some(query), limit, offset, map_artist).await
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScRelatedPage {
    pub tracks: Vec<ScTrack>,
    pub next_cursor: Option<String>,
    pub source: String,
    pub retry_at: Option<i64>,
    pub error: Option<String>,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub failed_endpoint: Option<String>,
}

#[derive(Default)]
struct RecommendationBudget {
    last_start: Option<Instant>,
    retry_at: i64,
    failures: usize,
}
fn recommendation_budget() -> &'static Mutex<RecommendationBudget> {
    static BUDGET: OnceLock<Mutex<RecommendationBudget>> = OnceLock::new();
    BUDGET.get_or_init(|| Mutex::new(RecommendationBudget::default()))
}
fn recommendation_slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(2))
}
fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64).unwrap_or(0)
}
struct RecommendationFailure {
    error: String,
    retry_at: Option<i64>,
    status: Option<u16>,
    endpoint: Option<String>,
}
impl RecommendationFailure {
    fn new(error: impl Into<String>) -> Self {
        Self { error: error.into(), retry_at: None, status: None, endpoint: None }
    }
}
fn recommendation_endpoint(url: &reqwest::Url) -> String {
    let path = url.path();
    if url.host_str() == Some("soundcloud.com") {
        "client-id".into()
    } else if url.host_str() == Some("api-v2.soundcloud.com") && path == "/search/tracks"
        && url.query_pairs().any(|(key, _)| key == "filter.genre_or_tag") {
        "genre-search".into()
    } else if path == "/search/tracks" {
        "search".into()
    } else if path == "/tracks" {
        "track-hydration".into()
    } else if path.starts_with("/tracks/") && path.ends_with("/related") {
        "related".into()
    } else if path.starts_with("/system-playlists/track-stations:") {
        "station".into()
    } else {
        "other".into()
    }
}
fn server_retry_at(headers: &reqwest::header::HeaderMap, now: i64) -> Option<i64> {
    let retry = headers.get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.trim().parse::<f64>().ok().filter(|s| s.is_finite() && *s >= 0.0)
                .map(|s| now.saturating_add((s * 1000.0) as i64))
                .or_else(|| chrono::DateTime::parse_from_rfc2822(v).ok().map(|d| d.timestamp_millis()))
        });
    let reset = ["x-ratelimit-reset", "ratelimit-reset", "x-rate-limit-reset"]
        .iter().filter_map(|name| headers.get(*name)?.to_str().ok()?.parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(|s| {
            if s >= 1_000_000_000_000.0 { s as i64 }
            else if s >= 1_000_000_000.0 { (s * 1000.0) as i64 }
            else { now.saturating_add((s * 1000.0) as i64) }
        }).max();
    retry.into_iter().chain(reset).filter(|at| *at > now).max()
}

/// Recommendation traffic alone shares both limits, including auth and stub hydration.
async fn recommendation_body(url: &reqwest::Url) -> Result<String, RecommendationFailure> {
    let _permit = recommendation_slots().acquire().await
        .map_err(|_| RecommendationFailure::new("Recommendation request gate closed"))?;
    loop {
        let wait = {
            let mut budget = recommendation_budget().lock().await;
            if budget.retry_at > now_ms() {
                return Err(RecommendationFailure { error: "SoundCloud cooldown".into(), retry_at: Some(budget.retry_at), status: Some(429), endpoint: Some(recommendation_endpoint(url)) });
            }
            let wait = budget.last_start.map(|last| Duration::from_millis(800).saturating_sub(last.elapsed()))
                .unwrap_or_default();
            if wait.is_zero() {
                budget.last_start = Some(Instant::now());
                break;
            }
            wait
        };
        // A 429 response can publish cooldown while this request waits for spacing.
        // Reacquire and recheck both cooldown and the latest reservation on wake.
        tokio::time::sleep(wait).await;
    }
    // Never follow provider redirects to a different endpoint/host with credentials.
    static CLIENT: OnceLock<Client> = OnceLock::new();
    let response = CLIENT.get_or_init(|| Client::builder().user_agent(DESKTOP_UA)
        .timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none())
        .build().expect("recommendation HTTP client"))
        .get(url.clone()).send().await
        .map_err(|_| RecommendationFailure::new("SoundCloud recommendation request failed"))?;
    let status = response.status();
    if status.as_u16() == 429 {
        let now = now_ms();
        let mut budget = recommendation_budget().lock().await;
        let base = [30_000_i64, 60_000, 120_000, 300_000][budget.failures.min(3)];
        budget.failures = budget.failures.saturating_add(1);
        let jittered = base + (now % 401 - 200) * base / 1000;
        budget.retry_at = budget.retry_at.max(server_retry_at(response.headers(), now).unwrap_or(now + jittered));
        return Err(RecommendationFailure { error: "SoundCloud rate limit".into(), retry_at: Some(budget.retry_at), status: Some(429), endpoint: Some(recommendation_endpoint(url)) });
    }
    if !status.is_success() {
        let endpoint = recommendation_endpoint(url);
        return Err(RecommendationFailure {
            error: format!("SoundCloud recommendation HTTP {} at {} endpoint", status.as_u16(), endpoint),
            retry_at: None, status: Some(status.as_u16()), endpoint: Some(endpoint),
        });
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| RecommendationFailure::new("SoundCloud response interrupted"))?;
        if bytes.len() + part.len() > 2 * 1024 * 1024 {
            return Err(RecommendationFailure::new("SoundCloud response exceeds 2 MiB"));
        }
        bytes.extend_from_slice(&part);
    }
    recommendation_budget().lock().await.failures = 0;
    String::from_utf8(bytes).map_err(|_| RecommendationFailure::new("Invalid SoundCloud response encoding"))
}

async fn recommendation_client_id(refresh: bool) -> Result<String, RecommendationFailure> {
    static AUTH: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = AUTH.get_or_init(|| Mutex::new(())).lock().await;
    if !refresh {
        if let Some(id) = client_id_slot().read().await.clone() { return Ok(id); }
    }
    let html = recommendation_body(&reqwest::Url::parse(SITE).expect("site URL")).await?;
    let re = Regex::new(r#""hydratable":"apiClient","data":\{"id":"([^"]+)""#).expect("client regex");
    let id = re.captures(&html).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
        .ok_or_else(|| RecommendationFailure::new("SoundCloud web client ID unavailable"))?;
    *client_id_slot().write().await = Some(id.clone());
    Ok(id)
}
async fn recommendation_json(mut url: reqwest::Url) -> Result<Value, RecommendationFailure> {
    let cid = recommendation_client_id(false).await?;
    url.query_pairs_mut().append_pair("client_id", &cid);
    let body = match recommendation_body(&url).await {
        Err(failure) if matches!(failure.status, Some(401 | 403)) => {
            let fresh = recommendation_client_id(true).await?;
            let pairs: Vec<_> = url.query_pairs().filter(|(k, _)| k != "client_id")
                .map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
            url.set_query(None);
            url.query_pairs_mut().extend_pairs(pairs).append_pair("client_id", &fresh);
            recommendation_body(&url).await?
        }
        other => other?,
    };
    serde_json::from_str(&body).map_err(|_| RecommendationFailure::new("Invalid SoundCloud recommendation JSON"))
}

fn recommendation_cursor(raw: &str, expected_path: &str) -> Result<reqwest::Url, String> {
    if raw.len() > 2048 { return Err("Oversized SoundCloud cursor".into()); }
    let mut url = reqwest::Url::parse(raw).map_err(|_| "Invalid SoundCloud cursor")?;
    if url.scheme() != "https" || url.host_str() != Some("api-v2.soundcloud.com")
        || url.port().is_some() || !url.username().is_empty() || url.password().is_some()
        || url.fragment().is_some() || url.path() != expected_path {
        return Err("Unexpected SoundCloud cursor endpoint".into());
    }
    let mut pairs = Vec::new();
    let mut keys = HashSet::new();
    for (key, value) in url.query_pairs() {
        if key == "client_id" { continue; }
        if !matches!(key.as_ref(), "cursor" | "offset" | "limit" | "linked_partitioning" | "tempo_station_offset")
            || !keys.insert(key.to_string()) {
            return Err("Unexpected SoundCloud cursor parameter".into());
        }
        pairs.push((key.into_owned(), value.into_owned()));
    }
    pairs.sort();
    url.set_query(None);
    if !pairs.is_empty() { url.query_pairs_mut().extend_pairs(pairs); }
    Ok(url)
}

#[tauri::command]
pub async fn sc_recommendation_search(
    state: tauri::State<'_, crate::commands::AppState>, query: String, limit: u32,
) -> Result<ScRelatedPage, String> {
    if query.trim().is_empty() || query.len() > 1024 {return Err("Invalid recommendation search query".into());}
    let saved=state.db.get_app_setting("recommendation_provider_retry_at")?
        .and_then(|value|value.parse::<i64>().ok()).unwrap_or(0);
    if saved>now_ms() {
        return Ok(ScRelatedPage{tracks:Vec::new(),next_cursor:None,source:"related".into(),retry_at:Some(saved),error:Some("SoundCloud cooldown".into()),status:Some(429),failed_endpoint:None});
    }
    let mut url=reqwest::Url::parse(&format!("{API}/search/tracks")).expect("search URL");
    url.query_pairs_mut().append_pair("q",query.trim()).append_pair("limit",&limit.clamp(1,20).to_string());
    let mut result=ScRelatedPage{tracks:Vec::new(),next_cursor:None,source:"related".into(),retry_at:None,error:None,status:None,failed_endpoint:None};
    match recommendation_json(url).await {
        Ok(value)=>match value.get("collection").and_then(Value::as_array) {
            Some(items)=>result.tracks=items.iter().take(limit.clamp(1,20) as usize).filter_map(map_track).collect(),
            None=>result.error=Some("Unexpected recommendation search response".into()),
        },
        Err(failure)=>{result.retry_at=failure.retry_at;result.status=failure.status;result.failed_endpoint=failure.endpoint;result.error=Some(failure.error);}
    }
    if let Some(retry_at)=result.retry_at {state.db.set_app_setting("recommendation_provider_retry_at",&retry_at.to_string())?;}
    Ok(result)
}

/// Fetches a genre-specific SoundCloud page independently from personalized
/// recommendation state. The documented public track-search `genres` filter
/// keeps this shelf from inheriting the main feed's seeds or candidates.
#[tauri::command]
pub async fn sc_recommendation_genre_search(
    state: tauri::State<'_, crate::commands::AppState>, genre: String, limit: u32,
) -> Result<ScRelatedPage, String> {
    let genre = genre.trim();
    if genre.is_empty() || genre.len() > 96 || genre.chars().any(char::is_control) {
        return Err("Invalid SoundCloud genre".into());
    }
    let saved = state.db.get_app_setting("recommendation_provider_retry_at")?
        .and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
    if saved > now_ms() {
        return Ok(ScRelatedPage { tracks: Vec::new(), next_cursor: None, source: "genre".into(),
            retry_at: Some(saved), error: Some("SoundCloud cooldown".into()), status: Some(429), failed_endpoint: None });
    }
    let limit = limit.clamp(1, 50);
    let cache_key = format!("sc-genre:v2:{}:{limit}", genre.to_lowercase());
    if let Some(cached) = crate::recommendation_store::page(&state.db, &cache_key)? {
        if let Ok(page) = serde_json::from_value::<ScRelatedPage>(cached.data) {
            if page.error.is_none() && page.retry_at.is_none() && page.source == "genre" {
                return Ok(page);
            }
        }
    }

    let mut url = reqwest::Url::parse(&format!("{API}/search/tracks")).expect("genre search URL");
    url.query_pairs_mut().append_pair("q", genre)
        .append_pair("filter.genre_or_tag", genre)
        .append_pair("access", "playable")
        .append_pair("limit", &limit.to_string())
        .append_pair("linked_partitioning", "true");
    let mut result = ScRelatedPage { tracks: Vec::new(), next_cursor: None, source: "genre".into(),
        retry_at: None, error: None, status: None, failed_endpoint: None };
    match recommendation_json(url).await {
        Ok(value) => result.tracks = tracks_from_response(&value).into_iter().take(limit as usize).collect(),
        Err(failure) => {
            result.retry_at = failure.retry_at;
            result.status = failure.status;
            result.failed_endpoint = failure.endpoint;
            result.error = Some(failure.error);
        }
    }
    if let Some(retry_at) = result.retry_at {
        state.db.set_app_setting("recommendation_provider_retry_at", &retry_at.to_string())?;
    }
    if result.error.is_none() {
        crate::recommendation_store::save_page(&state.db, crate::recommendation_store::ProviderPage {
            key: cache_key, fetched_at: now_ms(), data: serde_json::to_value(&result).map_err(|e| e.to_string())?,
        })?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn sc_recommendation_page(
    state: tauri::State<'_, crate::commands::AppState>, seed_id: String,
    cursor: Option<String>, limit: u32, source: String,
) -> Result<ScRelatedPage, String> {
    let saved=state.db.get_app_setting("recommendation_provider_retry_at")?
        .and_then(|value|value.parse::<i64>().ok()).unwrap_or(0);
    if saved>now_ms() {
        return Ok(ScRelatedPage{tracks:Vec::new(),next_cursor:None,source:source.clone(),retry_at:Some(saved),error:Some("SoundCloud cooldown".into()),status:Some(429),failed_endpoint:None});
    }
    if seed_id.is_empty() || seed_id.len() > 32 || !seed_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Invalid SoundCloud recommendation seed".into());
    }
    let path = match source.as_str() {
        "related" => format!("/tracks/{seed_id}/related"),
        "station" => format!("/system-playlists/track-stations:{seed_id}"),
        _ => return Err("Invalid recommendation source".into()),
    };
    let limit = limit.clamp(1, 50);
    // Match the previously working api-v2 request shape; the endpoint returns
    // next_href when pagination is available, while stations use our own offset.
    let initial = format!("{API}{path}?limit={limit}");
    let url = recommendation_cursor(cursor.as_deref().unwrap_or(&initial), &path)?;
    let station_offset = url.query_pairs().find(|(k, _)| k == "tempo_station_offset")
        .map(|(_, v)| v.parse::<usize>().map_err(|_| "Invalid station slice cursor"))
        .transpose()?.unwrap_or(0);
    if station_offset > 5000 || (source == "related" && station_offset != 0) {
        return Err("Invalid station slice cursor".into());
    }
    let cache_key = format!("sc-page:v1:{source}:{seed_id}:{limit}:{url}");
    if let Some(cached) = crate::recommendation_store::page(&state.db, &cache_key)? {
        if let Ok(page) = serde_json::from_value::<ScRelatedPage>(cached.data) {
            if page.error.is_none() && page.retry_at.is_none() && page.source == source
                && page.next_cursor.as_ref().is_none_or(|next| recommendation_cursor(next, &path).is_ok()) {
                return Ok(page);
            }
        }
    }
    let mut result = ScRelatedPage { tracks: Vec::new(), next_cursor: None, source: source.clone(), retry_at: None, error: None, status: None, failed_endpoint: None };
    let mut request = url.clone();
    let pairs: Vec<_> = request.query_pairs().filter(|(k, _)| k != "tempo_station_offset")
        .map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    request.set_query(None);
    request.query_pairs_mut().extend_pairs(pairs);
    let value = match recommendation_json(request).await {
        Ok(value) => value,
        Err(failure) => {
            result.retry_at = failure.retry_at; result.status = failure.status;
            result.failed_endpoint = failure.endpoint; result.error = Some(failure.error);
            if let Some(retry_at)=result.retry_at {state.db.set_app_setting("recommendation_provider_retry_at",&retry_at.to_string())?;}
            return Ok(result);
        }
    };
    let Some(entries) = value.get("collection").or_else(|| value.get("tracks")).and_then(Value::as_array) else {
        result.error = Some("Unexpected SoundCloud recommendation response".into());
        return Ok(result);
    };
    // Station offset is our slicing cursor, not a claimed provider paging parameter.
    let items: Vec<_> = if source == "station" {
        entries.iter().take(5000).skip(station_offset).take(limit as usize).collect()
    } else { entries.iter().take(limit as usize).collect() };
    let mut ordered = Vec::new();
    let mut tracks = HashMap::new();
    let mut stubs = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_i64).filter(|id| *id > 0).map(|id| id.to_string()) else { continue; };
        if ordered.contains(&id) { continue; }
        ordered.push(id.clone());
        if let Some(track) = map_track(item) { tracks.insert(id, track); }
        else if item.get("title").is_none() { stubs.push(id); }
    }
    // One batch of at most fifty; no unbounded single-track retry waterfall.
    if !stubs.is_empty() {
        let mut batch = reqwest::Url::parse(&format!("{API}/tracks")).expect("batch URL");
        batch.query_pairs_mut().append_pair("ids", &stubs.join(","));
        match recommendation_json(batch).await {
            Ok(value) => {
                if let Some(items) = value.as_array() {
                    for track in items.iter().filter_map(map_track) {
                        if stubs.contains(&track.id) { tracks.insert(track.id.clone(), track); }
                    }
                } else { result.error = Some("Unexpected SoundCloud stub response".into()); }
            }
            Err(failure) => {
                result.retry_at = failure.retry_at; result.status = failure.status;
                result.failed_endpoint = failure.endpoint; result.error = Some(failure.error);
                if let Some(retry_at)=result.retry_at {state.db.set_app_setting("recommendation_provider_retry_at",&retry_at.to_string())?;}
            }
        }
    }
    result.tracks = ordered.into_iter().filter_map(|id| tracks.remove(&id))
        .filter(|track| track.id != seed_id && (track.has_progressive || track.has_hls)).collect();
    if source == "station" && station_offset + (limit as usize) < entries.len().min(5000) {
        let mut next = url.clone();
        let pairs: Vec<_> = next.query_pairs().filter(|(k, _)| k != "tempo_station_offset")
            .map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        next.set_query(None);
        next.query_pairs_mut().extend_pairs(pairs).append_pair("tempo_station_offset", &(station_offset + limit as usize).to_string());
        result.next_cursor = Some(recommendation_cursor(next.as_str(), &path)?.to_string());
    } else if let Some(next) = value.get("next_href").and_then(Value::as_str) {
        match recommendation_cursor(next, &path) {
            Ok(next) if next != url => result.next_cursor = Some(next.to_string()),
            Ok(_) => result.error = Some("SoundCloud cursor loop".into()),
            Err(error) => result.error = Some(error),
        }
    }
    // Cached continuation edges detect A -> B -> A without requesting A again.
    let mut visited = HashSet::from([url.to_string()]);
    let mut next = result.next_cursor.clone();
    for _ in 0..200 {
        let Some(cursor) = next else { break; };
        if !visited.insert(cursor.clone()) {
            result.error = Some("SoundCloud cursor loop".into());
            break;
        }
        let key = format!("sc-page:v1:{source}:{seed_id}:{limit}:{cursor}");
        next = crate::recommendation_store::page(&state.db, &key)?
            .and_then(|page| serde_json::from_value::<ScRelatedPage>(page.data).ok())
            .and_then(|page| page.next_cursor);
    }
    if result.error.is_none() {
        crate::recommendation_store::save_page(&state.db, crate::recommendation_store::ProviderPage {
            key: cache_key, fetched_at: now_ms(), data: serde_json::to_value(&result).map_err(|e| e.to_string())?,
        })?;
    } else {
        // A hydration failure must retry the same page, never skip unresolved uploads.
        result.next_cursor = None;
    }
    Ok(result)
}

fn tracks_from_response(value: &Value) -> Vec<ScTrack> {
    value
        .get("collection")
        .or_else(|| value.get("tracks"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(map_track)
                .filter(|track| track.has_progressive || track.has_hls)
                .collect()
        })
        .unwrap_or_default()
}

async fn related_for_seed(track_id: &str, limit: u32) -> Result<Vec<ScTrack>, String> {
    if track_id.is_empty() || !track_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid SoundCloud seed track id".to_string());
    }

    let related_url = reqwest::Url::parse(&format!("{API}/tracks/{track_id}/related?limit={limit}"))
        .map_err(|e| e.to_string())?;
    let primary_error = match recommendation_json(related_url).await {
        Ok(json) => {
            let tracks: Vec<_> = tracks_from_response(&json)
                .into_iter()
                .filter(|track| track.id != track_id)
                .collect();
            if !tracks.is_empty() {
                return Ok(tracks);
            }
            "SoundCloud returned no playable related tracks".to_string()
        }
        Err(error) => {
            if error.retry_at.is_some() { return Err(error.error); }
            error.error
        },
    };

    // Track stations provide a second SoundCloud-generated source when the
    // related endpoint is empty or unavailable for a seed.
    let station_url = reqwest::Url::parse(&format!("{API}/system-playlists/track-stations:{track_id}"))
        .map_err(|e| e.to_string())?;
    match recommendation_json(station_url).await {
        Ok(json) => {
            let tracks: Vec<_> = tracks_from_response(&json)
                .into_iter()
                .filter(|track| track.id != track_id)
                .collect();
            if tracks.is_empty() {
                Err(format!("{primary_error}; station returned no playable tracks"))
            } else {
                Ok(tracks)
            }
        }
        Err(error) => Err(format!("{primary_error}; station fallback failed: {}", error.error)),
    }
}

/// Recommendations stay anchored to the user's own listening history: the
/// caller chooses a small random batch of SoundCloud track ids from its top
/// tracks and this function asks SoundCloud for related/station tracks.
pub async fn related_tracks(track_ids: &[String], limit: u32) -> Result<Vec<ScTrack>, String> {
    let mut seen_seeds = HashSet::new();
    let seeds: Vec<String> = track_ids
        .iter()
        .filter(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
        .filter(|id| seen_seeds.insert((*id).clone()))
        .take(3)
        .cloned()
        .collect();
    if seeds.is_empty() {
        return Err("no valid SoundCloud recommendation seeds".to_string());
    }

    // Resolve once before fanning out so a cold start does not fetch the
    // SoundCloud homepage separately for each seed request.
    recommendation_client_id(false).await.map_err(|e| e.error)?;
    let per_seed = limit.clamp(1, 24);
    let responses = futures_util::stream::iter(seeds.clone())
        .map(|seed| async move {
            let response = related_for_seed(&seed, per_seed).await;
            (seed, response)
        })
        .buffer_unordered(3)
        .collect::<Vec<_>>()
        .await;

    let seed_ids: HashSet<&str> = seeds.iter().map(String::as_str).collect();
    let mut seen_tracks = HashSet::new();
    let mut tracks = Vec::new();
    let mut last_error = None;
    for (_, response) in responses {
        match response {
            Ok(items) => {
                for track in items {
                    if seed_ids.contains(track.id.as_str()) || !seen_tracks.insert(track.id.clone()) {
                        continue;
                    }
                    tracks.push(track);
                    if tracks.len() >= limit.clamp(1, 24) as usize {
                        return Ok(tracks);
                    }
                }
            }
            Err(error) => last_error = Some(error),
        }
    }
    if tracks.is_empty() {
        if let Some(error) = last_error {
            return Err(error);
        }
    }
    Ok(tracks)
}

pub async fn get_user(id: &str) -> Result<ScArtist, String> {
    let json = get_json_with_fresh_client(&format!("{API}/users/{id}?client_id=")).await?;
    map_artist(&json).ok_or_else(|| "that is not a SoundCloud user".to_string())
}

pub async fn user_tracks(id: &str, limit: u32, offset: u32) -> Result<Vec<ScTrack>, String> {
    collection_map(&format!("/users/{id}/tracks"), None, limit, offset, map_track).await
}

/// A user's playlists, which is where SoundCloud keeps their releases too -
/// `/users/{id}/playlists` returns both, split by `playlist_type`.
pub async fn user_playlists(id: &str, limit: u32, offset: u32) -> Result<Vec<ScPlaylist>, String> {
    collection_map(&format!("/users/{id}/playlists"), None, limit, offset, map_playlist).await
}

/// Resolves track stubs by id.
///
/// SoundCloud hands back most of a large playlist's tracks as *stubs* - objects
/// carrying nothing but an `id`. They are resolved in batches through
/// `/tracks?ids=`, fifty at a time, which is what SoundCloud's own client does.
/// Without this only the handful of entries that happened to arrive fully
/// formed survive, which is why a forty track playlist loaded as five.
async fn resolve_track_stubs(ids: Vec<String>) -> Vec<ScTrack> {
    const CHUNK: usize = 50;
    let mut out = Vec::new();
    for chunk in ids.chunks(CHUNK) {
        let url = format!("{API}/tracks?ids={}&client_id=", chunk.join(","));
        match get_json_with_fresh_client(&url).await {
            Ok(json) => {
                // the batch endpoint answers with a bare array, not an envelope
                if let Some(list) = json.as_array() {
                    out.extend(list.iter().filter_map(map_track));
                }
            }
            Err(_) => {
                // One at a time as a last resort, and capped: a failing batch
                // should degrade into a short playlist, not hundreds of calls.
                for id in chunk.iter().take(20) {
                    let single = format!("{API}/tracks/{id}?client_id=");
                    if let Ok(one) = get_json_with_fresh_client(&single).await {
                        if let Some(track) = map_track(&one) {
                            out.push(track);
                        }
                    }
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScPlaylistDetail {
    pub playlist: ScPlaylist,
    pub tracks: Vec<ScTrack>,
}

pub async fn get_playlist(id: &str) -> Result<ScPlaylistDetail, String> {
    let json = get_json_with_fresh_client(&format!("{API}/playlists/{id}?client_id=")).await?;
    let playlist = map_playlist(&json).ok_or_else(|| "that is not a SoundCloud playlist".to_string())?;

    // The `tracks` array is in playlist order and mixes fully formed tracks with
    // stubs, so the order is kept as a list of ids and the tracks are filled in
    // from whichever source has them. Concatenating the two lists instead would
    // lose the order, which for an album is the whole point.
    let empty = Vec::new();
    let entries = json.get("tracks").and_then(|v| v.as_array()).unwrap_or(&empty);
    let mut order: Vec<String> = Vec::new();
    let mut known: HashMap<String, ScTrack> = HashMap::new();
    let mut stubs: Vec<String> = Vec::new();
    for item in entries {
        let Some(raw) = item.get("id").and_then(|v| v.as_i64()) else {
            continue;
        };
        let track_id = raw.to_string();
        order.push(track_id.clone());
        if item.get("title").is_none() {
            // a stub: nothing but an id
            stubs.push(track_id);
        } else if let Some(track) = map_track(item) {
            known.insert(track_id, track);
        }
    }
    if !stubs.is_empty() {
        for track in resolve_track_stubs(stubs).await {
            known.insert(track.id.clone(), track);
        }
    }

    let tracks: Vec<ScTrack> = order.into_iter().filter_map(|tid| known.remove(&tid)).collect();
    Ok(ScPlaylistDetail { playlist, tracks })
}

/// An artist's releases, each with its track list.
///
/// N+1 by nature, and capped, because an artist with a hundred releases should
/// not turn one action into a hundred round trips. A release that fails to load
/// is skipped rather than failing the lot.
pub async fn user_releases_with_tracks(id: &str) -> Result<Vec<ScPlaylistDetail>, String> {
    const MAX_RELEASES: usize = 20;
    let releases = user_playlists(id, 50, 0).await?;
    let mut out = Vec::new();
    for release in releases.into_iter().take(MAX_RELEASES) {
        // Reuses the resilient path above rather than paging directly, so a
        // release whose paged endpoint is unavailable still arrives with the
        // tracks its object carries.
        if let Ok(detail) = get_playlist(&release.id).await {
            out.push(detail);
        }
    }
    Ok(out)
}

fn stream_cache() -> &'static tokio::sync::Mutex<HashMap<String, (StreamInfo, Instant)>> {
    static CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, (StreamInfo, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

async fn resolve_stream_info(track_id: &str) -> Result<StreamInfo, String> {
    let meta = get_json_with_fresh_client(&format!("{API}/tracks/{track_id}?client_id=")).await?;
    let auth = meta
        .get("track_authorization")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let transcodings = meta
        .pointer("/media/transcodings")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "no stream for this track".to_string())?;
    let mut candidates: Vec<_> = transcodings.iter().filter_map(|transcoding| {
        transcoding_protocol(transcoding).map(|protocol| (transcoding, protocol))
    }).collect();
    candidates.sort_by_key(|(_, protocol)| match protocol {
        TranscodingProtocol::Progressive => 0,
        TranscodingProtocol::Hls => 1,
    });
    if candidates.is_empty() {
        return Err("no stream for this track".to_string());
    }
    let client_id = get_client_id().await?;
    let mut last_error = None;
    for (transcoding, protocol) in candidates {
        let Some(transcoding_url) = transcoding.get("url").and_then(Value::as_str) else {
            last_error = Some("transcoding url missing".to_string());
            continue;
        };
        let mut url = reqwest::Url::parse(transcoding_url).map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("client_id", &client_id)
            .append_pair("track_authorization", auth);
        match get_json(url.as_str()).await {
            Ok(value) => {
                if let Some(final_url) = value.get("url").and_then(Value::as_str) {
                    return Ok(StreamInfo {
                        url: final_url.to_string(),
                        format: match protocol {
                            TranscodingProtocol::Hls => "hls",
                            TranscodingProtocol::Progressive => "progressive",
                        }.to_string(),
                    });
                }
                last_error = Some("media url missing".to_string());
            }
            // A per-format 404 does not necessarily mean the track is unavailable:
            // another transcoding may still be playable, so try it next.
            Err(error) if error.starts_with("SC_CLIENT_ERROR 403 ") || error.starts_with("SC_CLIENT_ERROR 404 ") => {
                last_error = Some(error)
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "no stream for this track".to_string()))
}

pub async fn get_stream_info(track_id: &str) -> Result<StreamInfo, String> {
    {
        let cache = stream_cache().lock().await;
        if let Some((info, at)) = cache.get(track_id) {
            if at.elapsed() < STREAM_TTL {
                return Ok(info.clone());
            }
        }
    }
    let info = match resolve_stream_info(track_id).await {
        Ok(v) => v,
        Err(e) if e.starts_with("SC_CLIENT_ERROR") => {
            fetch_client_id().await?;
            resolve_stream_info(track_id).await?
        }
        Err(e) if e.contains("no stream") => return Err(e),
        Err(e) => return Err(e),
    };
    stream_cache()
        .lock()
        .await
        .insert(track_id.to_string(), (info.clone(), Instant::now()));
    Ok(info)
}

pub async fn get_stream_url(track_id: &str) -> Result<String, String> {
    Ok(get_stream_info(track_id).await?.url)
}

fn queryencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_id_regex_extracts_from_hydration_html() {
        let html = r#"x"hydratable":"apiClient","data":{"id":"AbCd1234Xy"}y"#;
        let re = Regex::new(r#""hydratable":"apiClient","data":\{"id":"([^"]+)""#).unwrap();
        assert_eq!(re.captures(html).unwrap().get(1).unwrap().as_str(), "AbCd1234Xy");
    }

    #[test]
    fn queryencode_encodes_spaces_and_cyrillic() {
        assert_eq!(queryencode("a b"), "a%20b");
        assert_eq!(queryencode("эпп"), "%D1%8D%D0%BF%D0%BF");
    }

    #[test]
    fn recognizes_hls_transcoding_when_protocol_is_missing_but_url_is_hls() {
        let value = serde_json::json!({
            "kind": "track", "id": 42, "title": "AAC HLS", "duration": 180_000,
            "streamable": true,
            "user": { "username": "artist" },
            "media": { "transcodings": [{
                "url": "https://api-v2.soundcloud.com/media/track/stream/hls",
                "format": { "protocol": "http", "mime_type": "audio/mp4; codecs=\"mp4a.40.2\"" },
                "preset": "hls_aac_160"
            }] }
        });

        assert!(map_track(&value).unwrap().has_hls);
    }

    #[test]
    fn rejects_encrypted_hls_even_when_its_url_is_the_only_protocol_hint() {
        let value = serde_json::json!({
            "kind": "track", "id": 42, "title": "Restricted HLS", "duration": 180_000,
            "streamable": true,
            "user": { "username": "artist" },
            "media": { "transcodings": [{
                "url": "https://api-v2.soundcloud.com/media/track/stream/encrypted-hls",
                "format": { "protocol": "http", "mime_type": "audio/mp4" },
                "preset": "encrypted_hls_aac_160"
            }] }
        });

        assert!(!map_track(&value).unwrap().has_hls);
    }
}
