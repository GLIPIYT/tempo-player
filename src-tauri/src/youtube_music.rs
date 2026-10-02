//! Fast search metadata from the public YouTube Music web response.
//! Audio extraction remains yt-dlp's job. Callers fall back to its search if
//! this undocumented response changes or the request fails.
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::ytdlp::{YtCollectionDetail, YtCollectionHit, YtSearchHit};

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

fn collection_cache() -> &'static Mutex<HashMap<String, (Instant, YtCollectionDetail)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, YtCollectionDetail)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Opens an album, artist or playlist from one lightweight WEB_REMIX browse
/// response. yt-dlp remains the caller's fallback if YouTube changes this
/// undocumented response shape.
pub async fn open_collection(url: &str) -> Result<YtCollectionDetail, String> {
    let id = collection_id(url)?;
    if let Some((_, detail)) = collection_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .filter(|(at, _)| at.elapsed() < CACHE_TTL)
    {
        return Ok(detail.clone());
    }

    let mut payload = browse(&id, None).await?;
    let initial_payload = payload.clone();
    let kind = collection_kind(&id, &payload)
        .ok_or_else(|| "YouTube Music collection type changed".to_string())?;
    let mut rows = Vec::new();
    let mut continuation = None;
    append_browse_rows(&payload, kind, &mut rows, &mut continuation)?;

    // Playlist shelves may be paged. Keep the extra work bounded so a huge
    // playlist still opens quickly; albums generally return all tracks at once.
    for _ in 0..2 {
        let Some(token) = continuation.take() else {
            break;
        };
        payload = browse(&id, Some(&token)).await?;
        append_browse_rows(&payload, kind, &mut rows, &mut continuation)?;
    }

    let detail = collection_detail(&id, kind, &initial_payload, rows)?;
    let mut entries = collection_cache().lock().unwrap_or_else(|e| e.into_inner());
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
    entries.insert(id, (Instant::now(), detail.clone()));
    Ok(detail)
}

#[derive(Clone, Copy, PartialEq)]
enum CollectionKind {
    Album,
    Artist,
    Playlist,
}

fn collection_id(url: &str) -> Result<String, String> {
    let url = url.trim();
    let id = if let Some((_, query)) = url.split_once('?') {
        query
            .split('&')
            .find_map(|part| part.strip_prefix("list="))
            .map(|id| id.split('#').next().unwrap_or(id))
            .filter(|id| !id.is_empty())
            .or_else(|| {
                url.split(['?', '#'])
                    .next()
                    .and_then(|path| path.trim_end_matches('/').rsplit('/').next())
            })
    } else {
        url.split(['?', '#'])
            .next()
            .and_then(|path| path.trim_end_matches('/').rsplit('/').next())
    }
    .filter(|id| !id.is_empty())
    .ok_or_else(|| "YouTube Music collection URL is invalid".to_string())?;

    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("YouTube Music collection ID is invalid".into());
    }
    Ok(id.to_string())
}

async fn browse(id: &str, continuation: Option<&str>) -> Result<Value, String> {
    let mut body = json!({
        "context": { "client": {
            "clientName": "WEB_REMIX", "clientVersion": CLIENT_VERSION,
            "hl": "en", "gl": "US"
        }}
    });
    if let Some(token) = continuation {
        body["continuation"] = Value::String(token.to_string());
    } else {
        body["browseId"] = Value::String(id.to_string());
    }

    client()
        .post("https://music.youtube.com/youtubei/v1/browse")
        .query(&[("alt", "json")])
        .header("Origin", "https://music.youtube.com")
        .header("X-Youtube-Client-Name", "67")
        .header("X-Youtube-Client-Version", CLIENT_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("YouTube Music browse: {e}"))?
        .error_for_status()
        .map_err(|e| format!("YouTube Music browse: {e}"))?
        .json()
        .await
        .map_err(|e| format!("YouTube Music browse response: {e}"))
}

fn collection_kind(id: &str, payload: &Value) -> Option<CollectionKind> {
    if payload
        .pointer("/header/musicImmersiveHeaderRenderer")
        .is_some()
        || id.starts_with("UC")
    {
        return Some(CollectionKind::Artist);
    }
    if payload
        .pointer("/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer/contents")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.get("musicPlaylistShelfRenderer").is_some()))
    {
        return Some(CollectionKind::Playlist);
    }
    let og_type = payload
        .pointer("/microformat/microformatDataRenderer/ogType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if id.starts_with("VL")
        || id.starts_with("PL")
        || id.starts_with("RD")
        || id.starts_with("UU")
        || og_type == "music.playlist"
    {
        return Some(CollectionKind::Playlist);
    }
    if id.starts_with("MPRE") || id.starts_with("OLAK") || og_type == "music.album" {
        return Some(CollectionKind::Album);
    }
    if payload
        .pointer("/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer/contents")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.get("musicShelfRenderer").is_some()))
    {
        return Some(CollectionKind::Album);
    }
    None
}

