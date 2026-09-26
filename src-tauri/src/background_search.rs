use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

use crate::commands::AppState;

const COMMONS_API: &str = "https://commons.wikimedia.org/w/api.php";
const AIC_API: &str = "https://api.artic.edu/api/v1/artworks/search";
const AIC_OPEN_ACCESS: &str = "https://www.artic.edu/open-access/open-access-images";
const MAX_RESULTS: usize = 40;
const MAX_SEARCH_RESULTS: usize = 50;
const THUMBNAIL_WIDTH: u32 = 640;
const BACKGROUND_WIDTH: u32 = 1920;
const MAX_BACKGROUND_BYTES: usize = 25 * 1024 * 1024;
const MAX_DECODED_DIMENSION: u32 = 8192;
const MAX_BACKGROUND_DIMENSION: u32 = 2560;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSearchFilters {
    pub min_width: u32,
    pub min_height: u32,
    /// `landscape`, `portrait`, `square`, or `any`.
    pub orientation: String,
    pub limit: usize,
}

impl Default for BackgroundSearchFilters {
    fn default() -> Self {
        Self {
            min_width: 1280,
            min_height: 720,
            orientation: "landscape".into(),
            limit: 30,
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
        .build()
        .map_err(|error| format!("Could not prepare image search: {error}"))
}

fn result_limit(filters: &BackgroundSearchFilters) -> usize {
    filters.limit.clamp(1, MAX_RESULTS)
}

fn dimension(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|value| u32::try_from(value).ok())
}

fn validate(query: &str, filters: &BackgroundSearchFilters) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err("Enter a search phrase".into());
    }
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
    Ok(())
}

fn fits(width: u32, height: u32, filters: &BackgroundSearchFilters) -> bool {
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

fn metadata_value<'a>(metadata: &'a Value, key: &str) -> Option<&'a str> {
    metadata.get(key)?.get("value")?.as_str()
}

