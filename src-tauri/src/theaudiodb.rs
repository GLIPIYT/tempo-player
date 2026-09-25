use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::{header, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use tauri::State;

const API_SEARCH: &str = "https://www.theaudiodb.com/api/v1/json/123/search.php";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

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
pub async fn search_artist_images(query: String) -> Result<Vec<ArtistImageCandidate>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.chars().count() > 150 {
        return Err("Artist name is too long".to_string());
    }

    let mut url = Url::parse(API_SEARCH).map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("s", query);
    let response = client()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("TheAudioDB request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(request_error(status));
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
    let url = validate_artist_image_url(&url)?;
    let response = client()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("TheAudioDB image request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(request_error(status));
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

    let directory = state.avatars_dir.join("artists");
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
    tokio::fs::write(&temporary, &bytes)
        .await
        .map_err(|error| error.to_string())?;
    if let Err(error) = tokio::fs::rename(&temporary, &destination).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error.to_string());
    }

    let stored_path = destination.to_string_lossy().into_owned();
    if let Err(error) = state.db.set_artist_image(artist_id, Some(&stored_path)) {
        let _ = tokio::fs::remove_file(&destination).await;
        return Err(error);
    }
    Ok(stored_path)
}

fn temporary_path(directory: &std::path::Path, filename: &str) -> PathBuf {
    directory.join(format!(".{filename}.part"))
}

#[cfg(test)]
mod tests {
    use super::{detect_image_extension, parse_search_response, validate_artist_image_url};

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
