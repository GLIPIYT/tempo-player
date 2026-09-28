//! Public Pinterest search uses a fresh anonymous website session, never an
//! account cookie or an OAuth token. This is an unofficial, changeable API.

use crate::background_search::{
    fits, result_limit, BackgroundImageResult, BackgroundSearchFilters, BackgroundSearchPage,
};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const SESSION_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_SESSIONS: usize = 8;
const MAX_PAGES: u32 = 10;
const MAX_RAW_PAGE_RESULTS: usize = 100;
const WEBSITE_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(1);
static SESSIONS: OnceLock<Mutex<HashMap<String, GuestSession>>> = OnceLock::new();

#[derive(Clone)]
struct GuestSession {
    client: Client,
    generation: u64,
    created_at: Instant,
    // The first page starts without a bookmark. Each successful page records
    // only the server's next bookmark, so a later request cannot invent one.
    bookmarks: Vec<Option<String>>,
    pages: Vec<Vec<BackgroundImageResult>>,
}

fn sessions() -> &'static Mutex<HashMap<String, GuestSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) async fn search(
    query: &str,
    filters: &BackgroundSearchFilters,
) -> Result<BackgroundSearchPage, String> {
    if filters.page == 0 || filters.page > MAX_PAGES {
        return Err("Pinterest supports up to 10 pages per search".into());
    }
    let effective_query = search_phrase(query, filters);
    let key = json!([
        effective_query,
        filters.min_width,
        filters.min_height,
        filters.orientation,
        result_limit(filters)
    ])
    .to_string();
    let cached = {
        let mut cache = sessions()
            .lock()
            .map_err(|_| "Could not access the Pinterest search session".to_string())?;
        cache.retain(|_, session| session.created_at.elapsed() < SESSION_TTL);
        cache.get(&key).cloned()
    };
    let session = if let Some(session) = cached {
        session
    } else {
        if filters.page != 1 {
            return Err("The Pinterest search session expired. Start the search again".into());
        }
        let session = prepare_guest_session(&effective_query).await?;
        let mut cache = sessions()
            .lock()
            .map_err(|_| "Could not access the Pinterest search session".to_string())?;
        if let Some(existing) = cache.get(&key) {
            existing.clone()
        } else {
            if cache.len() >= MAX_SESSIONS {
                if let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, session)| session.created_at)
                    .map(|(key, _)| key.clone())
                {
                    cache.remove(&oldest);
                }
            }
            cache.insert(key.clone(), session.clone());
            session
        }
    };
    let page_index = (filters.page - 1) as usize;
    if let Some(page) = cached_page(&session, filters.page) {
        return Ok(page);
    }
    let Some(bookmark) = session.bookmarks.get(page_index) else {
        return Err("Load Pinterest search pages in order".into());
    };
    if page_index > 0 && bookmark.is_none() {
        return Ok(BackgroundSearchPage {
            images: Vec::new(),
            page: filters.page,
            has_more: false,
        });
    }

    let fetched = fetch_page(&session, &effective_query, filters, bookmark.as_deref()).await;
    let (results, next_bookmark) = match fetched {
        Ok(page) => page,
        Err(error) => {
            // An auth denial, changed schema, or failed request must not poison
            // Retry with the same stale guest cookie jar. Preserve a newer
            // session if another request has already replaced this one.
            if let Ok(mut cache) = sessions().lock() {
                if cache
                    .get(&key)
                    .is_some_and(|current| current.generation == session.generation)
                {
                    cache.remove(&key);
                }
            }
            return Err(error);
        }
    };
    let mut cache = sessions()
        .lock()
        .map_err(|_| "Could not access the Pinterest search session".to_string())?;
    let current = cache.get_mut(&key).ok_or_else(|| {
        "The Pinterest search session expired. Start the search again".to_string()
    })?;
    store_page(
        current,
        session.generation,
        filters.page,
        results,
        next_bookmark,
    )
}

async fn fetch_page(
    session: &GuestSession,
    effective_query: &str,
    filters: &BackgroundSearchFilters,
    bookmark: Option<&str>,
) -> Result<(Vec<BackgroundImageResult>, Option<String>), String> {
    let source_url = search_url(effective_query)?;
    let source_path = format!("{}?{}", source_url.path(), source_url.query().unwrap_or(""));
    let mut options = json!({
        "query": effective_query,
        "scope": "pins",
        "rs": "typed",
        "field_set_key": "unauth_search",
        "bookmarks": [],
        "page_size": result_limit(filters),
        "no_fetch_context_on_resource": false
    });
    if let Some(bookmark) = bookmark {
        options["bookmarks"] = json!([bookmark]);
    }
    let data = json!({"options": options, "context": {}}).to_string();
    let response = session
        .client
        .get("https://www.pinterest.com/resource/BaseSearchResource/get/")
        .query(&[
            ("source_url", source_path.as_str()),
            ("data", data.as_str()),
        ])
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::REFERER, source_url.as_str())
        .header("X-Requested-With", "XMLHttpRequest")
        .header("X-Pinterest-AppState", "active")
        .header("X-Pinterest-PWS-Handler", "www/search/[scope].js")
        .header("X-Pinterest-Source-Url", &source_path)
        .send()
        .await
        .map_err(|_| "Could not reach Pinterest search. Try again later".to_string())?;
    let bytes = bounded_response(response).await?;
    let response: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Pinterest returned an unsupported search response".to_string())?;
    parse_search_response(&response, filters)
}

