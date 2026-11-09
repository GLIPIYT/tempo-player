use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use walkdir::{DirEntry, WalkDir};

use crate::database::{Db, IndexedAudioFile, RegisteredAudioIdentity};
use crate::scanner::AUDIO_EXTENSIONS;

const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_ENTRIES_PER_PASS: u64 = 1_000_000;
const MAX_INDEX_DURATION: Duration = Duration::from_secs(6 * 60 * 60);
const HASH_THROTTLE: Duration = Duration::from_millis(2);
const FILE_THROTTLE: Duration = Duration::from_millis(2);

#[derive(Default)]
struct IndexerState {
    db: Option<Arc<Db>>,
    extra_roots: Vec<PathBuf>,
    cancel: Option<Arc<AtomicBool>>,
    running: bool,
    run_again: bool,
}

pub type ChangeNotifier = Arc<dyn Fn() + Send + Sync + 'static>;

fn change_notifier() -> &'static Mutex<Option<ChangeNotifier>> {
    static NOTIFIER: OnceLock<Mutex<Option<ChangeNotifier>>> = OnceLock::new();
    NOTIFIER.get_or_init(|| Mutex::new(None))
}

/// Install the app-level event used to refresh views after an automatic path
/// recovery. Tests and non-Tauri callers can leave it unset.
pub fn set_change_notifier(notifier: ChangeNotifier) {
    *change_notifier()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(notifier);
}

pub(crate) fn notify_after_relink() {
    let notifier = change_notifier()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if let Some(notifier) = notifier {
        notifier();
    }
}

fn indexer_state() -> &'static Mutex<IndexerState> {
    static STATE: OnceLock<Mutex<IndexerState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(IndexerState::default()))
}

/// Start a low-priority background content index. It hashes known library and
/// cached files first, then discovers matching filenames, then indexes audio
/// files across library roots, user folders, supplied caches, and fixed drives.
/// No full-file hashing runs in a foreground scan or playback request.
pub fn start_background_indexer(db: Arc<Db>, extra_roots: Vec<PathBuf>) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut state = indexer_state()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.db = Some(db.clone());
        for root in extra_roots {
            if !state.extra_roots.contains(&root) {
                state.extra_roots.push(root);
            }
        }
        if state.running {
            state.run_again = true;
            return Ok(());
        }
        state.running = true;
        state.cancel = Some(cancel.clone());
    }

    let roots = indexer_state()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .extra_roots
        .clone();
    let thread_db = db.clone();
    let thread_cancel = cancel.clone();
    let spawn = thread::Builder::new()
        .name("tempo-library-identity".into())
        .spawn(move || {
            let _ = run_index(&thread_db, &roots, &thread_cancel);
            let rerun = {
                let mut state = indexer_state()
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.running = false;
                state.cancel = None;
                let rerun = state.run_again && !thread_cancel.load(Ordering::Relaxed);
                state.run_again = false;
                rerun
            };
            if rerun {
                let _ = start_background_indexer(thread_db, Vec::new());
            }
        });
    if let Err(error) = spawn {
        let mut state = indexer_state()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.running = false;
        state.cancel = None;
        return Err(format!("failed to start library identity index: {error}"));
    }
    Ok(())
}

/// Request another discovery pass after a library scan or a missing playback
/// lookup. If a pass is already active, one follow-up pass is queued.
pub fn request_background_refresh() {
    let (db, roots, running) = {
        let mut state = indexer_state()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.running {
            state.run_again = true;
            return;
        }
        (state.db.clone(), state.extra_roots.clone(), state.running)
    };
    if !running {
        if let Some(db) = db {
            let _ = start_background_indexer(db, roots);
        }
    }
}

/// Stop the current background pass at the next directory or hash chunk.
pub fn cancel_background_indexer() {
    let mut state = indexer_state()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.run_again = false;
    if let Some(cancel) = &state.cancel {
        cancel.store(true, Ordering::Relaxed);
    }
}