#[tauri::command]
pub async fn search_backgrounds(
    provider: String,
    query: String,
    filters: BackgroundSearchFilters,
) -> Result<Vec<BackgroundImageResult>, String> {
    validate(&query, &filters)?;
    let client = client()?;
    match provider.as_str() {
        "commons" => search_commons(&client, &query, &filters).await,
        "artic" => search_artic(&client, &query, &filters).await,
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
    let requested_url = allowed_image_url(&provider, &image_url)?;
    let mut response = download_client(provider.clone())?
        .get(requested_url)
        .send()
        .await
        .map_err(|error| format!("Could not download the selected image: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Could not download the selected image: {error}"))?;
    allowed_image_url(&provider, response.url().as_str())?;

    if let Some(length) = response.content_length() {
        if length > MAX_BACKGROUND_BYTES as u64 {
            return Err("The selected image is larger than 25 MB".into());
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
        .map_err(|error| format!("Could not read the selected image: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_BACKGROUND_BYTES {
            return Err("The selected image is larger than 25 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let (extension, bytes) = decode_and_sanitize_image(&content_type, &bytes)?;
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
    reqwest::Client::builder()
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
        .map_err(|error| format!("Could not prepare the image download: {error}"))
}

fn decode_and_sanitize_image(
    content_type: &str,
    bytes: &[u8],
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
    let resized = decoded.thumbnail(MAX_BACKGROUND_DIMENSION, MAX_BACKGROUND_DIMENSION);
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

async fn search_commons(
    client: &reqwest::Client,
    query: &str,
    filters: &BackgroundSearchFilters,
) -> Result<Vec<BackgroundImageResult>, String> {
    let limit = result_limit(filters);
    let search_limit = limit.min(MAX_SEARCH_RESULTS).to_string();
    let params = [
        ("action", "query".to_string()),
        ("generator", "search".to_string()),
        ("gsrsearch", query.trim().to_string()),
        ("gsrnamespace", "6".to_string()),
        ("gsrlimit", search_limit),
        ("prop", "imageinfo".to_string()),
        ("iiprop", "url|size|mediatype|mime|extmetadata".to_string()),
        (
            "iiextmetadatafilter",
            "Artist|Credit|LicenseShortName|LicenseUrl".to_string(),
        ),
        ("iiurlwidth", THUMBNAIL_WIDTH.to_string()),
        ("format", "json".to_string()),
        ("formatversion", "2".to_string()),
    ];
    let response = client
        .get(COMMONS_API)
        .query(&params)
        .send()
        .await
        .map_err(|error| format!("Wikimedia Commons search failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Wikimedia Commons search failed: {error}"))?;
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Wikimedia Commons returned unreadable results: {error}"))?;
    let Some(pages) = body.pointer("/query/pages").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut results = Vec::new();
    for page in pages {
        let Some(info) = page.pointer("/imageinfo/0") else {
            continue;
        };
        if info.get("mediatype").and_then(Value::as_str) != Some("BITMAP") {
            continue;
        }
        let Some(mime) = info.get("mime").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(mime, "image/jpeg" | "image/png") {
            continue;
        }
        let Some(width) = info.get("width").and_then(dimension) else {
            continue;
        };
        let Some(height) = info.get("height").and_then(dimension) else {
            continue;
        };
        if !fits(width, height, filters) {
            continue;
        }
        let Some(image_url) = info.get("url").and_then(Value::as_str) else {
            continue;
        };
        let preview_url = info
            .get("thumburl")
            .and_then(Value::as_str)
            .unwrap_or(image_url);
        let title = page
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled image")
            .strip_prefix("File:")
            .unwrap_or_else(|| {
                page.get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Untitled image")
            });
        let metadata = info.get("extmetadata").unwrap_or(&Value::Null);
        let author = metadata_value(metadata, "Artist")
            .or_else(|| metadata_value(metadata, "Credit"))
            .map(clean_external_text)
            .filter(|value| !value.is_empty());
        let license = metadata_value(metadata, "LicenseShortName")
            .map(clean_external_text)
            .filter(|value| !value.is_empty());
        let license_url = metadata_value(metadata, "LicenseUrl")
            .map(clean_external_text)
            .filter(|value| value.starts_with("https://") || value.starts_with("http://"));
        let source_url = info
            .get("descriptionurl")
            .and_then(Value::as_str)
            .unwrap_or("https://commons.wikimedia.org/");
        results.push(BackgroundImageResult {
            id: page
                .get("pageid")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .to_string(),
            provider: "commons".into(),
            title: clean_external_text(title),
            preview_url: preview_url.to_string(),
            image_url: image_url.to_string(),
            source_url: source_url.to_string(),
            author,
            license,
            license_url,
            width,
            height,
        });
        if results.len() >= limit {
            break;
        }
    }
    Ok(results)
}

async fn search_artic(
    client: &reqwest::Client,
    query: &str,
    filters: &BackgroundSearchFilters,
) -> Result<Vec<BackgroundImageResult>, String> {
    let limit = result_limit(filters);
    let search_limit = limit.to_string();
    let fields = "id,title,artist_title,image_id,is_public_domain,thumbnail";
    let response = client
        .get(AIC_API)
        .query(&[
            ("q", query.trim()),
            ("limit", search_limit.as_str()),
            ("fields", fields),
            ("query[term][is_public_domain]", "true"),
        ])
        .send()
        .await
        .map_err(|error| format!("Art Institute of Chicago search failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Art Institute of Chicago search failed: {error}"))?;
    let body: Value = response.json().await.map_err(|error| {
        format!("Art Institute of Chicago returned unreadable results: {error}")
    })?;
    let records = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Art Institute of Chicago returned no image results".to_string())?;
    if records.is_empty() {
        return Ok(Vec::new());
    }
    let iiif_base = body
        .pointer("/config/iiif_url")
        .and_then(Value::as_str)
        .and_then(valid_aic_iiif_base)
        .ok_or_else(|| {
            "Art Institute of Chicago returned an invalid image service URL".to_string()
        })?;
    let mut results = Vec::with_capacity(limit);
    for record in records {
        if record.get("is_public_domain").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(id) = record.get("id").and_then(Value::as_i64) else {
            continue;
        };
        let Some(image_id) = record.get("image_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(title) = record.get("title").and_then(Value::as_str) else {
            continue;
        };
        // Search results include source dimensions in the thumbnail metadata,
        // so we can filter without fanning out to one IIIF info request per item.
        let Some(width) = record.pointer("/thumbnail/width").and_then(dimension) else {
            continue;
        };
        let Some(height) = record.pointer("/thumbnail/height").and_then(dimension) else {
            continue;
        };
        if !fits(width, height, filters) {
            continue;
        }
        let author = record
            .get("artist_title")
            .and_then(Value::as_str)
            .map(clean_external_text)
            .filter(|value| !value.is_empty());
        results.push(BackgroundImageResult {
            id: id.to_string(),
            provider: "artic".into(),
            title: clean_external_text(title),
            preview_url: format!("{iiif_base}/{image_id}/full/{THUMBNAIL_WIDTH},/0/default.jpg"),
            image_url: format!("{iiif_base}/{image_id}/full/{BACKGROUND_WIDTH},/0/default.jpg"),
            source_url: format!("https://www.artic.edu/artworks/{id}"),
            author,
            license: Some("Public domain".into()),
            license_url: Some(AIC_OPEN_ACCESS.into()),
            width,
            height,
        });
        if results.len() >= limit {
            break;
        }
    }
    Ok(results)
}

fn valid_aic_iiif_base(value: &str) -> Option<&str> {
    let value = value.trim_end_matches('/');
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https" && url.host_str() == Some("www.artic.edu") && url.path() == "/iiif/2")
        .then_some(value)
}