fn parse_search_response(
    response: &Value,
    filters: &BackgroundSearchFilters,
) -> Result<(Vec<BackgroundImageResult>, Option<String>), String> {
    let resource = &response["resource_response"];
    if resource["status"].as_str() != Some("success") {
        return Err("Pinterest guest search is unavailable. Try again later".into());
    }
    let pins = resource["data"]["results"]
        .as_array()
        .or_else(|| resource["data"].as_array())
        .ok_or_else(|| "Pinterest changed its guest search format".to_string())?;
    if pins.len() > MAX_RAW_PAGE_RESULTS {
        return Err("Pinterest returned too many results in one search page".into());
    }
    // page_size is only a server hint. Returning a truncated page would lose
    // every omitted Pin because its cursor starts after the entire raw page.
    let results = pins
        .iter()
        .filter_map(|pin| parse_pin(pin, filters))
        .collect::<Vec<_>>();
    Ok((results, next_bookmark(&resource["bookmark"])?))
}

fn next_bookmark(value: &Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) if value.is_empty() || value == "-end-" => Ok(None),
        Value::String(value) if value.len() <= 16_384 && !value.chars().any(char::is_control) => {
            Ok(Some(value.clone()))
        }
        _ => Err("Pinterest returned an unsupported pagination cursor".into()),
    }
}

fn cached_page(session: &GuestSession, page: u32) -> Option<BackgroundSearchPage> {
    let page_index = page.checked_sub(1)? as usize;
    Some(BackgroundSearchPage {
        images: session.pages.get(page_index)?.clone(),
        page,
        has_more: page < MAX_PAGES
            && session
                .bookmarks
                .get(page_index + 1)
                .is_some_and(Option::is_some),
    })
}

fn store_page(
    session: &mut GuestSession,
    generation: u64,
    page: u32,
    images: Vec<BackgroundImageResult>,
    next_bookmark: Option<String>,
) -> Result<BackgroundSearchPage, String> {
    if session.generation != generation {
        return Err("The Pinterest search session expired. Start the search again".into());
    }
    // Concurrent requests for the same page return the cache winner together
    // with that winner's bookmark. Images and cursor always belong together.
    if let Some(canonical) = cached_page(session, page) {
        return Ok(canonical);
    }
    let page_index = page
        .checked_sub(1)
        .ok_or_else(|| "Invalid Pinterest page".to_string())? as usize;
    if session.pages.len() != page_index || session.bookmarks.len() != page_index + 1 {
        return Err("Load Pinterest search pages in order".into());
    }
    session.pages.push(images);
    session.bookmarks.push(next_bookmark);
    cached_page(session, page).ok_or_else(|| "Could not cache the Pinterest page".into())
}

async fn prepare_guest_session(query: &str) -> Result<GuestSession, String> {
    let client = Client::builder()
        .user_agent(WEBSITE_AGENT)
        .cookie_store(true)
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || !is_pinterest_url(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "Could not prepare Pinterest guest search".to_string())?;
    let response = client
        .get(search_url(query)?)
        .header(reqwest::header::ACCEPT, "text/html")
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|_| "Could not reach Pinterest search. Try again later".to_string())?;
    // Consume the bounded public shell response; cookies come only from this
    // guest request and remain in this session's in-memory cookie jar.
    bounded_response(response).await?;
    Ok(GuestSession {
        client,
        generation: SESSION_GENERATION.fetch_add(1, Ordering::Relaxed),
        created_at: Instant::now(),
        bookmarks: vec![None],
        pages: Vec::new(),
    })
}

fn search_url(query: &str) -> Result<Url, String> {
    let mut url = Url::parse("https://www.pinterest.com/search/pins/")
        .map_err(|_| "Invalid Pinterest search URL".to_string())?;
    url.query_pairs_mut().append_pair("q", query);
    Ok(url)
}