fn run_index(db: &Db, extra_roots: &[PathBuf], cancel: &AtomicBool) -> Result<(), String> {
    let started = Instant::now();
    let roots = discover_roots(db, extra_roots);
    if roots.is_empty() || cancelled(cancel, started) {
        return Ok(());
    }

    // Hash only new files or files whose recorded stamps changed. Existing
    // content fingerprints are reused, so routine scans and cache downloads do
    // not re-read every known audio file.
    let initial_identities = db.list_registered_audio_identities()?;
    for identity in &initial_identities {
        if cancelled(cancel, started) {
            return Ok(());
        }
        let path = Path::new(&identity.path);
        if !path.is_file() {
            if identity.source == "local" {
                let _ = db.mark_registered_audio_missing(identity.id);
            }
            continue;
        }
        let Some((live_size, live_mtime_ns)) = file_stamp(path) else { continue };
        if identity.source == "local"
            && (live_size != identity.file_size || live_mtime_ns != identity.file_mtime_ns)
        {
            // The scanner owns local metadata refresh. It will request a new
            // identity pass after committing the updated stamp.
            continue;
        }
        let hash_is_current = identity.sha256.is_some()
            && identity.hash_file_size == Some(live_size)
            && identity.hash_file_mtime_ns == Some(live_mtime_ns);
        if hash_is_current {
            let Some(sha256) = identity.sha256.clone() else { continue };
            if db.indexed_audio_file_for_stamp(&identity.path, live_size, live_mtime_ns)?.is_none() {
                db.index_audio_file(&indexed_file(path, live_size, live_mtime_ns, sha256))?;
            }
            continue;
        }
        let Some((sha256, size, mtime_ns)) = hash_file(path, cancel, started) else {
            continue;
        };
        if db.remember_registered_audio_hash(identity.id, &identity.path, size, mtime_ns, &sha256)? {
            let file = indexed_file(path, size, mtime_ns, sha256);
            db.index_audio_file(&file)?;
        }
        thread::sleep(FILE_THROTTLE);
    }

    let initial_missing: Vec<RegisteredAudioIdentity> = db
        .list_registered_audio_identities()?
        .into_iter()
        .filter(|identity| {
            !Path::new(&identity.path).is_file()
                && identity.sha256.is_some()
                && identity.hash_file_size == Some(identity.file_size)
                && identity.hash_file_mtime_ns == Some(identity.file_mtime_ns)
        })
        .collect();
    for identity in &initial_missing {
        if cancelled(cancel, started) {
            return Ok(());
        }
        let _ = db.resolve_registered_audio_path(Some(identity.id), None, None)?;
    }
    let missing: Vec<RegisteredAudioIdentity> = db
        .list_registered_audio_identities()?
        .into_iter()
        .filter(|identity| {
            !Path::new(&identity.path).is_file()
                && identity.sha256.is_some()
                && identity.hash_file_size == Some(identity.file_size)
                && identity.hash_file_mtime_ns == Some(identity.file_mtime_ns)
        })
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut target_keys: HashSet<(String, i64)> = HashSet::new();
    let mut target_sizes: HashSet<i64> = HashSet::new();
    let mut pending_by_hash: HashMap<String, Vec<i64>> = HashMap::new();
    for identity in &missing {
        let Some(sha256) = &identity.sha256 else { continue };
        target_sizes.insert(identity.file_size);
        if let Some(name) = Path::new(&identity.path).file_name().and_then(|name| name.to_str()) {
            target_keys.insert((name.to_lowercase(), identity.file_size));
        }
        pending_by_hash.entry(sha256.to_ascii_lowercase()).or_default().push(identity.id);
    }
    for track_ids in pending_by_hash.values_mut() {
        track_ids.sort_unstable();
        track_ids.dedup();
    }

    let mut visited = HashSet::new();
    // Name+size candidates are considered first. A hash is still required to
    // relink, so duplicate names and same-sized files cannot claim the row.
    walk_audio_files(&roots, cancel, started, |path, file_size| {
        if cancelled(cancel, started) || pending_by_hash.is_empty() {
            return false;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return true;
        };
        if !target_keys.contains(&(name.to_lowercase(), file_size)) {
            return true;
        }
        if let Some(file) = hash_and_index_candidate(db, path, file_size, &mut visited, cancel, started) {
            try_relink_matches(db, &file, &mut pending_by_hash);
        }
        !cancelled(cancel, started)
    });

    // Continue through other audio files in the background, allowing renamed
    // files with a plausible exact byte length to be checked by full SHA-256.
    walk_audio_files(&roots, cancel, started, |path, file_size| {
        if cancelled(cancel, started) || pending_by_hash.is_empty() {
            return false;
        }
        if !target_sizes.contains(&file_size) {
            return true;
        }
        if let Some(file) = hash_and_index_candidate(db, path, file_size, &mut visited, cancel, started) {
            try_relink_matches(db, &file, &mut pending_by_hash);
        }
        !cancelled(cancel, started)
    });
    Ok(())
}

fn try_relink_matches(
    db: &Db,
    file: &IndexedAudioFile,
    pending_by_hash: &mut HashMap<String, Vec<i64>>,
) {
    let hash = file.sha256.to_ascii_lowercase();
    let Some(track_ids) = pending_by_hash.get_mut(&hash) else { return };
    track_ids.retain(|track_id| {
        !matches!(db.resolve_registered_audio_path(Some(*track_id), None, None), Ok(Some(_)))
    });
    if track_ids.is_empty() {
        pending_by_hash.remove(&hash);
    }
}

fn hash_and_index_candidate(
    db: &Db,
    path: &Path,
    file_size: i64,
    visited: &mut HashSet<String>,
    cancel: &AtomicBool,
    started: Instant,
) -> Option<IndexedAudioFile> {
    let path_string = path.to_string_lossy().into_owned();
    let dedupe_key = path_string.to_lowercase();
    if !visited.insert(dedupe_key) || cancelled(cancel, started) {
        return None;
    }
    let (_, before_mtime_ns) = file_stamp(path)?;
    let indexed = db
        .indexed_audio_file_for_stamp(&path_string, file_size, before_mtime_ns)
        .ok()
        .flatten();
    let file = if let Some(indexed) = indexed {
        indexed
    } else {
        let (sha256, stable_size, stable_mtime_ns) = hash_file(path, cancel, started)?;
        if stable_size != file_size {
            return None;
        }
        let file = indexed_file(path, stable_size, stable_mtime_ns, sha256);
        db.index_audio_file(&file).ok()?;
        thread::sleep(FILE_THROTTLE);
        file
    };
    Some(file)
}

