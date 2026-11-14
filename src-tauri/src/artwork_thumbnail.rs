use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::sync::Semaphore;

const THUMBNAIL_BUCKETS: [u32; 3] = [128, 256, 512];
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8192;
const MAX_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 1024;
const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const CACHE_PREFIX: &str = "tempo-artwork-v1-";
const CACHE_FILE_PREFIX: &str = "tempo-artwork-";

// Decoding can allocate tens of MiB for large covers. Keep only one decode in
// progress; concurrent commands wait asynchronously for the bounded worker.
static THUMBNAIL_SLOT: OnceLock<Arc<Semaphore>> = OnceLock::new();
static CACHE_USAGE: OnceLock<Mutex<HashMap<PathBuf, CacheUsage>>> = OnceLock::new();

pub(crate) fn reset_cache_usage(directory: &Path) {
    if let Some(usage) = CACHE_USAGE.get() {
        if let Ok(mut usage) = usage.lock() {
            usage.remove(directory);
        }
    }
}

#[derive(Default)]
struct CacheUsage {
    files: usize,
    bytes: u64,
}

struct CacheReservation {
    directory: PathBuf,
    bytes: u64,
    committed: bool,
}

impl CacheReservation {
    fn set_bytes(&mut self, bytes: u64) -> Option<()> {
        let usage = CACHE_USAGE.get()?;
        let mut usage = usage.lock().ok()?;
        let entry = usage.get_mut(&self.directory)?;
        entry.bytes = entry.bytes.checked_sub(self.bytes)?.checked_add(bytes)?;
        self.bytes = bytes;
        Some(())
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for CacheReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let Some(usage) = CACHE_USAGE.get() else {
            return;
        };
        if let Ok(mut usage) = usage.lock() {
            if let Some(entry) = usage.get_mut(&self.directory) {
                entry.files = entry.files.saturating_sub(1);
                entry.bytes = entry.bytes.saturating_sub(self.bytes);
            }
        }
    }
}

#[tauri::command]
pub async fn get_artwork_thumbnail(
    state: State<'_, crate::commands::AppState>,
    path: String,
    size: u32,
) -> Result<Option<String>, String> {
    if !THUMBNAIL_BUCKETS.contains(&size) {
        return Ok(None);
    }

    let covers_dir = state.covers_dir.clone();
    let avatars_dir = state.avatars_dir.clone();
    let slot = THUMBNAIL_SLOT
        .get_or_init(|| Arc::new(Semaphore::new(1)))
        .clone();
    let permit = slot
        .acquire_owned()
        .await
        .map_err(|_| "thumbnail generation is unavailable".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        generate_thumbnail(Path::new(&path), size, &covers_dir, &avatars_dir)
            .map(|thumbnail| thumbnail.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "thumbnail generation task failed".to_string())
}

fn generate_thumbnail(
    requested_path: &Path,
    size: u32,
    covers_dir: &Path,
    avatars_dir: &Path,
) -> Option<PathBuf> {
    if !THUMBNAIL_BUCKETS.contains(&size) {
        return None;
    }

    let source = canonical_source(requested_path, covers_dir, avatars_dir)?;
    let metadata = fs::metadata(&source).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SOURCE_BYTES {
        return None;
    }

    let modified_nanos = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut source_key = Sha256::new();
    source_key.update(source.as_os_str().to_string_lossy().as_bytes());
    source_key.update(metadata.len().to_le_bytes());
    source_key.update(modified_nanos.to_le_bytes());
    let source_key = format!("{:x}", source_key.finalize());
    let thumbnail_path = covers_dir.join(format!("{CACHE_PREFIX}{source_key}-{size}.png"));
    if cached_thumbnail_is_ready(&thumbnail_path) {
        return Some(thumbnail_path);
    }
    // A damaged cache entry can be replaced. The versioned metadata key makes
    // this the derivative owned by this command for this source state.
    if thumbnail_path.exists() {
        fs::remove_file(&thumbnail_path).ok()?;
    }

    // A path+metadata cache hit avoids opening or decoding the source again.
    // Only misses read the source bytes, still under strict file and decode caps.
    let reservation = reserve_cache_entry(covers_dir, MAX_THUMBNAIL_BYTES as u64)?;
    let mut bytes = Vec::with_capacity(metadata.len().min(MAX_SOURCE_BYTES) as usize);
    File::open(&source)
        .ok()?
        .take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_SOURCE_BYTES {
        return None;
    }

    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);

    let image = reader.decode().ok()?;
    let thumbnail = image.thumbnail(size, size);
    write_thumbnail_atomically(thumbnail, &thumbnail_path, covers_dir, reservation)?;
    cached_thumbnail_is_ready(&thumbnail_path).then_some(thumbnail_path)
}

