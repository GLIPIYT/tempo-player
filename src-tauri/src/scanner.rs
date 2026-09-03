use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use walkdir::WalkDir;

use crate::metadata::{self, MetaParsed};
use crate::models::{FileStamp, TrackInput};

pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav"];

#[derive(Debug)]
pub struct Tick {
    pub scanned_files: u32,
    pub current_file: Option<String>,
}

#[derive(Debug)]
pub struct ScanOutcome {
    pub new: Vec<TrackInput>,
    pub updated: Vec<TrackInput>,
    pub removed: Vec<String>,
    pub unchanged: u32,
    pub errors: u32,
    pub scanned_files: u32,
}

pub fn collect_audio_files(root: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(walkdir::DirEntry::into_path)
        .filter(|path| has_audio_extension(path))
        .collect();
    files.sort();
    files
}

pub fn scan_incremental(
    root: &Path,
    folder_id: i64,
    known_stamps: &HashMap<String, FileStamp>,
    hidden_paths: &HashSet<String>,
    covers_dir: &Path,
    on_tick: &dyn Fn(Tick),
) -> ScanOutcome {
    let _ = fs::create_dir_all(covers_dir);

    let mut outcome = ScanOutcome {
        new: Vec::new(),
        updated: Vec::new(),
        removed: Vec::new(),
        unchanged: 0,
        errors: 0,
        scanned_files: 0,
    };
    let mut seen: HashSet<String> = HashSet::new();

    for path in collect_audio_files(root) {
        let path_string = path.to_string_lossy().into_owned();
        // Blacklisted files are walked past entirely - not counted, not stamped, and
        // never handed to the metadata reader. `hidden_paths` is pre-lowercased
        // because Windows paths differ only in casing between scans.
        if !hidden_paths.is_empty() && hidden_paths.contains(&path_string.to_lowercase()) {
            continue;
        }
        let title_fallback = fallback_title(&path);
        outcome.scanned_files += 1;
        on_tick(Tick {
            scanned_files: outcome.scanned_files,
            current_file: Some(path_string.clone()),
        });
        seen.insert(path_string.clone());

        let (file_size, modified_at) = read_stamp(&path);
        if known_stamps
            .get(&path_string)
            .is_some_and(|stamp| stamp.size == file_size && stamp.mtime == modified_at)
        {
            outcome.unchanged += 1;
            continue;
        }

        let was_known = known_stamps.contains_key(&path_string);
        let input = match metadata::read_metadata(&path, covers_dir) {
            Ok(meta) => {
                build_track_input(path_string, folder_id, meta, title_fallback, file_size, modified_at)
            }
            Err(_) => {
                outcome.errors += 1;
                build_fallback_input(path_string, folder_id, title_fallback, file_size, modified_at)
            }
        };
        if was_known {
            outcome.updated.push(input);
        } else {
            outcome.new.push(input);
        }
    }

    let mut removed: Vec<String> = known_stamps
        .keys()
        .filter(|key| !seen.contains(*key))
        .cloned()
        .collect();
    removed.sort();
    outcome.removed = removed;
    outcome
}

fn has_audio_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            AUDIO_EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
        })
}

fn read_stamp(path: &Path) -> (i64, i64) {
    match fs::metadata(path) {
        Ok(meta) => {
            let size = meta.len() as i64;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|delta| delta.as_secs() as i64)
                .unwrap_or(0);
            (size, mtime)
        }
        Err(_) => (0, 0),
    }
}