fn indexed_file(path: &Path, file_size: i64, file_mtime_ns: i64, sha256: String) -> IndexedAudioFile {
    IndexedAudioFile {
        path: path.to_string_lossy().into_owned(),
        file_name: path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        file_size,
        file_mtime_ns,
        sha256,
    }
}

fn hash_file(path: &Path, cancel: &AtomicBool, started: Instant) -> Option<(String, i64, i64)> {
    let (size_before, mtime_before) = file_stamp(path)?;
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        if cancelled(cancel, started) {
            return None;
        }
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        thread::sleep(HASH_THROTTLE);
    }
    let (size_after, mtime_after) = file_stamp(path)?;
    if (size_before, mtime_before) != (size_after, mtime_after) {
        return None;
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    Some((hex, size_after, mtime_after))
}

fn file_stamp(path: &Path) -> Option<(i64, i64)> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let size = i64::try_from(metadata.len()).ok()?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|delta| i64::try_from(delta.as_nanos()).ok())
        .unwrap_or(0);
    Some((size, modified_ns))
}

fn walk_audio_files(
    roots: &[PathBuf],
    cancel: &AtomicBool,
    started: Instant,
    mut visit: impl FnMut(&Path, i64) -> bool,
) {
    let mut visited_entries = 0_u64;
    'roots: for root in roots {
        if cancelled(cancel, started) || !root.is_dir() {
            continue;
        }
        let walker = WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| should_descend(entry, root));
        for entry in walker {
            if cancelled(cancel, started) || visited_entries >= MAX_ENTRIES_PER_PASS {
                break 'roots;
            }
            let Ok(entry) = entry else { continue };
            visited_entries += 1;
            if !entry.file_type().is_file() || !has_audio_extension(entry.path()) {
                continue;
            }
            let Some((size, _)) = file_stamp(entry.path()) else { continue };
            if !visit(entry.path(), size) {
                break 'roots;
            }
        }
    }
}

fn should_descend(entry: &DirEntry, root: &Path) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if entry.file_type().is_symlink() {
        return false;
    }
    if !entry.file_type().is_dir() {
        return true;
    }
    let Some(name) = entry.file_name().to_str() else { return true };
    let name = name.to_ascii_lowercase();
    let mut excluded = matches!(
        name.as_str(),
        "$recycle.bin"
            | "system volume information"
            | "windows"
            | "program files"
            | "program files (x86)"
            | "programdata"
            | "windowsapps"
            | "$windows.~bt"
            | "node_modules"
            | ".git"
            | ".svn"
    );
    if cfg!(windows) && name == "appdata" && !is_explicit_root(entry.path(), root) {
        excluded = true;
    }
    !excluded
}

fn is_explicit_root(path: &Path, root: &Path) -> bool {
    path == root
}

fn has_audio_extension(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()).is_some_and(|ext| {
        AUDIO_EXTENSIONS.iter().any(|known| ext.eq_ignore_ascii_case(known))
    })
}

fn discover_roots(db: &Db, extra_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(folders) = db.list_library_folders() {
        candidates.extend(folders.into_iter().filter(|folder| folder.enabled).map(|folder| PathBuf::from(folder.path)));
    }
    candidates.extend(extra_roots.iter().cloned());
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        candidates.push(PathBuf::from(profile));
    } else if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home));
    }
    #[cfg(windows)]
    for letter in b'A'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", char::from(letter)));
        if is_local_discovery_drive(&root) {
            candidates.push(root);
        }
    }
    #[cfg(not(windows))]
    {
        for root in [PathBuf::from("/media"), PathBuf::from("/mnt")] {
            if root.is_dir() {
                candidates.push(root);
            }
        }
    }

    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    for candidate in candidates {
        let root = fs::canonicalize(&candidate).unwrap_or(candidate);
        if root.is_dir() && seen.insert(root.to_string_lossy().to_lowercase()) {
            roots.push(root);
        }
    }
    roots
}

#[cfg(windows)]
fn is_local_discovery_drive(root: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;

    // GetDriveTypeW reports 2 for removable and 3 for fixed drives. Skip
    // remote shares so a background recovery pass cannot stall on a network.
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    let path: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `path` is NUL-terminated and remains alive for the call.
    matches!(unsafe { GetDriveTypeW(PCWSTR(path.as_ptr())) }, DRIVE_REMOVABLE | DRIVE_FIXED)
}

#[cfg(not(windows))]
fn is_local_discovery_drive(root: &Path) -> bool {
    root.is_dir()
}

fn cancelled(cancel: &AtomicBool, started: Instant) -> bool {
    cancel.load(Ordering::Relaxed) || started.elapsed() >= MAX_INDEX_DURATION
}
