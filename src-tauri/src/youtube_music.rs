//! Fast search metadata from the public YouTube Music web response.
//! Audio extraction remains yt-dlp's job. Callers fall back to its search if
//! this undocumented response changes or the request fails.
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::ytdlp::{YtCollectionHit, YtSearchHit};

const CLIENT_VERSION: &str = "1.20260930.01.00";
const CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_CACHE_ENTRIES: usize = 32;

#[derive(Clone)]
struct SearchRows {
    tracks: Vec<YtSearchHit>,
    collections: Vec<YtCollectionHit>,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36")
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_default()
    })
}

fn cache() -> &'static Mutex<HashMap<String, (Instant, SearchRows)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, SearchRows)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn search_tracks(query: &str, limit: u32) -> Result<Vec<YtSearchHit>, String> {
    Ok(search(query, "songs", limit).await?.tracks)
}

pub async fn search_collections(
    query: &str,
    section: &str,
    limit: u32,
) -> Result<Vec<YtCollectionHit>, String> {
    Ok(search(query, section, limit).await?.collections)
}

async fn search(query: &str, section: &str, limit: u32) -> Result<SearchRows, String> {
    let params = match section {
        "songs" => "EgWKAQIIAWoMEA4QChADEAQQCRAF",
        "albums" => "EgWKAQIYAWoMEA4QChADEAQQCRAF",
        "artists" => "EgWKAQIgAWoMEA4QChADEAQQCRAF",
        "playlists" => "EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D",
        _ => return Err("unknown YouTube Music search section".into()),
    };
    let limit = limit.clamp(1, 50) as usize;
    let key = format!("{section}:{limit}:{}", query.trim());
    if let Some((_, result)) = cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .filter(|(at, _)| at.elapsed() < CACHE_TTL)
    {
        return Ok(result.clone());
    }
    let body = json!({
        "context": { "client": {
            "clientName": "WEB_REMIX", "clientVersion": CLIENT_VERSION,
            "hl": "en", "gl": "US"
        }},
        "query": query.trim(), "params": params
    });
    let mut result = SearchRows {
        tracks: Vec::new(),
        collections: Vec::new(),
    };
    let mut continuation: Option<String> = None;
    let mut seen = HashSet::new();
    // Normal UI requests fit in the first response. Continuations cover larger
    // callers without starting one extraction process per result.
    for _ in 0..3 {
        let mut request = client()
            .post("https://music.youtube.com/youtubei/v1/search")
            .query(&[("alt", "json")])
            .header("Origin", "https://music.youtube.com")
            .header("X-Youtube-Client-Name", "67")
            .header("X-Youtube-Client-Version", CLIENT_VERSION)
            .json(&body);
        if let Some(token) = continuation.as_deref() {
            request = request.query(&[("continuation", token), ("ctoken", token)]);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("YouTube Music search: {e}"))?
            .error_for_status()
            .map_err(|e| format!("YouTube Music search: {e}"))?;
        let payload: Value = response.json().await.map_err(|e| e.to_string())?;
        let shelves = search_shelves(&payload)?;
        let before = result.tracks.len() + result.collections.len();
        let mut had_rows = false;
        let mut next = None;
        for shelf in shelves {
            if let Some(items) = shelf.get("contents").and_then(Value::as_array) {
                for item in items {
                    let Some(row) = item.get("musicResponsiveListItemRenderer") else {
                        continue;
                    };
                    if row
                        .get("musicItemRendererDisplayPolicy")
                        .and_then(Value::as_str)
                        != Some("MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT")
                    {
                        had_rows = true;
                    }
                    if section == "songs" {
                        if let Some(hit) = track(row) {
                            if seen.insert(hit.id.clone()) {
                                result.tracks.push(hit);
                            }
                        }
                    } else if let Some(hit) = collection(row, section) {
                        if seen.insert(hit.id.clone()) {
                            result.collections.push(hit);
                        }
                    }
                }
            }
            next = shelf
                .pointer("/continuations/0/nextContinuationData/continuation")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(next);
        }
        let count = result.tracks.len() + result.collections.len();
        if had_rows && count == before && before == 0 {
            return Err("YouTube Music search row metadata changed".into());
        }
        if count >= limit || next.is_none() {
            break;
        }
        continuation = next;
    }
    result.tracks.truncate(limit);
    result.collections.truncate(limit);
    let mut entries = cache().lock().unwrap_or_else(|e| e.into_inner());
    entries.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
    if entries.len() >= MAX_CACHE_ENTRIES {
        if let Some(oldest) = entries
            .iter()
            .min_by_key(|(_, (at, _))| *at)
            .map(|(key, _)| key.clone())
        {
            entries.remove(&oldest);
        }
    }
    entries.insert(key, (Instant::now(), result.clone()));
    Ok(result)
}

