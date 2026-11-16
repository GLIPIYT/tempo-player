//! Public endpoint checks for Settings. Probes never reuse a signed-in session.
use std::time::{Duration, Instant, SystemTime};

use chrono::Utc;
use futures_util::{stream, StreamExt};
use reqwest::{Client, StatusCode};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCheck {
    checked_at: String,
    services: Vec<ServiceProbe>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceProbe {
    id: &'static str,
    label: &'static str,
    host: String,
    primary: bool,
    status: ProbeStatus,
    latency_ms: Option<u64>,
    http_status: Option<u16>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProbeStatus {
    Reachable,
    Restricted,
    Timeout,
    ConnectError,
    NetworkError,
    UnexpectedResponse,
}

#[derive(Clone, Copy)]
struct Target {
    id: &'static str,
    label: &'static str,
    url: &'static str,
    primary: bool,
    allow_missing_resource: bool,
}

impl Target {
    const fn new(id: &'static str, label: &'static str, url: &'static str) -> Self {
        Self {
            id,
            label,
            url,
            primary: false,
            allow_missing_resource: false,
        }
    }

    const fn primary(mut self) -> Self {
        self.primary = true;
        self
    }

    // Some image hosts have no index. A missing index still confirms that the CDN responds.
    const fn cdn(mut self) -> Self {
        self.allow_missing_resource = true;
        self
    }
}

const TARGETS: &[Target] = &[
    Target::new(
        "soundcloud_api",
        "SoundCloud API",
        "https://api-v2.soundcloud.com/tracks?ids=1",
    )
    .primary(),
    Target::new(
        "youtube_music_api",
        "YouTube Music API",
        "https://music.youtube.com/youtubei/v1/search",
    )
    .primary(),
    Target::new(
        "soundcloud_site",
        "SoundCloud website",
        "https://soundcloud.com/",
    ),
    Target::new(
        "youtube_music_site",
        "YouTube Music website",
        "https://music.youtube.com/",
    ),
    Target::new(
        "soundcloud_artwork",
        "SoundCloud artwork",
        "https://i1.sndcdn.com/",
    )
    .cdn(),
    Target::new(
        "soundcloud_waveforms",
        "SoundCloud waveforms",
        "https://wave.sndcdn.com/",
    )
    .cdn(),
    Target::new("youtube_artwork", "YouTube artwork", "https://i.ytimg.com/").cdn(),
    Target::new(
        "google_artwork",
        "Google artwork",
        "https://lh3.googleusercontent.com/",
    )
    .cdn(),
    Target::new(
        "lrclib_api",
        "LRCLIB API",
        "https://lrclib.net/api/search?q=Tempo",
    ),
    Target::new(
        "genius_api",
        "Genius API",
        "https://genius.com/api/search/multi?per_page=1&q=Tempo",
    ),
    Target::new(
        "musixmatch_api",
        "Musixmatch API",
        "https://apic-desktop.musixmatch.com/ws/1.1/track.search?q_track=Tempo&page_size=1",
    ),
    Target::new(
        "deezer_api",
        "Deezer API",
        "https://api.deezer.com/search/artist?q=Tempo&limit=1",
    ),
    Target::new(
        "wikipedia_api",
        "Wikipedia API",
        "https://en.wikipedia.org/w/api.php?action=query&titles=Tempo&format=json",
    ),
    Target::new(
        "github_releases",
        "Tempo updates",
        "https://api.github.com/repos/GLIPIYT/tempo-player/releases/latest",
    ),
    Target::new(
        "github_tools",
        "yt-dlp updates",
        "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
    ),
    Target::new(
        "github_media",
        "GitHub release artwork",
        "https://raw.githubusercontent.com/GLIPIYT/tempo-player/main/README.md",
    ),
    Target::new(
        "wallhaven_api",
        "Wallhaven API",
        "https://wallhaven.cc/api/v1/search",
    ),
    Target::new("pinterest_site", "Pinterest", "https://www.pinterest.com/"),
    Target::new(
        "konachan_api",
        "Konachan API",
        "https://konachan.net/post.json?limit=1",
    ),
    Target::new("hf_models", "Hugging Face", "https://huggingface.co/"),
    Target::new(
        "release_assets",
        "Installer downloads",
        "https://release-assets.githubusercontent.com/",
    )
    .cdn(),
    Target::new(
        "wallhaven_artwork",
        "Wallhaven images",
        "https://th.wallhaven.cc/",
    )
    .cdn(),
    Target::new(
        "pinterest_artwork",
        "Pinterest images",
        "https://i.pinimg.com/",
    )
    .cdn(),
    Target::new(
        "wikimedia_artwork",
        "Wikimedia images",
        "https://upload.wikimedia.org/",
    )
    .cdn(),
    Target::new(
        "discord_cover_host",
        "Discord cover sharing",
        "https://freeimage.host/",
    ),
];

#[tauri::command]
pub async fn check_services() -> Result<ServiceCheck, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Tempo/1.0 (https://github.com/GLIPIYT/tempo-player)")
        .build()
        .map_err(|_| "could not create diagnostic HTTP client")?;
    let services = stream::iter(TARGETS.iter().copied())
        .map(|target| {
            let client = client.clone();
            async move { probe(&client, target).await }
        })
        .buffered(8)
        .collect()
        .await;
    Ok(ServiceCheck {
        checked_at: chrono::DateTime::<Utc>::from(SystemTime::now()).to_rfc3339(),
        services,
    })
}

async fn probe(client: &Client, target: Target) -> ServiceProbe {
    let host = reqwest::Url::parse(target.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    let started = Instant::now();
    let response = if target.id == "youtube_music_api" {
        crate::youtube_music::search_probe(client).send().await
    } else {
        client.get(target.url).send().await
    };
    let (status, code) = match response {
        Ok(response) => (
            classify_http(response.status(), target.allow_missing_resource),
            Some(response.status().as_u16()),
        ),
        Err(error) if error.is_timeout() => (ProbeStatus::Timeout, None),
        Err(error) if error.is_connect() => (ProbeStatus::ConnectError, None),
        Err(_) => (ProbeStatus::NetworkError, None),
    };
    ServiceProbe {
        id: target.id,
        label: target.label,
        host,
        primary: target.primary,
        status,
        latency_ms: Some(started.elapsed().as_millis() as u64),
        http_status: code,
    }
}

fn classify_http(code: StatusCode, allow_missing_resource: bool) -> ProbeStatus {
    if code.is_success()
        || code.is_redirection()
        || (allow_missing_resource && code == StatusCode::NOT_FOUND)
    {
        ProbeStatus::Reachable
    } else if matches!(
        code,
        StatusCode::UNAUTHORIZED
            | StatusCode::FORBIDDEN
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::UNAVAILABLE_FOR_LEGAL_REASONS
    ) {
        ProbeStatus::Restricted
    } else {
        ProbeStatus::UnexpectedResponse
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_are_public_https_with_unique_ids() {
        let mut ids = std::collections::HashSet::new();
        for target in TARGETS {
            assert!(ids.insert(target.id));
            let url = reqwest::Url::parse(target.url).unwrap();
            assert_eq!(url.scheme(), "https");
            assert!(url.username().is_empty() && url.password().is_none());
        }
        assert_eq!(TARGETS.iter().filter(|target| target.primary).count(), 2);
    }

    #[test]
    fn rejected_requests_are_not_reported_as_available_apis() {
        assert_eq!(classify_http(StatusCode::OK, false), ProbeStatus::Reachable);
        assert_eq!(
            classify_http(StatusCode::UNAUTHORIZED, false),
            ProbeStatus::Restricted
        );
        assert_eq!(
            classify_http(StatusCode::TOO_MANY_REQUESTS, false),
            ProbeStatus::Restricted
        );
        assert_eq!(
            classify_http(StatusCode::NOT_FOUND, false),
            ProbeStatus::UnexpectedResponse
        );
        assert_eq!(
            classify_http(StatusCode::NOT_FOUND, true),
            ProbeStatus::Reachable
        );
    }
}
