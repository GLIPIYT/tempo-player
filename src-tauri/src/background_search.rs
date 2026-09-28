use base64::Engine;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::State;

use crate::commands::AppState;

const WALLHAVEN_API: &str = "https://wallhaven.cc/api/v1/search";
const KONACHAN_API: &str = "https://konachan.net/post.json";
const MAX_RESULTS: usize = 40;
const MAX_SEARCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 3 * 1024 * 1024;
const MAX_BACKGROUND_BYTES: usize = 25 * 1024 * 1024;
const MAX_DECODED_DIMENSION: u32 = 8192;
const MAX_BACKGROUND_DIMENSION: u32 = 2560;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
static IMAGE_JOBS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

fn image_jobs() -> &'static Arc<tokio::sync::Semaphore> {
    IMAGE_JOBS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(3)))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImageResult {
    pub id: String,
    pub provider: String,
    pub title: String,
    pub preview_url: String,
    pub image_url: String,
    pub source_url: String,
    pub author: Option<String>,
    pub license: Option<String>,
    pub license_url: Option<String>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSearchPage {
    pub images: Vec<BackgroundImageResult>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackgroundSearchFilters {
    pub min_width: u32,
    pub min_height: u32,
    /// `landscape`, `portrait`, `square`, or `any`.
    pub orientation: String,
    pub limit: usize,
    /// `all`, `anime`, `general`, or `people` (Wallhaven).
    pub category: String,
    pub color: Option<String>,
    pub include_nsfw: bool,
    pub page: u32,
}

impl Default for BackgroundSearchFilters {
    fn default() -> Self {
        Self {
            min_width: 1280,
            min_height: 720,
            orientation: "landscape".into(),
            limit: 30,
            category: "all".into(),
            color: None,
            include_nsfw: false,
            page: 1,
        }
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!(
            "Tempo/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/GLIPIYT/tempo-player)"
        ))
        .timeout(std::time::Duration::from_secs(12))
        // The API key must never follow an API redirect to a different host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not prepare image search: {}", error.without_url()))
}

pub(crate) fn result_limit(filters: &BackgroundSearchFilters) -> usize {
    filters.limit.clamp(1, MAX_RESULTS)
}

fn dimension(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|value| u32::try_from(value).ok())
}

fn validate(query: &str, filters: &BackgroundSearchFilters) -> Result<(), String> {
    if query.chars().count() > 120 {
        return Err("Search phrase is too long".into());
    }
    if !matches!(
        filters.orientation.as_str(),
        "landscape" | "portrait" | "square" | "any"
    ) {
        return Err("Unsupported image orientation".into());
    }
    if filters.min_width > 16_000 || filters.min_height > 16_000 {
        return Err("Minimum image dimensions are too large".into());
    }
    if !matches!(
        filters.category.as_str(),
        "all" | "anime" | "general" | "people"
    ) {
        return Err("Unsupported wallpaper category".into());
    }
    if let Some(color) = &filters.color {
        if color.len() != 6 || !color.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err("Invalid wallpaper color".into());
        }
    }
    if !(1..=10_000).contains(&filters.page) {
        return Err("Invalid wallpaper page".into());
    }
    Ok(())
}

pub(crate) fn fits(width: u32, height: u32, filters: &BackgroundSearchFilters) -> bool {
    if width < filters.min_width || height < filters.min_height || height == 0 || width == 0 {
        return false;
    }
    match filters.orientation.as_str() {
        "landscape" => width > height,
        "portrait" => height > width,
        "square" => width == height,
        _ => true,
    }
}

fn clean_external_text(value: &str) -> String {
    let mut plain = String::with_capacity(value.len());
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => plain.push(ch),
            _ => {}
        }
    }
    plain
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .trim()
        .to_string()
}

