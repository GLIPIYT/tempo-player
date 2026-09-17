use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::RwLock;

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
    #[serde(default)]
    pub permalink_url: Option<String>,
    // sent by the SoundCloud API; the player's lightweight upsert omits them
    #[serde(default)]
    pub streamable: bool,
    #[serde(default)]
    pub has_progressive: bool,
    #[serde(default)]
    pub has_hls: bool,
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
        return Err(format!("SC_CLIENT_ERROR {}", status.as_u16()));
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
        Err(e) if e.starts_with("SC_CLIENT_ERROR") => {
            fetch_client_id().await?;
            get_json(&format!("{url}{}", get_client_id().await?)).await
        }
        other => other,
    }
}

fn is_encrypted(t: &Value) -> bool {
    if t.pointer("/format/protocol").and_then(|p| p.as_str()) != Some("hls") {
        return false;
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
    let permalink_url = item
        .get("permalink_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let streamable = item.get("streamable").and_then(|v| v.as_bool()).unwrap_or(false);
    let has_progressive = item
        .pointer("/media/transcodings")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .any(|t| t.pointer("/format/protocol").and_then(|p| p.as_str()) == Some("progressive"))
        })
        .unwrap_or(false);
    let has_hls = item
        .pointer("/media/transcodings")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .any(|t| t.pointer("/format/protocol").and_then(|p| p.as_str()) == Some("hls") && !is_encrypted(t))
        })
        .unwrap_or(false);
    if !streamable {
        return None;
    }
    Some(ScTrack {
        id,
        title,
        artist,
        duration_ms,
        artwork_url,
        permalink_url,
        streamable,
        has_progressive,
        has_hls,
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

/// Every `/search/*` endpoint answers with the same envelope: a `collection`
/// array of items of one kind. Mapping is passed in so the response is never
/// cloned just to outlive the borrow.
async fn search_map<T>(
    path: &str,
    query: &str,
    limit: u32,
    offset: u32,
    map: fn(&Value) -> Option<T>,
) -> Result<Vec<T>, String> {
    let url = format!(
        "{API}{path}?q={}&limit={}&offset={}&client_id=",
        queryencode(query),
        limit.clamp(1, 200),
        offset
    );
    let json = get_json_with_fresh_client(&url).await?;
    let collection = json
        .get("collection")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "unexpected search response".to_string())?;
    Ok(collection.iter().filter_map(map).collect())
}

/// The per-kind endpoints rather than the mixed `/search`, so `limit` is a
/// count of the thing that was asked for rather than a share of a mixture.
pub async fn search_tracks(query: &str, limit: u32, offset: u32) -> Result<Vec<ScTrack>, String> {
    search_map("/search/tracks", query, limit, offset, map_track).await
}

pub async fn search_playlists(query: &str, limit: u32, offset: u32) -> Result<Vec<ScPlaylist>, String> {
    search_map("/search/playlists", query, limit, offset, map_playlist).await
}

pub async fn search_artists(query: &str, limit: u32, offset: u32) -> Result<Vec<ScArtist>, String> {
    search_map("/search/users", query, limit, offset, map_artist).await
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
    let chosen = transcodings
        .iter()
        .find(|t| t.pointer("/format/protocol").and_then(|p| p.as_str()) == Some("progressive"))
        .or_else(|| {
            transcodings.iter().find(|t| {
                t.pointer("/format/protocol").and_then(|p| p.as_str()) == Some("hls") && !is_encrypted(t)
            })
        })
        .ok_or_else(|| "no stream for this track".to_string())?;
    let protocol = chosen
        .pointer("/format/protocol")
        .and_then(|p| p.as_str())
        .unwrap_or("progressive");
    let format = if protocol == "hls" { "hls" } else { "progressive" }.to_string();
    let turl = chosen
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "transcoding url missing".to_string())?;
    let final_url = get_json(&format!(
        "{turl}?client_id={}&track_authorization={auth}",
        get_client_id().await?
    ))
    .await?
    .get("url")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "media url missing".to_string())?
    .to_string();
    Ok(StreamInfo { url: final_url, format })
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
}
