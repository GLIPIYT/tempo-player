use std::collections::hash_map::DefaultHasher;
use std::fs::{self, OpenOptions};
use std::hash::Hasher;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::tag::{ItemKey, ItemValue, Tag, TagItem, TagType};

use crate::models::{
    OriginalPictureSnapshot, OriginalTagItemSnapshot, OriginalTagSnapshot,
    OriginalTrackMetadataSnapshot, TrackMetadataOriginal,
};

#[derive(Debug)]
pub struct MetaParsed {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub duration_sec: Option<f64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub cover_path: Option<String>,
    pub lyrics: Option<String>,
    /// From ReplayGain tags, when the file carries them. The analyser fills the
    /// gap for everything else.
    pub gain_db: Option<f64>,
    pub peak_db: Option<f64>,
}

const LYRICS_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct EditableMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ArtworkChange {
    Keep,
    Remove,
    Replace { data: Vec<u8>, mime_type: String },
}

#[derive(Debug, Clone)]
pub struct StagedTagWrite {
    pub stage_path: PathBuf,
    pub backup_path: PathBuf,
    pub snapshot: OriginalTrackMetadataSnapshot,
    pub source_stamp: (u64, u128),
    pub stage_stamp: (u64, u128),
}

/// Writes only to a sibling staging copy, then reopens it and verifies every
/// requested field and cover before any operation can touch the original file.
pub fn stage_metadata_edit(
    path: &Path,
    track_id: i64,
    fields: &EditableMetadata,
    artwork: &ArtworkChange,
    covers_dir: &Path,
    artist_id: Option<i64>,
    album_id: Option<i64>,
) -> Result<StagedTagWrite, String> {
    let title = fields.title.trim();
    if title.is_empty() {
        return Err("Track title cannot be empty".into());
    }
    if fields.track_number.is_some_and(|number| number < 1)
        || fields.disc_number.is_some_and(|number| number < 1)
        || fields.year.is_some_and(|year| !(1..=9999).contains(&year))
    {
        return Err("Track number, disc number, or year is outside the supported range".into());
    }

    let source_meta = fs::metadata(path).map_err(|error| format!("cannot access audio file: {error}"))?;
    if !source_meta.is_file() {
        return Err("The selected track is not a file on disk".into());
    }
    let source_stamp = precise_file_stamp(path)?;
    let mut tagged = lofty::read_from_path(path).map_err(|error| format!("cannot read audio tags: {error}"))?;
    let snapshot = snapshot_from_tagged(&tagged, artist_id, album_id);
    if snapshot.tags.iter().any(|tag| tag.tag_type == "Unknown") {
        return Err("This file contains a metadata tag format Tempo cannot safely restore".into());
    }
    ensure_primary_tag(&mut tagged, path)?;

    let (stage_path, backup_path) = staging_paths(path, track_id)?;
    fs::copy(path, &stage_path).map_err(|error| {
        format!("cannot create a safe staging copy beside the audio file: {error}")
    })?;

    let result = (|| {
        let mut staged = lofty::read_from_path(&stage_path)
            .map_err(|error| format!("cannot reopen the staging copy: {error}"))?;
        ensure_primary_tag(&mut staged, path)?;
        write_editable_fields(&mut staged, fields, artwork)?;
        staged
            .save_to_path(&stage_path, WriteOptions::default())
            .map_err(|error| format!("tag writer could not save the staging copy: {error}"))?;
        sync_file(&stage_path)?;
        verify_edit(&stage_path, fields, artwork, covers_dir)?;
        if precise_file_stamp(path)? != source_stamp {
            return Err("The audio file changed while its tags were being edited; no changes were applied".into());
        }
        Ok(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_file(&stage_path);
        return Err(error);
    }

    let stage_stamp = precise_file_stamp(&stage_path)?;
    Ok(StagedTagWrite {
        stage_path,
        backup_path,
        snapshot,
        source_stamp,
        stage_stamp,
    })
}

/// Stages restoration from the immutable first-edit snapshot, verifying the
/// recreated tags and artwork before the original file is moved.
pub fn stage_original_restore(
    path: &Path,
    track_id: i64,
    snapshot: &OriginalTrackMetadataSnapshot,
) -> Result<StagedTagWrite, String> {
    fs::metadata(path).map_err(|error| format!("cannot access audio file: {error}"))?;
    let source_stamp = precise_file_stamp(path)?;
    let (stage_path, backup_path) = staging_paths(path, track_id)?;
    fs::copy(path, &stage_path)
        .map_err(|error| format!("cannot create a safe staging copy beside the audio file: {error}"))?;

    let result = (|| {
        restore_snapshot_to_staging_file(&stage_path, snapshot)?;
        sync_file(&stage_path)?;
        verify_snapshot(&stage_path, snapshot)?;
        if precise_file_stamp(path)? != source_stamp {
            return Err("The audio file changed while its original tags were being restored; no changes were applied".into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&stage_path);
        return Err(error);
    }

    let stage_stamp = precise_file_stamp(&stage_path)?;
    Ok(StagedTagWrite {
        stage_path,
        backup_path,
        snapshot: snapshot.clone(),
        source_stamp,
        stage_stamp,
    })
}

/// Moves the source out of the way and installs the verified staging file.
/// Both renames are on the same volume; the database journal lets startup roll
/// back the backup if the process stops between them.
pub fn install_staged_write(path: &Path, staged: &StagedTagWrite) -> Result<(), String> {
    if staged.backup_path.exists() {
        return Err("A recovery backup already exists for this edit; restart Tempo to recover it before retrying".into());
    }
    if precise_file_stamp(path)? != staged.source_stamp {
        return Err("The audio file changed after it was read; refresh the library and try again".into());
    }
    fs::rename(path, &staged.backup_path).map_err(|error| {
        format!("cannot move the original audio file to its recovery backup (it may be in use or read-only): {error}")
    })?;
    if precise_file_stamp(&staged.backup_path)? != staged.source_stamp {
        return match fs::rename(&staged.backup_path, path) {
            Ok(()) => Err("The audio file changed while the edit was being committed; the changed original was put back".into()),
            Err(error) => Err(format!(
                "The audio file changed while the edit was being committed and could not be put back; recover it from {} ({error})",
                staged.backup_path.display()
            )),
        };
    }
    if let Err(install_error) = fs::rename(&staged.stage_path, path) {
        match fs::rename(&staged.backup_path, path) {
            Ok(()) => Err(format!("cannot install the edited file; the original was restored: {install_error}")),
            Err(rollback_error) => Err(format!(
                "cannot install the edited file ({install_error}); the original remains recoverable at {} ({rollback_error})",
                staged.backup_path.display()
            )),
        }
    } else {
        Ok(())
    }
}

/// Rolls back an uncommitted file replacement, including after a process restart.
pub fn recover_file_edit(
    path: &Path,
    stage_path: &Path,
    backup_path: &Path,
    source_stamp: (u64, u128),
    stage_stamp: (u64, u128),
) -> Result<(), String> {
    if backup_path.exists() {
        // Validate the only untouched copy before removing the installed file.
        // Otherwise a damaged/replaced backup could turn recovery into data loss.
        if precise_file_stamp(backup_path)? != source_stamp {
            return Err(format!(
                "the recovery backup for {} changed unexpectedly and was left at {}",
                path.display(),
                backup_path.display()
            ));
        }
        if stage_path.exists() && precise_file_stamp(stage_path)? != stage_stamp {
            return Err(format!(
                "the staging file for {} changed unexpectedly and was left at {}",
                path.display(),
                stage_path.display()
            ));
        }
        if path.exists() {
            if precise_file_stamp(path)? != stage_stamp {
                return Err(format!(
                    "the audio file changed after the interrupted edit; the original backup is preserved at {}",
                    backup_path.display()
                ));
            }
            fs::remove_file(path).map_err(|error| {
                format!("cannot remove the uncommitted edited file at {}: {error}", path.display())
            })?;
        }
        fs::rename(backup_path, path).map_err(|error| {
            format!("cannot restore the recovery backup {}: {error}", backup_path.display())
        })?;
        if precise_file_stamp(path)? != source_stamp {
            return Err(format!(
                "the restored source for {} did not match its recovery stamp",
                path.display()
            ));
        }
    } else if path.exists() && stage_path.exists() {
        // The source rename never happened, so preserve whatever is currently
        // at the source path and discard only our verified staging copy.
        if precise_file_stamp(stage_path)? != stage_stamp {
            return Err(format!(
                "the staging file for {} changed unexpectedly and was left at {}",
                path.display(),
                stage_path.display()
            ));
        }
    } else if path.exists() && precise_file_stamp(path)? == source_stamp {
        // Recovery already restored the source, but the process may have stopped
        // before clearing the database journal. Treat this as completed recovery.
    } else {
        return Err(format!(
            "cannot safely recover the interrupted metadata edit for {}; source/backup/staging files are incomplete",
            path.display()
        ));
    }
    if stage_path.exists() {
        if precise_file_stamp(stage_path)? != stage_stamp {
            return Err(format!(
                "the staging file for {} changed unexpectedly and was left at {}",
                path.display(),
                stage_path.display()
            ));
        }
        fs::remove_file(stage_path)
            .map_err(|error| format!("cannot remove the abandoned staging file: {error}"))?;
    }
    Ok(())
}

pub fn remove_staging_file(path: &Path) {
    let _ = fs::remove_file(path);
}

fn editable_keys() -> [(&'static str, ItemKey); 8] {
    [
        ("TrackTitle", ItemKey::TrackTitle),
        ("TrackArtist", ItemKey::TrackArtist),
        ("AlbumTitle", ItemKey::AlbumTitle),
        ("AlbumArtist", ItemKey::AlbumArtist),
        ("TrackNumber", ItemKey::TrackNumber),
        ("DiscNumber", ItemKey::DiscNumber),
        ("Year", ItemKey::Year),
        ("Genre", ItemKey::Genre),
    ]
}

fn snapshot_from_tagged(
    tagged: &TaggedFile,
    artist_id: Option<i64>,
    album_id: Option<i64>,
) -> OriginalTrackMetadataSnapshot {
    let primary = tagged.primary_tag().or_else(|| tagged.first_tag());
    let fields = TrackMetadataOriginal {
        title: clean_string(primary.and_then(|tag| tag.get_string(&ItemKey::TrackTitle))),
        artist: clean_string(primary.and_then(|tag| tag.get_string(&ItemKey::TrackArtist))),
        album: clean_string(primary.and_then(|tag| tag.get_string(&ItemKey::AlbumTitle))),
        album_artist: clean_string(primary.and_then(|tag| tag.get_string(&ItemKey::AlbumArtist))),
        track_number: clean_string(primary.and_then(|tag| tag.get_string(&ItemKey::TrackNumber))),
        disc_number: clean_string(primary.and_then(|tag| tag.get_string(&ItemKey::DiscNumber))),
        year: clean_string(primary.and_then(|tag| tag.get_string(&ItemKey::Year))),
        genre: clean_string(primary.and_then(|tag| tag.get_string(&ItemKey::Genre))),
        artist_id,
        album_id,
        has_embedded_artwork: tagged.tags().iter().any(|tag| !tag.pictures().is_empty()),
    };
    let tags = tagged.tags().iter().map(snapshot_tag).collect();
    OriginalTrackMetadataSnapshot { fields, tags }
}

fn snapshot_tag(tag: &Tag) -> OriginalTagSnapshot {
    let mut items = Vec::new();
    for (key_name, key) in editable_keys() {
        for item in tag.items().filter(|item| item.key() == &key) {
            let (value_kind, text, binary) = match item.value() {
                ItemValue::Text(value) => ("text", Some(value.clone()), None),
                ItemValue::Locator(value) => ("locator", Some(value.clone()), None),
                ItemValue::Binary(value) => ("binary", None, Some(value.clone())),
            };
            items.push(OriginalTagItemSnapshot {
                key: key_name.to_string(),
                value_kind: value_kind.to_string(),
                text,
                binary,
                lang: *item.lang(),
                description: item.description().to_string(),
            });
        }
    }
    let pictures = tag
        .pictures()
        .iter()
        .enumerate()
        .map(|(position, picture)| OriginalPictureSnapshot {
            tag_type: tag_type_name(tag.tag_type()).to_string(),
            position: position as i64,
            picture_type: picture.pic_type().as_u8(),
            mime_type: picture.mime_type().map(|mime| mime.as_str().to_string()),
            description: picture.description().map(str::to_string),
            data: picture.data().to_vec(),
        })
        .collect();
    OriginalTagSnapshot {
        tag_type: tag_type_name(tag.tag_type()).to_string(),
        items,
        pictures,
    }
}

fn ensure_primary_tag(tagged: &mut TaggedFile, path: &Path) -> Result<(), String> {
    let tag_type = tagged.primary_tag_type();
    if !tagged.supports_tag_type(tag_type) {
        return Err(format!(
            "{} does not support writable {:?} metadata",
            path.display(),
            tag_type
        ));
    }
    if !tagged.contains_tag_type(tag_type) {
        let _ = tagged.insert_tag(Tag::new(tag_type));
        if !tagged.contains_tag_type(tag_type) {
            return Err(format!("cannot create a writable {:?} tag", tag_type));
        }
    }
    Ok(())
}

fn write_editable_fields(
    tagged: &mut TaggedFile,
    fields: &EditableMetadata,
    artwork: &ArtworkChange,
) -> Result<(), String> {
    let primary_type = tagged.primary_tag_type();
    let values = [
        (ItemKey::TrackTitle, Some(fields.title.trim().to_string())),
        (ItemKey::TrackArtist, normalize_optional(fields.artist.as_deref())),
        (ItemKey::AlbumTitle, normalize_optional(fields.album.as_deref())),
        (ItemKey::AlbumArtist, normalize_optional(fields.album_artist.as_deref())),
        (ItemKey::TrackNumber, fields.track_number.map(|value| value.to_string())),
        (ItemKey::DiscNumber, fields.disc_number.map(|value| value.to_string())),
        (ItemKey::Year, fields.year.map(|value| value.to_string())),
        (ItemKey::Genre, normalize_optional(fields.genre.as_deref())),
    ];
    let tag_types: Vec<TagType> = tagged.tags().iter().map(Tag::tag_type).collect();
    for tag_type in tag_types {
        let tag = tagged
            .tag_mut(tag_type)
            .ok_or_else(|| format!("tag {:?} disappeared while preparing the edit", tag_type))?;
        for (key, value) in &values {
            let had_value = tag.items().any(|item| item.key() == key);
            match value {
                Some(text) => {
                    if !tag.insert_text(key.clone(), text.clone()) && (had_value || tag_type == primary_type) {
                        return Err(format!(
                            "tag {:?} cannot store the requested {:?} field",
                            tag_type, key
                        ));
                    }
                }
                None => tag.remove_key(key),
            }
        }

    }
    match artwork {
        ArtworkChange::Keep => {}
        ArtworkChange::Remove | ArtworkChange::Replace { .. } => {
            for tag_type in tagged.tags().iter().map(Tag::tag_type).collect::<Vec<_>>() {
                if let Some(tag) = tagged.tag_mut(tag_type) {
                    clear_pictures(tag);
                }
            }
            if let ArtworkChange::Replace { data, mime_type } = artwork {
                let tag = tagged
                    .tag_mut(primary_type)
                    .ok_or_else(|| "the primary tag is unavailable for artwork".to_string())?;
                let mime = MimeType::from_str(mime_type);
                tag.push_picture(Picture::new_unchecked(
                    PictureType::CoverFront,
                    Some(mime),
                    None,
                    data.clone(),
                ));
            }
        }
    }
    Ok(())
}

fn clear_pictures(tag: &mut Tag) {
    while tag.picture_count() > 0 {
        let _ = tag.remove_picture(0);
    }
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

fn verify_edit(
    path: &Path,
    fields: &EditableMetadata,
    artwork: &ArtworkChange,
    covers_dir: &Path,
) -> Result<(), String> {
    let metadata = read_metadata(path, covers_dir)
        .map_err(|error| format!("cannot verify tags after writing the staging copy: {error}"))?;
    let expected_artist = normalize_optional(fields.artist.as_deref());
    let expected_album = normalize_optional(fields.album.as_deref());
    let expected_album_artist = normalize_optional(fields.album_artist.as_deref());
    let expected_genre = normalize_optional(fields.genre.as_deref());
    if metadata.title.as_deref() != Some(fields.title.trim())
        || metadata.artist != expected_artist
        || metadata.album != expected_album
        || metadata.album_artist != expected_album_artist
        || metadata.track_number != fields.track_number
        || metadata.disc_number != fields.disc_number
        || metadata.year != fields.year
        || metadata.genre != expected_genre
    {
        return Err("The tag writer did not preserve the requested values; the original file was left untouched".into());
    }
    match artwork {
        ArtworkChange::Keep => {}
        ArtworkChange::Remove => {
            let tagged = lofty::read_from_path(path).map_err(|error| error.to_string())?;
            if tagged.tags().iter().any(|tag| !tag.pictures().is_empty()) {
                return Err("The tag writer did not remove the embedded cover; the original file was left untouched".into());
            }
        }
        ArtworkChange::Replace { data, .. } => {
            let tagged = lofty::read_from_path(path).map_err(|error| error.to_string())?;
            let has_expected_picture = tagged
                .primary_tag()
                .is_some_and(|tag| tag.pictures().iter().any(|picture| picture.data() == data));
            if !has_expected_picture {
                return Err("The tag writer did not embed the selected cover; the original file was left untouched".into());
            }
        }
    }
    Ok(())
}

fn restore_snapshot_to_staging_file(
    path: &Path,
    snapshot: &OriginalTrackMetadataSnapshot,
) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|error| format!("cannot read staging tags: {error}"))?;
    let saved_types: Vec<TagType> = snapshot
        .tags
        .iter()
        .map(|tag| parse_tag_type(&tag.tag_type))
        .collect::<Result<_, _>>()?;
    let existing_types: Vec<TagType> = tagged.tags().iter().map(Tag::tag_type).collect();
    let types_to_remove: Vec<TagType> = existing_types
        .iter()
        .copied()
        .filter(|tag_type| !saved_types.contains(tag_type))
        .collect();

    for tag in &snapshot.tags {
        let tag_type = parse_tag_type(&tag.tag_type)?;
        if !tagged.supports_tag_type(tag_type) {
            return Err(format!("the current file format cannot restore its original {:?} tag", tag_type));
        }
        if !tagged.contains_tag_type(tag_type) {
            let _ = tagged.insert_tag(Tag::new(tag_type));
            if !tagged.contains_tag_type(tag_type) {
                return Err(format!("cannot recreate the original {:?} tag", tag_type));
            }
        }
        let target = tagged.tag_mut(tag_type).expect("tag inserted or already present");
        restore_tag_items(target, &tag.items)?;
        clear_pictures(target);
        let mut pictures = tag.pictures.clone();
        pictures.sort_by_key(|picture| picture.position);
        for picture in pictures {
            let mime = picture.mime_type.as_deref().map(MimeType::from_str);
            target.push_picture(Picture::new_unchecked(
                PictureType::from_u8(picture.picture_type),
                mime,
                picture.description,
                picture.data,
            ));
        }
    }

    for tag_type in &types_to_remove {
        tag_type
            .remove_from_path(path)
            .map_err(|error| format!("cannot remove the edit-created {:?} tag: {error}", tag_type))?;
        let _ = tagged.remove(*tag_type);
    }
    if !tagged.tags().is_empty() {
        tagged
            .save_to_path(path, WriteOptions::default())
            .map_err(|error| format!("cannot write the original tags to the staging copy: {error}"))?;
    }
    Ok(())
}

fn restore_tag_items(tag: &mut Tag, items: &[OriginalTagItemSnapshot]) -> Result<(), String> {
    for (_, key) in editable_keys() {
        tag.remove_key(&key);
    }
    for item in items {
        let key = parse_item_key(&item.key)
            .ok_or_else(|| format!("the original tag contains an unsupported key {}", item.key))?;
        let value = match item.value_kind.as_str() {
            "text" => ItemValue::Text(item.text.clone().unwrap_or_default()),
            "locator" => ItemValue::Locator(item.text.clone().unwrap_or_default()),
            "binary" => ItemValue::Binary(item.binary.clone().unwrap_or_default()),
            other => return Err(format!("the original tag has an unsupported value type {other}")),
        };
        let mut restored = TagItem::new(key, value);
        restored.set_lang(item.lang);
        if !item.description.is_empty() {
            restored.set_description(item.description.clone());
        }
        if !tag.push(restored) {
            return Err(format!("the target format cannot restore original {} metadata", item.key));
        }
    }
    Ok(())
}

fn verify_snapshot(path: &Path, snapshot: &OriginalTrackMetadataSnapshot) -> Result<(), String> {
    let tagged = lofty::read_from_path(path)
        .map_err(|error| format!("cannot reread the restored staging copy: {error}"))?;
    let mut actual: Vec<OriginalTagSnapshot> = tagged.tags().iter().map(snapshot_tag).collect();
    let mut expected = snapshot.tags.clone();
    actual.sort_by(|left, right| left.tag_type.cmp(&right.tag_type));
    expected.sort_by(|left, right| left.tag_type.cmp(&right.tag_type));
    if actual != expected {
        return Err("restored tag values or embedded artwork differ from the original snapshot; the original file was left untouched".into());
    }
    Ok(())
}

fn parse_item_key(name: &str) -> Option<ItemKey> {
    editable_keys()
        .into_iter()
        .find(|(candidate, _)| *candidate == name)
        .map(|(_, key)| key)
}

fn tag_type_name(tag_type: TagType) -> &'static str {
    match tag_type {
        TagType::Ape => "Ape",
        TagType::Id3v1 => "Id3v1",
        TagType::Id3v2 => "Id3v2",
        TagType::Mp4Ilst => "Mp4Ilst",
        TagType::VorbisComments => "VorbisComments",
        TagType::RiffInfo => "RiffInfo",
        TagType::AiffText => "AiffText",
        _ => "Unknown",
    }
}

fn parse_tag_type(name: &str) -> Result<TagType, String> {
    match name {
        "Ape" => Ok(TagType::Ape),
        "Id3v1" => Ok(TagType::Id3v1),
        "Id3v2" => Ok(TagType::Id3v2),
        "Mp4Ilst" => Ok(TagType::Mp4Ilst),
        "VorbisComments" => Ok(TagType::VorbisComments),
        "RiffInfo" => Ok(TagType::RiffInfo),
        "AiffText" => Ok(TagType::AiffText),
        _ => Err(format!("the original tag type {name} is not supported for restoration")),
    }
}

fn staging_paths(path: &Path, track_id: i64) -> Result<(PathBuf, PathBuf), String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .ok_or_else(|| "the audio file has no supported extension".to_string())?;
    let parent = path.parent().ok_or_else(|| "the audio file has no parent directory".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let stem = format!(".tempo-meta-{track_id}-{}-{nonce}", std::process::id());
    Ok((
        parent.join(format!("{stem}.stage.{extension}")),
        parent.join(format!("{stem}.backup")),
    ))
}

pub fn precise_file_stamp(path: &Path) -> Result<(u64, u128), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("cannot inspect audio file: {error}"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    Ok((metadata.len(), modified))
}

fn sync_file(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("cannot flush the staged audio file: {error}"))
}

pub fn read_metadata(path: &Path, covers_dir: &Path) -> Result<MetaParsed, String> {
    let tagged = lofty::read_from_path(path).map_err(|err| err.to_string())?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let title = clean_string(tag.and_then(|t| t.get_string(&ItemKey::TrackTitle)));
    let artist = clean_string(tag.and_then(|t| t.get_string(&ItemKey::TrackArtist)));
    let album = clean_string(tag.and_then(|t| t.get_string(&ItemKey::AlbumTitle)));
    let album_artist = clean_string(tag.and_then(|t| t.get_string(&ItemKey::AlbumArtist)));
    let genre = clean_string(tag.and_then(|t| t.get_string(&ItemKey::Genre)));
    let track_number = tag
        .and_then(|t| t.get_string(&ItemKey::TrackNumber))
        .and_then(parse_number);
    let disc_number = tag
        .and_then(|t| t.get_string(&ItemKey::DiscNumber))
        .and_then(parse_number);
    let year = tag
        .and_then(|t| t.get_string(&ItemKey::Year))
        .and_then(|value| value.trim().parse::<i64>().ok());
    let seconds = tagged.properties().duration().as_secs_f64();
    let duration_sec = if seconds > 0.0 { Some(seconds) } else { None };
    let cover_path = tag.and_then(|t| store_largest_picture(t, covers_dir));
    let lyrics = clean_string(tag.and_then(|t| t.get_string(&ItemKey::Lyrics))).map(cap_lyrics);
    let gain_db = parse_gain_db(tag.and_then(|t| t.get_string(&ItemKey::ReplayGainTrackGain)));
    let peak_db = parse_peak_db(tag.and_then(|t| t.get_string(&ItemKey::ReplayGainTrackPeak)));

    Ok(MetaParsed {
        title,
        artist,
        album,
        album_artist,
        track_number,
        disc_number,
        duration_sec,
        year,
        genre,
        cover_path,
        lyrics,
        gain_db,
        peak_db,
    })
}

/// ReplayGain tags are free-form strings; the gain is normally written as
/// "-7.25 dB", so only the leading number is taken.
fn parse_gain_db(value: Option<&str>) -> Option<f64> {
    let number = value?.trim().split_whitespace().next()?.parse::<f64>().ok()?;
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

/// The peak tag is a bare linear ratio (e.g. "0.987654"), stored here in dBFS so
/// the frontend can cap a boost without knowing about the tag's format.
fn parse_peak_db(value: Option<&str>) -> Option<f64> {
    let linear = value?.trim().split_whitespace().next()?.parse::<f64>().ok()?;
    if !linear.is_finite() || linear <= 0.0 {
        return None;
    }
    Some(20.0 * linear.log10())
}

fn clean_string(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn cap_lyrics(value: String) -> String {
    if value.len() <= LYRICS_MAX_BYTES {
        return value;
    }
    let mut end = LYRICS_MAX_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn parse_number(value: &str) -> Option<i64> {
    value.split('/').next()?.trim().parse::<i64>().ok()
}

fn store_largest_picture(tag: &Tag, covers_dir: &Path) -> Option<String> {
    let picture = tag.pictures().iter().max_by_key(|picture| picture.data().len())?;
    store_cover_bytes(covers_dir, picture.data(), picture.mime_type())
}

fn store_cover_bytes(
    covers_dir: &Path,
    data: &[u8],
    mime_type: Option<&MimeType>,
) -> Option<String> {
    if data.is_empty() {
        return None;
    }
    let extension = match mime_type {
        Some(MimeType::Png) => "png",
        _ => "jpg",
    };
    let mut hasher = DefaultHasher::new();
    hasher.write(data);
    let target = covers_dir.join(format!("{:016x}.{}", hasher.finish(), extension));
    if !target.exists() {
        fs::write(&target, data).ok()?;
    }
    Some(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{parse_gain_db, parse_peak_db};

    #[test]
    fn gain_accepts_the_usual_unit_suffix() {
        assert_eq!(parse_gain_db(Some("-7.25 dB")), Some(-7.25));
        assert_eq!(parse_gain_db(Some("+3.0 dB")), Some(3.0));
        // some taggers write a bare number
        assert_eq!(parse_gain_db(Some("-1.5")), Some(-1.5));
    }

    #[test]
    fn gain_rejects_junk_instead_of_defaulting_to_zero() {
        assert_eq!(parse_gain_db(None), None);
        assert_eq!(parse_gain_db(Some("")), None);
        assert_eq!(parse_gain_db(Some("loud")), None);
        assert_eq!(parse_gain_db(Some("inf")), None);
    }

    #[test]
    fn peak_is_a_linear_ratio_converted_to_dbfs() {
        // full scale
        let full = parse_peak_db(Some("1.0")).unwrap();
        assert!(full.abs() < 1e-9, "expected 0 dBFS, got {full}");
        // half amplitude is about -6 dBFS
        let half = parse_peak_db(Some("0.5")).unwrap();
        assert!((half + 6.0206).abs() < 0.001, "expected -6.02, got {half}");
        assert_eq!(parse_peak_db(Some("0")), None);
        assert_eq!(parse_peak_db(None), None);
    }
}