fn wallhaven_api_key() -> Option<String> {
    std::env::var("WALLHAVEN_API_KEY")
        .ok()
        .or_else(|| option_env!("TEMPO_WALLHAVEN_API_KEY").map(str::to_owned))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_alphanumeric()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundProviderStatus {
    pub id: String,
    pub available: bool,
    pub supports_categories: bool,
    pub supports_color: bool,
    pub supports_nsfw: bool,
    pub notice: Option<String>,
}

#[tauri::command]
pub fn get_background_provider_status() -> Vec<BackgroundProviderStatus> {
    vec![
        BackgroundProviderStatus {
            id: "wallhaven".into(),
            available: true,
            supports_categories: true,
            supports_color: true,
            supports_nsfw: wallhaven_api_key().is_some(),
            notice: None,
        },
        BackgroundProviderStatus {
            id: "pinterest".into(),
            available: true,
            supports_categories: false,
            supports_color: false,
            supports_nsfw: false,
            notice: None,
        },
        BackgroundProviderStatus {
            id: "konachan".into(),
            available: true,
            supports_categories: false,
            supports_color: false,
            supports_nsfw: false,
            notice: None,
        },
    ]
}

#[tauri::command]
pub async fn search_backgrounds(
    provider: String,
    query: String,
    filters: BackgroundSearchFilters,
) -> Result<BackgroundSearchPage, String> {
    validate(&query, &filters)?;
    let client = client()?;
    match provider.as_str() {
        "wallhaven" => search_wallhaven(&client, &query, &filters).await,
        "konachan" => search_konachan(&client, &query, &filters).await,
        "pinterest" => crate::pinterest_backgrounds::search(&query, &filters).await,
        _ => Err("Unsupported image source".into()),
    }
}

/// Download a chosen search result into Tempo's private background directory.
/// The renderer only provides a result URL; the provider and path are checked
/// again here so this command cannot be used as an arbitrary URL downloader.
#[tauri::command]
pub async fn save_selected_background(
    state: State<'_, AppState>,
    provider: String,
    image_url: String,
) -> Result<String, String> {
    let permit = image_jobs()
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Image processing is unavailable".to_owned())?;
    let (content_type, bytes) = fetch_image(&provider, &image_url, MAX_BACKGROUND_BYTES).await?;
    let (extension, bytes) = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        decode_and_sanitize_image(&content_type, &bytes)
    })
    .await
    .map_err(|_| "The selected image could not be processed".to_owned())??;
    save_background_bytes(&state, extension, bytes)
}

