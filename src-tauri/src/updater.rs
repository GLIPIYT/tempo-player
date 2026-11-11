use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

mod installer;
pub use installer::InstallerState;

const RELEASES_API: &str = "https://api.github.com/repos/GLIPIYT/tempo-player/releases";
const LATEST_RELEASE_URL: &str = "https://github.com/GLIPIYT/tempo-player/releases/latest";
const USER_AGENT: &str = "Tempo-desktop-updater";

/// Emitted while the installer downloads: `{ version, downloaded, total }`.
pub const PROGRESS_EVENT: &str = "updater://progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    /// The tag without its leading `v`, which is what version comparison wants.
    pub version: String,
    pub tag: String,
    pub name: String,
    /// The release body, shown in the update dialog as the changelog.
    pub notes: String,
    pub published_at: String,
    /// The Windows installer, when the release carries one.
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: Option<u64>,
}

/// The About page only needs the published version, not release notes or assets.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestReleaseInfo {
    pub version: String,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 5 && trusted_github_host(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("untrusted GitHub redirect or too many redirects")
            }
        }))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client error: {e}"))
}

/// Every published release, newest first, with the installer picked out of each.
///
/// Drafts are skipped: they are not downloadable, and offering one would just
/// produce a 404 at install time.
#[tauri::command]
pub async fn updater_releases() -> Result<Vec<ReleaseInfo>, String> {
    let response = client()?
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub returned {}", response.status()));
    }

    let releases: Vec<GhRelease> = response
        .json()
        .await
        .map_err(|e| format!("could not read the release list: {e}"))?;

    Ok(releases
        .into_iter()
        .filter(|r| {
            !r.draft
                && !r.prerelease
                && stable_version(r.tag_name.strip_prefix('v').unwrap_or(&r.tag_name)).is_some()
        })
        .map(|r| {
            let (asset_name, asset_url, asset_size) = verified_installer_asset(&r)
                .map(|(asset, _)| {
                    (
                        Some(asset.name.clone()),
                        Some(asset.browser_download_url.clone()),
                        Some(asset.size),
                    )
                })
                .unwrap_or_default();
            ReleaseInfo {
                version: r.tag_name.trim_start_matches('v').to_string(),
                tag: r.tag_name,
                name: r.name.unwrap_or_default(),
                notes: r.body.unwrap_or_default(),
                published_at: r.published_at.unwrap_or_default(),
                asset_name,
                asset_url,
                asset_size,
            }
        })
        .collect())
}

/// Fetches the current stable GitHub release version for the About page.
///
/// GitHub redirects `/releases/latest` to its tag page. A HEAD request reads
/// that redirect without downloading the release page, notes, or asset list.
/// The full release list and its details remain lazy-loaded by
/// `updater_releases` when the update menu is opened.
#[tauri::command]
pub async fn updater_latest() -> Result<Option<LatestReleaseInfo>, String> {
    let response = client()?
        .head(LATEST_RELEASE_URL)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("could not reach GitHub: {e}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("GitHub returned {}", response.status()));
    }

    let version = latest_release_version(response.url())
        .ok_or_else(|| "could not read the latest release tag from GitHub".to_string())?;

    Ok(Some(LatestReleaseInfo { version }))
}

fn latest_release_version(url: &reqwest::Url) -> Option<String> {
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }

    let tag = url
        .path()
        .strip_prefix("/GLIPIYT/tempo-player/releases/tag/")?;
    if tag.is_empty() {
        return None;
    }

    let version = tag.strip_prefix('v').unwrap_or(tag);
    stable_version(version)?;
    Some(version.to_string())
}

fn stable_version(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.');
    let mut result = [0; 3];
    for item in &mut result {
        let part = parts.next()?;
        if !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        *item = part.parse().ok()?;
    }
    parts.next().is_none().then_some(result)
}

fn trusted_github_host(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}

fn sha256_digest(value: &str) -> Option<[u8; 32]> {
    let hex = value.strip_prefix("sha256:")?;
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut digest = [0; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * index..2 * index + 2], 16).ok()?;
    }
    Some(digest)
}

fn verified_installer_asset(release: &GhRelease) -> Option<(&GhAsset, [u8; 32])> {
    if release.draft || release.prerelease {
        return None;
    }
    let version = release.tag_name.strip_prefix('v')?;
    stable_version(version)?;
    let name = format!("Tempo_{version}_x64-setup.exe");
    let url = format!(
        "https://github.com/GLIPIYT/tempo-player/releases/download/{}/{name}",
        release.tag_name
    );
    let asset = release.assets.iter().find(|asset| {
        asset.name == name
            && asset.browser_download_url == url
            && (1..=256 * 1024 * 1024).contains(&asset.size)
    })?;
    Some((asset, sha256_digest(asset.digest.as_deref()?)?))
}

/// The renderer selects a version. The native updater resolves and verifies its installer.
#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    state: State<'_, InstallerState>,
    version: String,
) -> Result<String, String> {
    state.download(&app, &version).await
}

#[tauri::command]
pub async fn updater_install(
    app: AppHandle,
    state: State<'_, InstallerState>,
    token: String,
) -> Result<(), String> {
    state.install(&token).await?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn updater_discard(state: State<'_, InstallerState>, token: String) -> Result<(), String> {
    state.discard(&token)
}

#[cfg(test)]
mod tests {
    use super::{latest_release_version, verified_installer_asset, GhRelease};

    #[test]
    fn only_offers_the_expected_asset_with_a_digest() {
        let mut release: GhRelease = serde_json::from_value(serde_json::json!({
            "tag_name": "v1.5.0",
            "assets": [{
                "name": "Tempo_1.5.0_x64-setup.exe",
                "browser_download_url": "https://github.com/GLIPIYT/tempo-player/releases/download/v1.5.0/Tempo_1.5.0_x64-setup.exe",
                "size": 10,
                "digest": format!("sha256:{}", "a5".repeat(32))
            }]
        })).unwrap();
        assert_eq!(verified_installer_asset(&release).unwrap().1, [0xa5; 32]);
        release.assets[0].digest = None;
        assert!(verified_installer_asset(&release).is_none());
    }

    #[test]
    fn parses_latest_tag_redirect_without_release_details() {
        let url =
            reqwest::Url::parse("https://github.com/GLIPIYT/tempo-player/releases/tag/v1.3.2")
                .expect("test URL should parse");

        assert_eq!(latest_release_version(&url).as_deref(), Some("1.3.2"));
    }

    #[test]
    fn rejects_a_url_that_is_not_a_release_tag() {
        let url = reqwest::Url::parse("https://github.com/GLIPIYT/tempo-player/releases/latest")
            .expect("test URL should parse");

        assert_eq!(latest_release_version(&url), None);
    }

    #[test]
    fn rejects_untrusted_hosts_queries_and_prerelease_tags() {
        for value in [
            "https://github.com.example/GLIPIYT/tempo-player/releases/tag/v1.3.2",
            "https://github.com/GLIPIYT/tempo-player/releases/tag/v1.3.2?download=1",
            "https://github.com:444/GLIPIYT/tempo-player/releases/tag/v1.3.2",
            "https://github.com/GLIPIYT/tempo-player/releases/tag/v1.3.2-rc1",
        ] {
            let url = reqwest::Url::parse(value).expect("test URL should parse");
            assert_eq!(
                latest_release_version(&url),
                None,
                "unexpected tag from {value}"
            );
        }
    }
}