fn fallback_title(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn build_track_input(
    path: String,
    folder_id: i64,
    meta: MetaParsed,
    title_fallback: String,
    file_size: i64,
    modified_at: i64,
) -> TrackInput {
    TrackInput {
        path,
        folder_id,
        title: meta.title.unwrap_or(title_fallback),
        artist: meta.artist,
        album: meta.album,
        album_artist: meta.album_artist,
        track_number: meta.track_number,
        disc_number: meta.disc_number,
        duration_sec: meta.duration_sec,
        year: meta.year,
        genre: meta.genre,
        cover_path: meta.cover_path,
        file_size,
        modified_at,
        lyrics: meta.lyrics,
    }
}

fn build_fallback_input(
    path: String,
    folder_id: i64,
    title: String,
    file_size: i64,
    modified_at: i64,
) -> TrackInput {
    TrackInput {
        path,
        folder_id,
        title,
        artist: None,
        album: None,
        album_artist: None,
        track_number: None,
        disc_number: None,
        duration_sec: None,
        year: None,
        genre: None,
        cover_path: None,
        file_size,
        modified_at,
        lyrics: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_root(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|delta| delta.subsec_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "tempo_scan_{}_{}_{}",
            std::process::id(),
            nanos,
            label
        ))
    }

    fn place_file(path: &Path, contents: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn stamp_of(path: &Path) -> FileStamp {
        let meta = fs::metadata(path).unwrap();
        FileStamp {
            size: meta.len() as i64,
            mtime: meta
                .modified()
                .unwrap()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
        }
    }

    #[test]
    fn collect_audio_files_returns_only_audio_sorted() {
        let root = unique_temp_root("collect");
        place_file(&root.join("b.flac"), b"flac");
        place_file(&root.join("notes.txt"), b"text");
        place_file(&root.join("nested").join("c.mp3"), b"mp3");
        place_file(&root.join("a.mp3"), b"mp3");

        let found = collect_audio_files(&root);

        assert_eq!(
            found,
            vec![
                root.join("a.mp3"),
                root.join("b.flac"),
                root.join("nested").join("c.mp3"),
            ]
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_incremental_skips_files_with_matching_stamps() {
        let root = unique_temp_root("skip");
        let first = root.join("first.mp3");
        let second = root.join("second.mp3");
        place_file(&first, b"definitely not audio");
        place_file(&second, b"also not audio");

        let mut known: HashMap<String, FileStamp> = HashMap::new();
        for path in [&first, &second] {
            known.insert(path.to_string_lossy().into_owned(), stamp_of(path));
        }

        let outcome = scan_incremental(&root, 7, &known, &HashSet::new(), &root.join("covers"), &|_| {});

        assert_eq!(outcome.scanned_files, 2);
        assert_eq!(outcome.unchanged, 2);
        assert_eq!(outcome.errors, 0);
        assert!(outcome.new.is_empty());
        assert!(outcome.updated.is_empty());
        assert!(outcome.removed.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_incremental_reports_missing_paths_as_removed() {
        let root = unique_temp_root("removed");
        let survivor = root.join("survivor.mp3");
        let deleted = root.join("deleted.mp3");
        place_file(&survivor, b"still here");
        place_file(&deleted, b"about to vanish");

        let mut known: HashMap<String, FileStamp> = HashMap::new();
        for path in [&survivor, &deleted] {
            known.insert(path.to_string_lossy().into_owned(), stamp_of(path));
        }

        fs::remove_file(&deleted).unwrap();
        place_file(&survivor, b"content changed so this stamp no longer matches");

        let deleted_string = deleted.to_string_lossy().into_owned();
        let outcome = scan_incremental(&root, 9, &known, &HashSet::new(), &root.join("covers"), &|_| {});

        assert_eq!(outcome.removed, vec![deleted_string]);
        assert_eq!(outcome.scanned_files, 1);
        assert_eq!(outcome.unchanged, 0);
        assert_eq!(outcome.errors, 1);
        assert_eq!(outcome.updated.len(), 1);
        assert_eq!(outcome.updated[0].title, "survivor");
        assert_eq!(outcome.updated[0].folder_id, 9);
        assert!(outcome.updated[0].cover_path.is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_incremental_walks_past_hidden_paths() {
        let root = unique_temp_root("hidden");
        let wanted = root.join("keeper.mp3");
        let junk = root.join("Junk Noise.mp3");
        place_file(&wanted, b"not audio either");
        place_file(&junk, b"blacklisted");

        // stored lowercased, and with different casing than on disk, because that is
        // exactly what a Windows rescan hands us
        let hidden: HashSet<String> =
            [junk.to_string_lossy().to_lowercase()].into_iter().collect();

        let outcome = scan_incremental(&root, 3, &HashMap::new(), &hidden, &root.join("covers"), &|_| {});

        assert_eq!(outcome.scanned_files, 1);
        assert_eq!(outcome.new.len(), 1);
        assert_eq!(outcome.new[0].title, "keeper");
        assert!(outcome.removed.is_empty());

        let _ = fs::remove_dir_all(&root);
    }
}