#[tauri::command]
pub async fn get_background_preview(provider: String, image_url: String) -> Result<String, String> {
    let permit = image_jobs()
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Image preview processing is unavailable".to_owned())?;
    let (content_type, bytes) = fetch_image(&provider, &image_url, MAX_PREVIEW_BYTES).await?;
    tokio::task::spawn_blocking(move || {
        // The owned permit lives through decoding even if the caller cancels.
        let _permit = permit;
        let (extension, bytes) = decode_and_sanitize_image_at_size(&content_type, &bytes, 720)?;
        if bytes.len() > MAX_PREVIEW_BYTES {
            return Err("The image preview is too large".into());
        }
        let mime = if extension == "jpg" {
            "image/jpeg"
        } else {
            "image/png"
        };
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .map_err(|_| "The image preview could not be processed".to_owned())?
}

async fn fetch_image(
    provider: &str,
    image_url: &str,
    max_bytes: usize,
) -> Result<(String, Vec<u8>), String> {
    let requested_url = allowed_image_url(&provider, &image_url)?;
    let mut response = download_client(provider.to_owned())?
        .get(requested_url)
        .send()
        .await
        .map_err(|error| {
            format!(
                "Could not download the selected image: {}",
                error.without_url()
            )
        })?
        .error_for_status()
        .map_err(|error| {
            format!(
                "Could not download the selected image: {}",
                error.without_url()
            )
        })?;
    allowed_image_url(&provider, response.url().as_str())?;

    if let Some(length) = response.content_length() {
        if length > max_bytes as u64 {
            return Err("The selected image is too large".into());
        }
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(content_type.as_str(), "image/jpeg" | "image/png") {
        return Err("The image source returned an unsupported file type".into());
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read the selected image: {}", error.without_url()))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("The selected image is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((content_type, bytes))
}

fn save_background_bytes(
    state: &AppState,
    extension: &str,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let digest = Sha256::digest(&bytes);
    let file_name = format!("{}.{}", hex_digest(&digest), extension);
    let destination = state.backgrounds_dir.join(file_name);
    if destination.is_file() {
        return Ok(destination.to_string_lossy().into_owned());
    }

    std::fs::create_dir_all(&state.backgrounds_dir)
        .map_err(|error| format!("Could not prepare Tempo's background folder: {error}"))?;
    let mut temporary_and_file = None;
    for _ in 0..8 {
        let nonce = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary = state.backgrounds_dir.join(format!(
            ".{}.{}.{}.part",
            std::process::id(),
            nonce,
            hex_digest(&digest)
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => {
                temporary_and_file = Some((temporary, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("Could not prepare the selected image: {error}"));
            }
        }
    }
    let Some((temporary, mut file)) = temporary_and_file else {
        return Err("Could not allocate a temporary image file".into());
    };
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Could not save the selected image: {error}"));
    }
    drop(file);
    match std::fs::rename(&temporary, &destination) {
        Ok(()) => {}
        Err(error) if destination.is_file() => {
            let _ = std::fs::remove_file(&temporary);
            let _ = error;
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!(
                "Could not finish saving the selected image: {error}"
            ));
        }
    }
    Ok(destination.to_string_lossy().into_owned())
}

fn allowed_image_url(provider: &str, value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid image URL".to_string())?;
    let host = url.host_str().unwrap_or_default();
    let allowed = match provider {
        "commons" => {
            host == "upload.wikimedia.org" && url.path().starts_with("/wikipedia/commons/")
        }
        "artic" => host == "www.artic.edu" && url.path().starts_with("/iiif/2/"),
        "wallhaven" => {
            (host == "w.wallhaven.cc" && url.path().starts_with("/full/"))
                || (host == "th.wallhaven.cc"
                    && ["/lg/", "/orig/", "/small/"]
                        .iter()
                        .any(|prefix| url.path().starts_with(prefix)))
        }
        "konachan" => {
            host == "konachan.net"
                && ["/image/", "/jpeg/", "/sample/", "/data/preview/"]
                    .iter()
                    .any(|prefix| url.path().starts_with(prefix))
        }
        "pinterest" => host == "i.pinimg.com",
        _ => false,
    };
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !allowed
        || url.username() != ""
        || url.password().is_some()
    {
        return Err("Image URL is outside the selected image provider".into());
    }
    Ok(url)
}

fn download_client(provider: String) -> Result<reqwest::Client, String> {
    let referer = match provider.as_str() {
        "wallhaven" => Some("https://wallhaven.cc/"),
        "konachan" => Some("https://konachan.net/"),
        "pinterest" => Some("https://www.pinterest.com/"),
        _ => None,
    };
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(referer) = referer {
        headers.insert(
            reqwest::header::REFERER,
            reqwest::header::HeaderValue::from_static(referer),
        );
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .user_agent(concat!(
            "Tempo/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/GLIPIYT/tempo-player)"
        ))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5
                || allowed_image_url(&provider, attempt.url().as_str()).is_err()
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| {
            format!(
                "Could not prepare the image download: {}",
                error.without_url()
            )
        })
}

fn decode_and_sanitize_image(
    content_type: &str,
    bytes: &[u8],
) -> Result<(&'static str, Vec<u8>), String> {
    decode_and_sanitize_image_at_size(content_type, bytes, MAX_BACKGROUND_DIMENSION)
}

fn decode_and_sanitize_image_at_size(
    content_type: &str,
    bytes: &[u8],
    max_dimension: u32,
) -> Result<(&'static str, Vec<u8>), String> {
    let expected_format = match content_type {
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/png" => image::ImageFormat::Png,
        _ => return Err("The image source returned an unsupported file type".into()),
    };
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("The image data could not be read: {error}"))?;
    if reader.format() != Some(expected_format) {
        return Err("The image data does not match its file type".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODED_DIMENSION);
    limits.max_image_height = Some(MAX_DECODED_DIMENSION);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|error| format!("The image could not be decoded safely: {error}"))?;
    let resized = decoded.thumbnail(max_dimension, max_dimension);
    let mut output = Cursor::new(Vec::new());
    resized
        .write_to(&mut output, expected_format)
        .map_err(|error| format!("The image could not be prepared for Tempo: {error}"))?;
    Ok((
        if expected_format == image::ImageFormat::Jpeg {
            "jpg"
        } else {
            "png"
        },
        output.into_inner(),
    ))
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn wallhaven_parameters(
    query: &str,
    filters: &BackgroundSearchFilters,
) -> Vec<(&'static str, String)> {
    let categories = match filters.category.as_str() {
        "general" => "100",
        "anime" => "010",
        "people" => "001",
        _ => "111",
    };
    let mut params = vec![
        ("q", query.trim().to_owned()),
        ("categories", categories.into()),
        (
            "purity",
            if filters.include_nsfw { "111" } else { "100" }.into(),
        ),
        ("page", filters.page.to_string()),
        (
            "sorting",
            if query.trim().is_empty() {
                "date_added"
            } else {
                "relevance"
            }
            .into(),
        ),
        ("order", "desc".into()),
    ];
    if filters.min_width > 0 || filters.min_height > 0 {
        params.push((
            "atleast",
            format!("{}x{}", filters.min_width.max(1), filters.min_height.max(1)),
        ));
    }
    if let Some(color) = &filters.color {
        params.push(("colors", color.to_ascii_lowercase()));
    }
    match filters.orientation.as_str() {
        "landscape" => params.push(("ratios", "landscape".into())),
        "portrait" => params.push(("ratios", "portrait".into())),
        "square" => params.push(("ratios", "1x1".into())),
        _ => {}
    }
    params
}

fn provider_http_error(provider: &str, error: reqwest::Error) -> String {
    match error.status() {
        Some(reqwest::StatusCode::UNAUTHORIZED) => {
            format!("{provider}: API key is missing or invalid")
        }
        Some(reqwest::StatusCode::TOO_MANY_REQUESTS) => {
            format!("{provider}: too many requests; try again shortly")
        }
        _ => format!("{provider} search failed: {}", error.without_url()),
    }
}

async fn read_provider_json(
    mut response: reqwest::Response,
    provider: &str,
) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SEARCH_BYTES as u64)
    {
        return Err(format!("{provider} returned too much search data"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        format!(
            "{provider} results could not be read: {}",
            error.without_url()
        )
    })? {
        if bytes.len().saturating_add(chunk.len()) > MAX_SEARCH_BYTES {
            return Err(format!("{provider} returned too much search data"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let provider = provider.to_owned();
    tokio::task::spawn_blocking(move || {
        serde_json::from_slice(&bytes)
            .map_err(|_| format!("{provider} returned unreadable search data"))
    })
    .await
    .map_err(|_| "Search data could not be processed".to_owned())?
}

async fn search_wallhaven(
    client: &reqwest::Client,
    query: &str,
    filters: &BackgroundSearchFilters,
) -> Result<BackgroundSearchPage, String> {
    let mut request = client
        .get(WALLHAVEN_API)
        .query(&wallhaven_parameters(query, filters));
    // SFW browsing never depends on a key's validity or the account's defaults.
    if filters.include_nsfw {
        let key = wallhaven_api_key().ok_or("Wallhaven: an API key is required for this filter")?;
        let mut key_header = reqwest::header::HeaderValue::from_str(&key)
            .map_err(|_| "Wallhaven: API key is invalid".to_owned())?;
        key_header.set_sensitive(true);
        request = request.header("X-API-Key", key_header);
    }
    let response = request
        .send()
        .await
        .map_err(|error| provider_http_error("Wallhaven", error))?
        .error_for_status()
        .map_err(|error| provider_http_error("Wallhaven", error))?;
    let body = read_provider_json(response, "Wallhaven").await?;
    wallhaven_page(&body, filters)
}

fn wallhaven_page(
    body: &Value,
    filters: &BackgroundSearchFilters,
) -> Result<BackgroundSearchPage, String> {
    let records = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Wallhaven returned an invalid result list")?;
    let page = body
        .pointer("/meta/current_page")
        .and_then(dimension)
        .filter(|page| *page > 0)
        .ok_or("Wallhaven returned invalid pagination")?;
    let last_page = body
        .pointer("/meta/last_page")
        .and_then(dimension)
        .ok_or("Wallhaven returned invalid pagination")?;
    let mut results = Vec::new();
    for record in records {
        if !filters.include_nsfw && record.get("purity").and_then(Value::as_str) != Some("sfw") {
            continue;
        }
        let (Some(width), Some(height)) = (
            record.get("dimension_x").and_then(dimension),
            record.get("dimension_y").and_then(dimension),
        ) else {
            continue;
        };
        if !fits(width, height, filters) {
            continue;
        }
        let Some(id) = record
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.chars().all(|ch| ch.is_ascii_alphanumeric()))
        else {
            continue;
        };
        let (Some(image_url), Some(preview_url)) = (
            record.get("path").and_then(Value::as_str),
            record
                .pointer("/thumbs/large")
                .or_else(|| record.pointer("/thumbs/original"))
                .and_then(Value::as_str),
        ) else {
            continue;
        };
        if allowed_image_url("wallhaven", image_url).is_err()
            || allowed_image_url("wallhaven", preview_url).is_err()
        {
            continue;
        }
        results.push(BackgroundImageResult {
            id: id.into(),
            provider: "wallhaven".into(),
            title: format!("Wallhaven {id}"),
            preview_url: preview_url.into(),
            image_url: image_url.into(),
            source_url: format!("https://wallhaven.cc/w/{id}"),
            author: record
                .pointer("/uploader/username")
                .and_then(Value::as_str)
                .map(clean_external_text)
                .filter(|value| !value.is_empty()),
            license: None,
            license_url: None,
            width,
            height,
        });
        if results.len() >= result_limit(filters) {
            break;
        }
    }
    Ok(BackgroundSearchPage {
        images: results,
        page,
        has_more: page < last_page,
    })
}

fn konachan_tags(query: &str) -> Result<String, String> {
    // The explicit safe filter cannot be overwritten by user-supplied metatags.
    if query.split_whitespace().any(|tag| {
        tag.trim_start_matches(['-', '~'])
            .to_ascii_lowercase()
            .starts_with("rating:")
    }) {
        return Err("Use the content filter instead of a rating tag".into());
    }
    Ok(format!("{} rating:safe", query.trim()).trim().to_owned())
}

async fn search_konachan(
    client: &reqwest::Client,
    query: &str,
    filters: &BackgroundSearchFilters,
) -> Result<BackgroundSearchPage, String> {
    if filters.include_nsfw {
        return Err("Konachan: this source only supports safe wallpapers".into());
    }
    if filters.category != "all" || filters.color.is_some() {
        return Err("Konachan does not support category or color filters".into());
    }
    let mut tags = konachan_tags(query)?;
    if filters.min_width > 0 {
        tags.push_str(&format!(" width:>={}", filters.min_width));
    }
    if filters.min_height > 0 {
        tags.push_str(&format!(" height:>={}", filters.min_height));
    }
    let limit = result_limit(filters);
    // Fetch a bounded page, then apply source dimensions and orientation locally.
    let response = client
        .get(KONACHAN_API)
        .query(&[
            ("tags", tags),
            ("limit", limit.to_string()),
            ("page", filters.page.to_string()),
        ])
        .send()
        .await
        .map_err(|error| provider_http_error("Konachan", error))?
        .error_for_status()
        .map_err(|error| provider_http_error("Konachan", error))?;
    let body = read_provider_json(response, "Konachan").await?;
    let records = body
        .as_array()
        .ok_or("Konachan returned an invalid result list")?;
    Ok(konachan_page(records, filters))
}

fn konachan_page(records: &[Value], filters: &BackgroundSearchFilters) -> BackgroundSearchPage {
    let has_more = records.len() >= result_limit(filters);
    let mut results = Vec::new();
    for record in records {
        if record.get("rating").and_then(Value::as_str) != Some("s")
            || record.get("is_shown_in_index").and_then(Value::as_bool) == Some(false)
        {
            continue;
        }
        let (Some(id), Some(width), Some(height)) = (
            record.get("id").and_then(Value::as_u64),
            record.get("width").and_then(dimension),
            record.get("height").and_then(dimension),
        ) else {
            continue;
        };
        if !fits(width, height, filters) {
            continue;
        }
        let (Some(image_url), Some(preview_url)) = (
            record.get("file_url").and_then(Value::as_str),
            record
                .get("sample_url")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .or_else(|| record.get("preview_url").and_then(Value::as_str)),
        ) else {
            continue;
        };
        if allowed_image_url("konachan", image_url).is_err()
            || allowed_image_url("konachan", preview_url).is_err()
        {
            continue;
        }
        let title = record
            .get("tags")
            .and_then(Value::as_str)
            .map(|tags| {
                clean_external_text(&tags.replace('_', " "))
                    .chars()
                    .take(80)
                    .collect::<String>()
            })
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| format!("Konachan {id}"));
        results.push(BackgroundImageResult {
            id: id.to_string(),
            provider: "konachan".into(),
            title,
            preview_url: preview_url.into(),
            image_url: image_url.into(),
            source_url: format!("https://konachan.net/post/show/{id}"),
            // These sites host works with different rights; no blanket license is invented.
            author: None,
            license: None,
            license_url: None,
            width,
            height,
        });
    }
    BackgroundSearchPage {
        images: results,
        page: filters.page,
        has_more,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallhaven_pagination_uses_metadata_when_visible_page_is_empty() {
        let body = serde_json::json!({ "data": [], "meta": { "current_page": 2, "last_page": 3 } });
        let page = wallhaven_page(&body, &Default::default()).unwrap();
        assert!(page.images.is_empty());
        assert_eq!(page.page, 2);
        assert!(page.has_more);
        let last = serde_json::json!({ "data": [], "meta": { "current_page": 3, "last_page": 3 } });
        assert!(!wallhaven_page(&last, &Default::default()).unwrap().has_more);
    }

    #[test]
    fn konachan_pagination_keeps_next_page_after_orientation_filters_every_image() {
        let record = serde_json::json!({
            "id": 1, "rating": "s", "width": 1440, "height": 2560,
            "file_url": "https://konachan.net/image/example/image.png",
            "sample_url": "https://konachan.net/sample/example/image.jpg"
        });
        let filters = BackgroundSearchFilters {
            limit: 24,
            page: 2,
            ..Default::default()
        };
        let mut records = vec![record; 24];
        let full = konachan_page(&records, &filters);
        assert!(full.images.is_empty());
        assert_eq!(full.page, 2);
        assert!(full.has_more);
        records.pop();
        assert!(!konachan_page(&records, &filters).has_more);
    }

    #[test]
    fn legacy_filters_default_to_safe_browsing() {
        let filters: BackgroundSearchFilters = serde_json::from_value(serde_json::json!({
            "minWidth": 1920, "minHeight": 1080, "orientation": "landscape", "limit": 24
        }))
        .unwrap();
        assert_eq!(filters.category, "all");
        assert!(!filters.include_nsfw);
        assert_eq!(filters.page, 1);
        assert!(validate("", &filters).is_ok());
    }

    #[test]
    fn wallhaven_query_keeps_sfw_and_server_filters_explicit() {
        let filters = BackgroundSearchFilters {
            category: "anime".into(),
            color: Some("EA4C88".into()),
            page: 2,
            ..Default::default()
        };
        let params = wallhaven_parameters("", &filters);
        assert!(params.contains(&("categories", "010".into())));
        assert!(params.contains(&("purity", "100".into())));
        assert!(params.contains(&("colors", "ea4c88".into())));
        assert!(params.contains(&("page", "2".into())));
        assert!(!params.iter().any(|(key, _)| *key == "apikey"));
    }

    #[test]
    fn invalid_color_and_page_are_rejected() {
        let mut filters = BackgroundSearchFilters {
            color: Some("#ff0000".into()),
            ..Default::default()
        };
        assert!(validate("nature", &filters).is_err());
        filters.color = None;
        filters.page = 0;
        assert!(validate("nature", &filters).is_err());
    }

    #[test]
    fn safe_konachan_rating_cannot_be_overridden() {
        assert_eq!(konachan_tags("landscape").unwrap(), "landscape rating:safe");
        assert!(konachan_tags("landscape ~rating:e").is_err());
        assert!(konachan_tags("-RATING:s").is_err());
    }

    #[test]
    fn image_allowlist_blocks_host_confusion_and_keeps_old_saved_urls() {
        for (provider, url) in [
            ("wallhaven", "https://th.wallhaven.cc/lg/qr/qrow67.jpg"),
            (
                "konachan",
                "https://konachan.net/data/preview/ab/cd/image.jpg",
            ),
            (
                "pinterest",
                "https://i.pinimg.com/originals/ab/cd/image.jpg",
            ),
            (
                "commons",
                "https://upload.wikimedia.org/wikipedia/commons/a/a1/image.jpg",
            ),
            (
                "artic",
                "https://www.artic.edu/iiif/2/image/full/1920,/0/default.jpg",
            ),
        ] {
            assert!(allowed_image_url(provider, url).is_ok(), "{provider}");
        }
        for url in [
            "https://th.wallhaven.cc.evil.example/lg/image.jpg",
            "http://th.wallhaven.cc/lg/image.jpg",
            "https://user:password@th.wallhaven.cc/lg/image.jpg",
            "https://th.wallhaven.cc:8443/lg/image.jpg",
            "https://wallhaven.cc/api/v1/search",
        ] {
            assert!(allowed_image_url("wallhaven", url).is_err(), "{url}");
        }
    }

    #[test]
    fn preview_decode_resizes_and_rejects_mislabeled_payloads() {
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1440, 960)
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        let (_, preview) =
            decode_and_sanitize_image_at_size("image/png", encoded.get_ref(), 720).unwrap();
        let decoded = image::load_from_memory(&preview).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (720, 480));
        assert!(decode_and_sanitize_image_at_size("image/jpeg", encoded.get_ref(), 720).is_err());
        assert!(
            decode_and_sanitize_image_at_size("image/png", b"<html>not an image</html>", 720)
                .is_err()
        );
    }
}