fn shelf_list<'a>(payload: &'a Value, kind: CollectionKind) -> Result<Vec<&'a Value>, String> {
    if let Some(shelf) = payload.pointer("/continuationContents/musicShelfContinuation") {
        return Ok(vec![shelf]);
    }
    if let Some(shelf) = payload.pointer("/continuationContents/musicPlaylistShelfContinuation") {
        return Ok(vec![shelf]);
    }

    let mut sections = Vec::new();
    if let Some(items) = payload
        .pointer("/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer/contents")
        .and_then(Value::as_array)
    {
        sections.extend(items.iter());
    }
    if let Some(tabs) = payload
        .pointer("/contents/singleColumnBrowseResultsRenderer/tabs")
        .and_then(Value::as_array)
    {
        for tab in tabs {
            if let Some(items) = tab
                .pointer("/tabRenderer/content/sectionListRenderer/contents")
                .and_then(Value::as_array)
            {
                sections.extend(items.iter());
            }
        }
    }

    let shelves: Vec<_> = sections
        .into_iter()
        .filter_map(|section| match kind {
            CollectionKind::Playlist => section.get("musicPlaylistShelfRenderer"),
            CollectionKind::Album | CollectionKind::Artist => section.get("musicShelfRenderer"),
        })
        .collect();
    if shelves.is_empty() {
        return Err("YouTube Music collection tracks changed".into());
    }
    Ok(shelves)
}

fn append_browse_rows(
    payload: &Value,
    kind: CollectionKind,
    rows: &mut Vec<Value>,
    continuation: &mut Option<String>,
) -> Result<(), String> {
    let shelves = shelf_list(payload, kind)?;
    for shelf in shelves {
        if let Some(items) = shelf.get("contents").and_then(Value::as_array) {
            for item in items {
                if let Some(row) = item.get("musicResponsiveListItemRenderer") {
                    rows.push(row.clone());
                }
                if let Some(token) = item
                    .pointer(
                        "/continuationItemRenderer/continuationEndpoint/continuationCommand/token",
                    )
                    .and_then(Value::as_str)
                {
                    *continuation = Some(token.to_string());
                }
            }
        }
        *continuation = shelf
            .pointer("/continuations/0/nextContinuationData/continuation")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| continuation.take());
    }
    if continuation.is_none() {
        *continuation = payload
            .pointer("/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer/continuations/0/nextContinuationData/continuation")
            .or_else(|| {
                payload.pointer(
                    "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/continuations/0/nextContinuationData/continuation",
                )
            })
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    Ok(())
}