fn canonical_source(
    requested_path: &Path,
    covers_dir: &Path,
    avatars_dir: &Path,
) -> Option<PathBuf> {
    let source = fs::canonicalize(requested_path).ok()?;
    if source == fs::canonicalize(covers_dir).ok()?
        || source == fs::canonicalize(avatars_dir).ok()?
    {
        return None;
    }

    [covers_dir, avatars_dir]
        .into_iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| source.starts_with(root))
        .then_some(source)
}

fn cached_thumbnail_is_ready(path: &Path) -> bool {
    let metadata = match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return false,
    };
    if metadata.len() < 8 || metadata.len() > MAX_THUMBNAIL_BYTES as u64 {
        return false;
    }

    let mut signature = [0u8; 8];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut signature))
        .is_ok()
        && signature == *b"\x89PNG\r\n\x1a\n"
}

fn write_thumbnail_atomically(
    thumbnail: DynamicImage,
    destination: &Path,
    cache_dir: &Path,
    mut reservation: CacheReservation,
) -> Option<()> {
    let mut encoded = Cursor::new(Vec::new());
    thumbnail.write_to(&mut encoded, ImageFormat::Png).ok()?;
    let bytes = encoded.into_inner();
    if bytes.is_empty() || bytes.len() > MAX_THUMBNAIL_BYTES {
        return None;
    }
    reservation.set_bytes(bytes.len() as u64)?;

    let mut temporary = tempfile::NamedTempFile::new_in(cache_dir).ok()?;
    temporary.write_all(&bytes).ok()?;
    temporary.as_file().sync_all().ok()?;

    match temporary.persist_noclobber(destination) {
        Ok(_) => {
            reservation.commit();
            Some(())
        }
        Err(_) if cached_thumbnail_is_ready(destination) => Some(()),
        Err(_) => None,
    }
}

fn reserve_cache_entry(directory: &Path, bytes: u64) -> Option<CacheReservation> {
    let usage_lock = CACHE_USAGE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut usage_map = usage_lock.lock().ok()?;
    if !usage_map.contains_key(directory) {
        let mut usage = CacheUsage::default();
        for entry in fs::read_dir(directory).ok()? {
            let entry = entry.ok()?;
            if !entry
                .file_name()
                .to_string_lossy()
                .starts_with(CACHE_FILE_PREFIX)
            {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) if metadata.is_file() => metadata,
                _ => continue,
            };
            usage.files = usage.files.saturating_add(1);
            usage.bytes = usage.bytes.saturating_add(metadata.len());
        }
        usage_map.insert(directory.to_path_buf(), usage);
    }

    let usage = usage_map.get_mut(directory)?;
    if usage.files >= MAX_CACHE_FILES || usage.bytes.checked_add(bytes)? > MAX_CACHE_BYTES {
        return None;
    }
    usage.files += 1;
    usage.bytes += bytes;

    Some(CacheReservation {
        directory: directory.to_path_buf(),
        bytes,
        committed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::generate_thumbnail;
    use image::{DynamicImage, ImageBuffer, Rgb};
    use std::fs;

    #[test]
    fn resizes_reuses_and_rejects_sources_outside_app_artwork_directories() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let covers_dir = temp.path().join("cache/covers");
        let avatars_dir = temp.path().join("data/avatars");
        let outside_dir = temp.path().join("outside");
        fs::create_dir_all(&covers_dir).expect("covers directory");
        fs::create_dir_all(&avatars_dir).expect("avatars directory");
        fs::create_dir_all(&outside_dir).expect("outside directory");

        let source = covers_dir.join("large-cover.png");
        let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(600, 400, Rgb([12, 34, 56])));
        image.save(&source).expect("write source image");

        let first = generate_thumbnail(&source, 128, &covers_dir, &avatars_dir)
            .expect("thumbnail should be created");
        let dimensions = image::image_dimensions(&first).expect("read thumbnail dimensions");
        assert_eq!(dimensions, (128, 85));

        let reused = generate_thumbnail(&source, 128, &covers_dir, &avatars_dir)
            .expect("thumbnail should be reused");
        assert_eq!(reused, first);

        assert!(generate_thumbnail(&source, 129, &covers_dir, &avatars_dir).is_none());

        let outside_source = outside_dir.join("unapproved.png");
        image.save(&outside_source).expect("write external image");
        assert!(generate_thumbnail(&outside_source, 128, &covers_dir, &avatars_dir).is_none());
    }
}
