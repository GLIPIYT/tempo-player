use std::fs::{File, OpenOptions};
use std::io;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tempfile::TempPath;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::{
    client, stable_version, verified_installer_asset, GhRelease, PROGRESS_EVENT, RELEASES_API,
};

#[derive(Default)]
pub struct InstallerState(Mutex<Option<StagedInstaller>>);

struct StagedInstaller {
    token: String,
    file: TempPath,
    size: u64,
    digest: [u8; 32],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress<'a> {
    version: &'a str,
    downloaded: u64,
    total: u64,
}

impl InstallerState {
    pub(super) async fn download(&self, app: &AppHandle, version: &str) -> Result<String, String> {
        let wanted = stable_version(version).ok_or("invalid update version")?;
        let current = &app.package_info().version;
        if wanted <= [current.major, current.minor, current.patch] {
            return Err("the update must be newer than the installed version".into());
        }

        let mut slot = self
            .0
            .try_lock()
            .map_err(|_| "an update operation is in progress")?;
        let http = client()?;
        let release: GhRelease = http
            .get(format!("{RELEASES_API}/tags/v{version}"))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| format!("could not read the published update: {error}"))?
            .json()
            .await
            .map_err(|error| format!("invalid release information: {error}"))?;
        if release.tag_name != format!("v{version}") {
            return Err("release version did not match the requested update".into());
        }
        let (asset, digest) = verified_installer_asset(&release)
            .ok_or("the published release has no verifiable Windows installer")?;

        let mut response = http
            .get(&asset.browser_download_url)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| format!("download failed: {error}"))?;
        if response
            .content_length()
            .is_some_and(|size| size != asset.size)
        {
            return Err("installer size did not match the published release".into());
        }

        let (file, path) = tempfile::Builder::new()
            .prefix("tempo-update-")
            .suffix(".exe")
            .tempfile()
            .map_err(|error| format!("could not create a temporary installer: {error}"))?
            .into_parts();
        let token = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or("invalid temporary installer name")?
            .to_owned();
        let mut file = tokio::fs::File::from_std(file);
        let mut hash = Sha256::new();
        let mut downloaded = 0;
        let mut reported = 0;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("download interrupted: {error}"))?
        {
            downloaded += chunk.len() as u64;
            if downloaded > asset.size {
                return Err("installer exceeded the published size".into());
            }
            hash.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("could not write the installer: {error}"))?;
            if downloaded - reported >= 256 * 1024 && downloaded < asset.size {
                reported = downloaded;
                let _ = app.emit(
                    PROGRESS_EVENT,
                    DownloadProgress {
                        version,
                        downloaded,
                        total: asset.size,
                    },
                );
            }
        }
        file.flush()
            .await
            .map_err(|error| format!("could not finish the installer: {error}"))?;
        drop(file);
        check_integrity(downloaded, hash, asset.size, digest)?;
        *slot = Some(StagedInstaller {
            token: token.clone(),
            file: path,
            size: asset.size,
            digest,
        });
        let _ = app.emit(
            PROGRESS_EVENT,
            DownloadProgress {
                version,
                downloaded,
                total: asset.size,
            },
        );
        Ok(token)
    }

    pub(super) async fn install(&self, token: &str) -> Result<(), String> {
        let mut slot = self
            .0
            .try_lock()
            .map_err(|_| "an update operation is in progress")?;
        if !slot.as_ref().is_some_and(|entry| entry.token == token) {
            return Err("no verified installer matches this update".into());
        }
        let installer = slot.take().expect("verified installer present");
        let (installer, result) = tauri::async_runtime::spawn_blocking(move || {
            let result = installer.launch();
            (installer, result)
        })
        .await
        .map_err(|error| format!("installer task failed: {error}"))?;
        if result.is_err() {
            *slot = Some(installer);
        }
        result
    }

    pub(super) fn discard(&self, token: &str) -> Result<(), String> {
        let mut slot = self
            .0
            .try_lock()
            .map_err(|_| "an update operation is in progress")?;
        if slot.as_ref().is_some_and(|entry| entry.token == token) {
            slot.take();
        }
        Ok(())
    }
}

impl StagedInstaller {
    fn open_verified(&self) -> Result<File, String> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Hold a handle that denies writes and deletion through process launch.
            options.share_mode(1);
        }
        let mut file = options
            .open(&self.file)
            .map_err(|error| format!("could not open the installer: {error}"))?;
        if file.metadata().map_err(|error| error.to_string())?.len() != self.size {
            return Err("installer size did not match the published release".into());
        }
        let mut hash = Sha256::new();
        let size = io::copy(&mut file, &mut hash)
            .map_err(|error| format!("could not verify the installer: {error}"))?;
        check_integrity(size, hash, self.size, self.digest)?;
        Ok(file)
    }

    fn launch(&self) -> Result<(), String> {
        let _verified_file = self.open_verified()?;
        let mut command = std::process::Command::new(&self.file);
        crate::child::quiet(&mut command);
        // NSIS silent install and restart.
        command
            .args(["/S", "/R"])
            .spawn()
            .map_err(|error| format!("could not start the installer: {error}"))?;
        Ok(())
    }
}

fn check_integrity(
    size: u64,
    hash: Sha256,
    expected_size: u64,
    expected_digest: [u8; 32],
) -> Result<(), String> {
    if size != expected_size || <[u8; 32]>::from(hash.finalize()) != expected_digest {
        return Err("installer did not match the published size and SHA-256".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_replaced_and_truncated_installers_before_launch() {
        let contents = b"fixture installer";
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), contents).unwrap();
        let installer = StagedInstaller {
            token: "test".into(),
            file: file.into_temp_path(),
            size: contents.len() as u64,
            digest: Sha256::digest(contents).into(),
        };
        assert!(installer.open_verified().is_ok());
        std::fs::write(&installer.file, b"Fixture installer").unwrap();
        assert!(installer.open_verified().is_err());
        std::fs::write(&installer.file, b"truncated").unwrap();
        assert!(installer.open_verified().is_err());
    }
}
