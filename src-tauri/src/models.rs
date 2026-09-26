use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    pub id: i64,
    pub path: String,
    pub enabled: bool,
    pub added_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: i64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: i64,
    pub title: String,
    pub artist_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_name: Option<String>,
    pub year: Option<i64>,
    pub cover_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist_id: Option<i64>,
    pub artist_name: Option<String>,
    pub album_id: Option<i64>,
    pub album_title: Option<String>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub duration_sec: Option<f64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub cover_path: Option<String>,
    pub file_size: i64,
    pub modified_at: i64,
    pub added_at: i64,
    pub source: String,
    pub external_id: Option<String>,
    pub last_played_at: Option<i64>,
    pub play_count: i64,
    pub skip_count: i64,
    /// Loudness correction in dB, positive to lift a quiet track. Null means the
    /// track has neither ReplayGain tags nor an analyser measurement yet.
    pub gain_db: Option<f64>,
    /// Peak level in dBFS, used to cap a boost so nothing clips.
    pub peak_db: Option<f64>,
}

/// Library item whose artwork can be used for a local track's embedded cover.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LibraryElementKind {
    Track,
    Album,
    Artist,
    Playlist,
}

/// Explicit cover action. `Keep` is distinct from `Remove`, so ordinary edits
/// never erase artwork accidentally.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum TrackArtworkEdit {
    Keep,
    Remove,
    FromLocalPath { path: String },
    CopyFromLibrary { kind: LibraryElementKind, id: i64 },
}

/// The editable tag fields and entity links selected in the track editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetadataEditRequest {
    pub track_id: i64,
    /// File stamps shown when the editor opened. Nanoseconds are text at the
    /// frontend boundary to avoid JavaScript's lossy integer conversion.
    pub expected_file_size: i64,
    pub expected_file_mtime_ns: String,
    pub title: String,
    pub artist_id: Option<i64>,
    pub album_id: Option<i64>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub artwork: TrackArtworkEdit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetadataEditorState {
    pub file_size: i64,
    pub modified_at_ns: String,
    pub original: Option<TrackMetadataOriginal>,
}

/// Original values exposed to the UI. The embedded bytes remain in SQLite and
/// are only read by the restore command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetadataOriginal {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<String>,
    pub disc_number: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub artist_id: Option<i64>,
    pub album_id: Option<i64>,
    pub has_embedded_artwork: bool,
}

/// SQLite snapshot used to restore the original writable fields and every
/// embedded picture without keeping a second copy of the audio stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalTrackMetadataSnapshot {
    pub fields: TrackMetadataOriginal,
    pub tags: Vec<OriginalTagSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalTagSnapshot {
    pub tag_type: String,
    pub items: Vec<OriginalTagItemSnapshot>,
    pub pictures: Vec<OriginalPictureSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalTagItemSnapshot {
    pub key: String,
    pub value_kind: String,
    pub text: Option<String>,
    pub binary: Option<Vec<u8>>,
    pub lang: [u8; 3],
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalPictureSnapshot {
    pub tag_type: String,
    pub position: i64,
    pub picture_type: u8,
    pub mime_type: Option<String>,
    pub description: Option<String>,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin_order: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_likes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub position: i64,
    pub added_at: i64,
    pub track: Track,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistPlayStat {
    pub playlist_id: i64,
    pub play_count: i64,
    pub last_played_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumDetail {
    pub album: Album,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistDetail {
    pub artist: Artist,
    pub albums: Vec<Album>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub tracks: Vec<Track>,
    pub albums: Vec<Album>,
    pub artists: Vec<Artist>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanPhase {
    Started,
    Progress,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: ScanPhase,
    pub scanned_files: u32,
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub unchanged: u32,
    pub errors: u32,
    pub current_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub scanned_files: u32,
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub unchanged: u32,
    pub errors: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct FileStamp {
    pub size: i64,
    pub mtime_ns: i64,
}

#[derive(Debug, Clone)]
pub struct TrackInput {
    pub path: String,
    pub folder_id: i64,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub duration_sec: Option<f64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub cover_path: Option<String>,
    pub file_size: i64,
    pub modified_at: i64,
    pub modified_at_ns: i64,
    pub lyrics: Option<String>,
    /// Read from ReplayGain tags when present; the analyser covers the rest.
    pub gain_db: Option<f64>,
    pub peak_db: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessJob {
    pub id: i64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryDto {
    pub id: i64,
    pub track_id: i64,
    pub played_at: i64,
    pub start_sec: Option<f64>,
    pub listened_sec: Option<f64>,
    pub completed: bool,
    pub skipped: bool,
    pub track: Track,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSummary {
    pub total_minutes: f64,
    pub plays: i64,
    pub unique_artists: i64,
    pub avg_completion_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopTrackItem {
    pub track: Track,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopArtistItem {
    pub artist: Artist,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsData {
    pub summary: StatsSummary,
    pub top_tracks: Vec<TopTrackItem>,
    pub top_artists: Vec<TopArtistItem>,
    pub recent: Vec<HistoryEntryDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyMinutes {
    pub date: String,
    pub minutes: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoversCacheInfo {
    pub path: String,
    pub total_bytes: i64,
    pub file_count: i64,
}

/// A local file the user removed from the library. Keyed by path rather than by
/// track id, so the entry survives a rescan and a folder being re-added.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenTrack {
    pub path: String,
    pub title: Option<String>,
    pub added_at: i64,
}

/// One slot in the sidebar's favorites order. `kind` is "playlist", "artist" or
/// "album" and `ref_id` points into that kind's table without being a foreign
/// key, so an id that no longer resolves is simply skipped by readers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteOrderEntry {
    pub kind: String,
    pub ref_id: i64,
}

/// The lyrics the user pinned to a track. `source_artist`/`source_title` are what
/// was searched for, not the track's own tags - the whole point of pinning is that
/// the two can differ. Kept out of `tracks.lyrics` so a rescan cannot clobber it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsOverride {
    pub provider: String,
    pub source_artist: Option<String>,
    pub source_title: Option<String>,
    pub lrc: String,
    pub offset_ms: i64,
    pub updated_at: i64,
    pub editor_document: Option<LyricsEditorDocument>,
}

/// Full lyrics-editor document. Playback uses the LRC projection in
/// `LyricsOverride::lrc`; this copy preserves per-line end times.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum LyricsEditorDocument {
    Plain { lines: Vec<PlainLyricsLine> },
    Synced { lines: Vec<SyncedLyricsLine> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainLyricsLine {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedLyricsLine {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
}
