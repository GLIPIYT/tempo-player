/*
 * Update checking against this project's GitHub releases.
 *
 * Deliberately not `tauri-plugin-updater`: that plugin only ever offers the
 * newest release, and the settings screen has to be able to install any version
 * above the running one. It would also require a signing keypair, which the
 * release pipeline does not have.
 *
 * The trade-off is that nothing here checks a signature - TLS and GitHub itself
 * are the whole guarantee. That is worth knowing when reading this file.
 */

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const RELEASES_API: &str = "https://api.github.com/repos/GLIPIYT/tempo-player/releases";
const USER_AGENT: &str = "Tempo-desktop-updater";

/// Emitted while the installer downloads: `{ version, downloaded, total }`.
pub const PROGRESS_EVENT: &str = "updater://progress";

/// Only report progress every so often - a chunk-level event would flood the
/// IPC channel for no visible gain.
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;

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

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
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
    assets: Vec<GhAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    version: String,
    downloaded: u64,
    total: u64,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
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
        .filter(|r| !r.draft)
        .map(|r| {
            let installer = r.assets.iter().find(|a| a.name.ends_with("-setup.exe"));
            ReleaseInfo {
                version: r.tag_name.trim_start_matches('v').to_string(),
                tag: r.tag_name,
                name: r.name.unwrap_or_default(),
                notes: r.body.unwrap_or_default(),
                published_at: r.published_at.unwrap_or_default(),
                asset_name: installer.map(|a| a.name.clone()),
                asset_url: installer.map(|a| a.browser_download_url.clone()),
                asset_size: installer.map(|a| a.size),
            }
        })
        .collect())
}

/// Downloads one installer into the temp directory and returns its path.
///
/// Streamed rather than buffered so the dialog can show progress - a 5 MB
/// download with no feedback looks like a hang.
#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    url: String,
    version: String,
) -> Result<String, String> {
    let mut response = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("download failed: {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let dir = std::env::temp_dir().join("tempo-update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = dir.join(format!("Tempo_{version}_x64-setup.exe"));

    let mut file =
        std::fs::File::create(&path).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("download interrupted: {e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("could not write the installer: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded - reported >= PROGRESS_STEP_BYTES {
            reported = downloaded;
            let _ = app.emit(
                PROGRESS_EVENT,
                DownloadProgress { version: version.clone(), downloaded, total },
            );
        }
    }

    let _ = app.emit(
        PROGRESS_EVENT,
        DownloadProgress { version: version.clone(), downloaded, total: total.max(downloaded) },
    );
    Ok(path.to_string_lossy().to_string())
}

/// Starts the installer and gets out of its way.
///
/// A running executable cannot be replaced, so the app has to exit before the
/// installer can do its job.
///
/// The flags are read off the NSIS script Tauri generates, not guessed:
/// `/S` is NSIS's silent switch, and `/R` is what makes the installer start the
/// app again when it is done - without it a silent install finishes and leaves
/// nothing running, and the app simply vanishes. The installer is built
/// `currentUser`, so none of this needs elevation or shows a UAC prompt, and in
/// silent mode it kills a still-running instance itself.
#[tauri::command]
pub fn updater_install(app: AppHandle, path: String) -> Result<(), String> {
    let installer = PathBuf::from(&path);
    if !installer.exists() {
        return Err(format!("the installer is gone: {path}"));
    }
    let mut command = std::process::Command::new(&installer);
    crate::child::quiet(&mut command);
    command
        .args(["/S", "/R"])
        .spawn()
        .map_err(|e| format!("could not start the installer: {e}"))?;
    app.exit(0);
    Ok(())
}

/// Removes a downloaded installer, for when the user changes their mind.
#[tauri::command]
pub fn updater_discard(path: String) -> Result<(), String> {
    let installer = PathBuf::from(&path);
    if installer.exists() {
        std::fs::remove_file(&installer).map_err(|e| format!("could not delete the installer: {e}"))?;
    }
    Ok(())
}