fn search_shelves(payload: &Value) -> Result<Vec<&Value>, String> {
    if let Some(shelf) = payload.pointer("/continuationContents/musicShelfContinuation") {
        return Ok(vec![shelf]);
    }
    let contents = payload
        .pointer("/contents/tabbedSearchResultsRenderer/tabs/0/tabRenderer/content")
        .or_else(|| payload.get("contents"))
        .ok_or("YouTube Music search response changed")?;
    let sections = contents
        .pointer("/sectionListRenderer/contents")
        .and_then(Value::as_array)
        .ok_or("YouTube Music search sections changed")?;
    let mut shelves = Vec::new();
    for section in sections {
        if let Some(shelf) = section.get("musicShelfRenderer") {
            if let Some(items) = shelf.get("contents").and_then(Value::as_array) {
                if items
                    .iter()
                    .any(|item| item.get("musicResponsiveListItemRenderer").is_some())
                {
                    shelves.push(shelf);
                }
            }
        }
    }
    // Suggestions also use itemSectionRenderer; its presence alone does not
    // prove there are no matches. Unknown layouts must use the fallback.
    let empty_message = sections.iter().any(|section| {
        section
            .pointer("/itemSectionRenderer/contents")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    let Some(message) = item.pointer("/messageRenderer/text") else {
                        return false;
                    };
                    let text = message
                        .get("simpleText")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| {
                            message.get("runs").and_then(Value::as_array).map(|runs| {
                                runs.iter()
                                    .filter_map(|run| run.get("text").and_then(Value::as_str))
                                    .collect::<String>()
                            })
                        })
                        .unwrap_or_default()
                        .to_lowercase();
                    text.contains("no results")
                })
            })
    });
    if shelves.is_empty() && !empty_message {
        return Err("YouTube Music search rows changed".into());
    }
    Ok(shelves)
}

fn runs(row: &Value, column: usize) -> Vec<&Value> {
    row.get("flexColumns")
        .and_then(Value::as_array)
        .and_then(|cols| cols.get(column))
        .and_then(|col| col.pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs"))
        .and_then(Value::as_array)
        .map(|list| list.iter().collect())
        .unwrap_or_default()
}

fn label(run: &Value) -> Option<&str> {
    run.get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn title(row: &Value) -> Option<String> {
    let value: String = runs(row, 0)
        .iter()
        .filter_map(|run| run.get("text").and_then(Value::as_str))
        .collect();
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn page_type(run: &Value) -> Option<&str> {
    run.pointer("/navigationEndpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
        .and_then(Value::as_str)
}

fn thumbnails(row: &Value) -> Vec<String> {
    row.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .rev()
                .filter_map(|item| item.get("url").and_then(Value::as_str))
                .filter(|url| url.starts_with("https://"))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn duration(text: &str) -> Option<i64> {
    let parts: Vec<_> = text.trim().split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0i64;
    for (i, part) in parts.iter().enumerate() {
        let value: i64 = part.parse().ok()?;
        if value < 0 || (i > 0 && value >= 60) {
            return None;
        }
        seconds = seconds.checked_mul(60)?.checked_add(value)?;
    }
    seconds.checked_mul(1000)
}

fn track(row: &Value) -> Option<YtSearchHit> {
    if row
        .get("musicItemRendererDisplayPolicy")
        .and_then(Value::as_str)
        == Some("MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT")
    {
        return None;
    }
    let id = row.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId")
        .or_else(|| row.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint/videoId"))
        .and_then(Value::as_str)?;
    let subtitle = runs(row, 1);
    let artists: Vec<_> = subtitle
        .iter()
        .filter(|run| page_type(run) == Some("MUSIC_PAGE_TYPE_ARTIST"))
        .filter_map(|run| label(run))
        .collect();
    let album = subtitle
        .iter()
        .find(|run| page_type(run) == Some("MUSIC_PAGE_TYPE_ALBUM"))
        .and_then(|run| label(run))
        .map(str::to_string);
    let duration_ms = subtitle
        .iter()
        .filter_map(|run| label(run).and_then(duration))
        .next()
        .unwrap_or(0);
    let artist = artists.join(", ");
    Some(YtSearchHit {
        id: id.to_string(),
        title: title(row)?,
        metadata_complete: !artist.is_empty() && duration_ms > 0,
        artist,
        album,
        duration_ms,
        thumbnail_url: thumbnails(row).into_iter().next(),
        url: format!("https://www.youtube.com/watch?v={id}"),
    })
}

fn collection(row: &Value, section: &str) -> Option<YtCollectionHit> {
    let endpoint = row.pointer("/navigationEndpoint/browseEndpoint")?;
    let id = endpoint.get("browseId").and_then(Value::as_str)?;
    let kind = endpoint
        .pointer("/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expected = match section {
        "albums" => "MUSIC_PAGE_TYPE_ALBUM",
        "artists" => "MUSIC_PAGE_TYPE_ARTIST",
        "playlists" => "MUSIC_PAGE_TYPE_PLAYLIST",
        _ => return None,
    };
    if kind != expected {
        return None;
    }
    let title = title(row)?;
    let subtitle = runs(row, 1);
    let uploader = if section == "artists" {
        Some(title.clone())
    } else {
        subtitle
            .iter()
            .find(|run| {
                matches!(
                    page_type(run),
                    Some("MUSIC_PAGE_TYPE_ARTIST" | "MUSIC_PAGE_TYPE_USER_CHANNEL")
                )
            })
            .and_then(|run| label(run))
            .map(str::to_string)
    };
    let count = subtitle.iter().filter_map(|run| label(run)).find_map(|s| {
        let amount = s.strip_suffix(" songs")?.replace(',', "");
        amount.parse().ok()
    });
    let thumbnail_urls = thumbnails(row);
    Some(YtCollectionHit {
        id: id.to_string(),
        url: format!("https://music.youtube.com/browse/{id}"),
        title: Some(title),
        uploader,
        count,
        metadata_complete: true,
        thumbnail_url: thumbnail_urls.first().cloned(),
        thumbnail_urls,
    })
}
