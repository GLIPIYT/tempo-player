use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::Hasher;
use std::path::Path;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::MimeType;
use lofty::tag::{ItemKey, Tag};

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
}

const LYRICS_MAX_BYTES: usize = 64 * 1024;

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
    })
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