fn collection_detail(
    id: &str,
    kind: CollectionKind,
    payload: &Value,
    rows: Vec<Value>,
) -> Result<YtCollectionDetail, String> {
    let micro = payload
        .pointer("/microformat/microformatDataRenderer")
        .unwrap_or(&Value::Null);
    let immersive = payload
        .pointer("/header/musicImmersiveHeaderRenderer")
        .unwrap_or(&Value::Null);
    let responsive_header = payload
        .pointer("/header/musicResponsiveHeaderRenderer")
        .unwrap_or(&Value::Null);
    let artist_name =
        run_text(immersive.get("title")).or_else(|| run_text(responsive_header.get("title")));
    let raw_title = artist_name
        .clone()
        .or_else(|| {
            micro
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| run_text(responsive_header.get("title")));
    let raw_title = raw_title.filter(|title| !title.trim().is_empty());
    let title = raw_title.map(|title| match kind {
        CollectionKind::Album if !title.starts_with("Album - ") => format!("Album - {title}"),
        _ => title,
    });
    let uploader = match kind {
        CollectionKind::Artist => artist_name.or_else(|| title.clone()),
        CollectionKind::Album => micro
            .get("description")
            .and_then(Value::as_str)
            .and_then(|description| metadata_owner(description, "Album"))
            .or_else(|| run_text(responsive_header.get("straplineTextOne"))),
        CollectionKind::Playlist => micro
            .get("description")
            .and_then(Value::as_str)
            .and_then(|description| metadata_owner(description, "Playlist"))
            .or_else(|| run_text(responsive_header.get("straplineTextOne"))),
    };
    let default_artist = match kind {
        CollectionKind::Album => uploader.as_deref(),
        CollectionKind::Artist => title.as_deref(),
        CollectionKind::Playlist => None,
    };
    let default_album = (kind == CollectionKind::Album).then(|| {
        title
            .as_deref()
            .unwrap_or_default()
            .trim_start_matches("Album - ")
    });
    let mut seen = HashSet::new();
    let tracks: Vec<YtSearchHit> = rows
        .iter()
        .filter_map(|row| collection_track(row, default_artist, default_album))
        .filter(|hit| seen.insert(hit.id.clone()))
        .collect();
    if tracks.is_empty() {
        return Err("YouTube Music collection returned no track rows".into());
    }

    let mut thumbnail_urls = response_thumbnails(micro.get("thumbnail"));
    thumbnail_urls.extend(response_thumbnails(immersive.get("thumbnail")));
    thumbnail_urls.extend(response_thumbnails(responsive_header.get("thumbnail")));
    thumbnail_urls.dedup();
    let thumbnail_url = thumbnail_urls.first().cloned();
    Ok(YtCollectionDetail {
        id: id.to_string(),
        title,
        uploader,
        count: Some(tracks.len() as i64),
        thumbnail_url,
        thumbnail_urls,
        tracks,
    })
}

fn run_text(value: Option<&Value>) -> Option<String> {
    value?
        .get("runs")?
        .as_array()?
        .iter()
        .filter_map(|run| run.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .reduce(|mut left, right| {
            left.push_str(&right);
            left
        })
}

fn metadata_owner(description: &str, kind: &str) -> Option<String> {
    let (index, separator) = ['·', '•', '–', '—', '-']
        .into_iter()
        .find_map(|separator| description.find(separator).map(|index| (index, separator)))?;
    let label = &description[..index];
    let value = &description[index + separator.len_utf8()..];
    if !label.trim().eq_ignore_ascii_case(kind) {
        return None;
    }
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn response_thumbnails(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|value| value.get("thumbnails"))
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

fn collection_track(
    row: &Value,
    default_artist: Option<&str>,
    default_album: Option<&str>,
) -> Option<YtSearchHit> {
    if row
        .get("musicItemRendererDisplayPolicy")
        .and_then(Value::as_str)
        == Some("MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT")
    {
        return None;
    }
    let id = row
        .pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId")
        .or_else(|| row.pointer("/playlistItemData/videoId"))
        .or_else(|| row.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint/videoId"))
        .and_then(Value::as_str)?;
    let columns = row.get("flexColumns").and_then(Value::as_array);
    let row_runs = columns
        .into_iter()
        .flatten()
        .filter_map(|column| column.pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs"))
        .filter_map(Value::as_array)
        .flatten()
        .collect::<Vec<_>>();
    let artists = row_runs
        .iter()
        .filter(|run| page_type(run) == Some("MUSIC_PAGE_TYPE_ARTIST"))
        .filter_map(|run| label(run))
        .collect::<Vec<_>>();
    let artist = if artists.is_empty() {
        let second_column = runs(row, 1)
            .into_iter()
            .filter_map(label)
            .find(|text| duration(text).is_none() && !is_play_count(text));
        default_artist
            .or(second_column)
            .unwrap_or_default()
            .to_string()
    } else {
        artists.join(", ")
    };
    let album = row_runs
        .iter()
        .find(|run| page_type(run) == Some("MUSIC_PAGE_TYPE_ALBUM"))
        .and_then(|run| label(run))
        .map(str::to_string)
        .or_else(|| default_album.map(str::to_string));
    let duration_ms = row_runs
        .iter()
        .filter_map(|run| label(run).and_then(duration))
        .chain(
            row.get("fixedColumns")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|column| {
                    column.pointer("/musicResponsiveListItemFixedColumnRenderer/text/runs")
                })
                .filter_map(Value::as_array)
                .flatten()
                .filter_map(|run| run.get("text").and_then(Value::as_str).and_then(duration)),
        )
        .next()
        .unwrap_or(0);
    let thumbnail_url = thumbnails(row)
        .into_iter()
        .next()
        .or_else(|| Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg")));
    Some(YtSearchHit {
        id: id.to_string(),
        title: title(row)?,
        artist: artist.clone(),
        album,
        metadata_complete: !artist.is_empty() && duration_ms > 0,
        duration_ms,
        thumbnail_url,
        url: format!("https://www.youtube.com/watch?v={id}"),
    })
}

fn is_play_count(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.contains(" play") || text.contains(" view") || text.contains(" subscriber")
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