fn is_pinterest_url(url: &Url) -> bool {
    url.scheme() == "https"
        && matches!(url.host_str(), Some("www.pinterest.com" | "pinterest.com"))
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

async fn bounded_response(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if !is_pinterest_url(response.url()) {
        return Err("Pinterest redirected outside its search website".into());
    }
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "Pinterest guest search is unavailable. Try again later".into(),
            429 => "Pinterest search is temporarily rate limited. Try again later".into(),
            _ => "Pinterest search is temporarily unavailable".into(),
        });
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Pinterest returned an oversized search response".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read Pinterest search results".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("Pinterest returned an oversized search response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn pin_image(value: &Value) -> Option<(String, u32, u32)> {
    let url = Url::parse(value["url"].as_str()?).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("i.pinimg.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path().rsplit('.').next()?, "jpg" | "jpeg" | "png")
    {
        return None;
    }
    let width = u32::try_from(value["width"].as_u64()?).ok()?;
    let height = u32::try_from(value["height"].as_u64()?).ok()?;
    if width == 0 || height == 0 || width > 16_000 || height > 16_000 {
        return None;
    }
    Some((url.to_string(), width, height))
}

fn parse_pin(pin: &Value, filters: &BackgroundSearchFilters) -> Option<BackgroundImageResult> {
    if pin["type"].as_str() != Some("pin") || pin["is_promoted"].as_bool() == Some(true) {
        return None;
    }
    let id = pin["id"].as_str()?;
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let images = &pin["images"];
    let (image_url, width, height) =
        pin_image(&images["orig"]).or_else(|| pin_image(&images["736x"]))?;
    if !fits(width, height, filters) {
        return None;
    }
    let preview_url = pin_image(&images["474x"])
        .or_else(|| pin_image(&images["736x"]))
        .map(|(url, _, _)| url)
        .unwrap_or_else(|| image_url.clone());
    let title = ["title", "grid_title", "seo_alt_text", "auto_alt_text"]
        .iter()
        .filter_map(|key| pin[*key].as_str())
        .find(|value| !value.trim().is_empty())
        .map(clean_text)
        .unwrap_or_else(|| "Pinterest".into());
    let author = pin["pinner"]["full_name"]
        .as_str()
        .or_else(|| pin["pinner"]["username"].as_str())
        .filter(|value| !value.trim().is_empty())
        .map(clean_text);
    Some(BackgroundImageResult {
        id: format!("pinterest:{id}"),
        provider: "pinterest".into(),
        title,
        preview_url,
        image_url,
        source_url: format!("https://www.pinterest.com/pin/{id}/"),
        author,
        license: None,
        license_url: None,
        width,
        height,
    })
}

fn clean_text(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(240)
        .collect::<String>()
        .trim()
        .into()
}

fn search_phrase(query: &str, filters: &BackgroundSearchFilters) -> String {
    let mut phrase = query.trim().to_string();
    if !phrase.to_ascii_lowercase().contains("wallpaper") && !phrase.contains("обои") {
        phrase.push_str(" wallpaper");
    }
    // Pinterest does not expose Wallhaven's category/color API filters. These
    // are semantic search terms; only dimensions/orientation are exact filters.
    match filters.category.as_str() {
        "anime" => phrase.push_str(" anime"),
        "people" => phrase.push_str(" people"),
        _ => {}
    }
    if let Some(color) = filters.color.as_deref().and_then(color_name) {
        phrase.push(' ');
        phrase.push_str(color);
    }
    phrase
}

fn color_name(value: &str) -> Option<&'static str> {
    let value = value.trim_start_matches('#');
    if value.len() != 6 {
        return None;
    }
    let rgb = u32::from_str_radix(value, 16).ok()?;
    let r = ((rgb >> 16) & 255) as f64 / 255.0;
    let g = ((rgb >> 8) & 255) as f64 / 255.0;
    let b = (rgb & 255) as f64 / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    if max < 0.14 {
        return Some("black");
    }
    if max - min < 0.12 {
        return Some(if min > 0.85 { "white" } else { "gray" });
    }
    let delta = max - min;
    let hue = if max == r {
        60.0 * ((g - b) / delta).rem_euclid(6.0)
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };
    Some(match hue as u32 {
        0..=18 | 345..=360 => "red",
        19..=44 => {
            if max < 0.65 {
                "brown"
            } else {
                "orange"
            }
        }
        45..=68 => "yellow",
        69..=164 => "green",
        165..=199 => "cyan",
        200..=254 => "blue",
        255..=295 => "purple",
        _ => "pink",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public_pin() -> Value {
        json!({
            "id": "863565297345272119",
            "type": "pin",
            "title": "Landscape",
            "images": {
                "orig": {
                    "url": "https://i.pinimg.com/originals/38/2e/12/example.png",
                    "width": 1672,
                    "height": 941
                },
                "474x": {
                    "url": "https://i.pinimg.com/474x/38/2e/12/example.jpg",
                    "width": 474,
                    "height": 266
                }
            }
        })
    }

    fn guest_session() -> GuestSession {
        GuestSession {
            client: Client::new(),
            generation: 7,
            created_at: Instant::now(),
            bookmarks: vec![None],
            pages: Vec::new(),
        }
    }

    #[test]
    fn retains_actual_original_dimensions_and_thumbnail() {
        let pin = parse_pin(&public_pin(), &BackgroundSearchFilters::default()).unwrap();
        assert_eq!((pin.width, pin.height), (1672, 941));
        assert!(pin.image_url.contains("/originals/"));
        assert!(pin.preview_url.contains("/474x/"));
        assert_eq!(
            pin.source_url,
            "https://www.pinterest.com/pin/863565297345272119/"
        );
    }

    #[test]
    fn rejects_non_provider_media_urls_and_malformed_ids() {
        for unsafe_url in [
            "https://i.pinimg.com.example.org/image.png",
            "http://i.pinimg.com/image.png",
            "https://user:password@i.pinimg.com/image.png",
            "https://127.0.0.1/image.png",
            "https://i.pinimg.com/image.mp4",
        ] {
            let mut pin = public_pin();
            pin["images"]["orig"]["url"] = json!(unsafe_url);
            assert!(parse_pin(&pin, &BackgroundSearchFilters::default()).is_none());
        }
        let mut pin = public_pin();
        pin["id"] = json!("../../unexpected");
        assert!(parse_pin(&pin, &BackgroundSearchFilters::default()).is_none());
    }

    #[test]
    fn rejects_wrong_orientation_and_promoted_results() {
        let mut filters = BackgroundSearchFilters::default();
        filters.orientation = "portrait".into();
        assert!(parse_pin(&public_pin(), &filters).is_none());
        let mut pin = public_pin();
        pin["is_promoted"] = json!(true);
        assert!(parse_pin(&pin, &BackgroundSearchFilters::default()).is_none());
    }

    #[test]
    fn preserves_server_results_beyond_requested_page_size() {
        let mut filters = BackgroundSearchFilters::default();
        filters.limit = 24;
        let response = json!({
            "resource_response": {
                "status": "success",
                "data": {"results": vec![public_pin(); 25]},
                "bookmark": "next-page"
            }
        });
        let (images, cursor) = parse_search_response(&response, &filters).unwrap();
        assert_eq!(images.len(), 25);
        assert_eq!(cursor.as_deref(), Some("next-page"));
    }

    #[test]
    fn filtered_empty_page_keeps_next_page_available() {
        let mut session = guest_session();
        let page = store_page(&mut session, 7, 1, Vec::new(), Some("next-page".into())).unwrap();
        assert!(page.images.is_empty());
        assert!(page.has_more);
        assert_eq!(page.page, 1);
        assert!(cached_page(&session, 1).unwrap().has_more);
    }

    #[test]
    fn concurrent_page_loser_returns_canonical_images_and_cursor() {
        let mut session = guest_session();
        let mut winner = parse_pin(&public_pin(), &BackgroundSearchFilters::default()).unwrap();
        winner.title = "Winner".into();
        let first = store_page(&mut session, 7, 1, vec![winner], None).unwrap();
        let loser = parse_pin(&public_pin(), &BackgroundSearchFilters::default()).unwrap();
        let second =
            store_page(&mut session, 7, 1, vec![loser], Some("loser-cursor".into())).unwrap();
        assert_eq!(second.images[0].title, first.images[0].title);
        assert_eq!(second.images[0].title, "Winner");
        assert!(!second.has_more);
        assert_eq!(session.bookmarks[1], None);
    }

    #[test]
    fn pagination_stops_at_cap_and_rejects_stale_generation() {
        let mut session = guest_session();
        session.pages = vec![Vec::new(); 9];
        session.bookmarks = vec![None; 10];
        let page = store_page(&mut session, 7, 10, Vec::new(), Some("next-page".into())).unwrap();
        assert!(!page.has_more);
        assert!(store_page(&mut session, 8, 1, Vec::new(), None).is_err());
        assert_eq!(session.pages.len(), 10);
    }

    #[test]
    fn validates_next_cursor_and_distinguishes_end_of_search() {
        for end in [Value::Null, json!(""), json!("-end-")] {
            assert_eq!(next_bookmark(&end).unwrap(), None);
        }
        assert_eq!(
            next_bookmark(&json!("valid-cursor")).unwrap().as_deref(),
            Some("valid-cursor")
        );
        for invalid in [json!([]), json!("bad\ncursor"), json!("x".repeat(16_385))] {
            assert!(next_bookmark(&invalid).is_err());
        }
    }
}
