# Tempo — Architecture & Contracts

Local-first desktop music player. Tauri 2 + React 18 + TypeScript + Vite + Rust + SQLite (rusqlite).
No Electron. No backend server. Everything works offline.

## Directory ownership

| Path | Owner | Notes |
|---|---|---|
| `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` | COORDINATOR | do not edit |
| `src-tauri/Cargo.toml`, `tauri.conf.json`, `capabilities/`, `main.rs`, `lib.rs` | COORDINATOR | do not edit |
| `src-tauri/src/models.rs` | COORDINATOR | frozen shared Rust models |
| `src-tauri/src/database.rs` | **AGENT-DB** | SQLite layer + migrations |
| `src-tauri/src/scanner.rs`, `src-tauri/src/metadata.rs` | **AGENT-SCANNER** | FS walk + tags + covers |
| `src/api/client.ts`, `src/api/events.ts`, `src/types/**` | COORDINATOR | frozen frontend↔backend contract |
| `src/components/**`, `src/pages/**`, `src/styles/**`, `src/hooks/**`, `src/utils/**` | **AGENT-UI** | all visual work |
| `src/player/**`, `src/providers/**` | **AGENT-PLAYER** | playback engine + provider abstraction |
| `src/App.tsx`, `src/main.tsx`, `src-tauri/src/commands.rs` | COORDINATOR | integration glue |

Rules: no new dependencies without coordinator approval; serde structs use `#[serde(rename_all = "camelCase")]`;
Rust commands return `Result<T, String>`; TS strict mode; minimal comments; English code.

## Data model

See `src/types/models.ts` (TS) and `src-tauri/src/models.rs` (Rust mirror). Tables:

```
library_folders(id PK, path UNIQUE, enabled, added_at)
artists(id PK, name COLLATE NOCASE UNIQUE)
albums(id PK, title COLLATE NOCASE, artist_id→artists ON DELETE SET NULL, year, cover_path,
       UNIQUE(title, artist_id))
tracks(id PK, path UNIQUE, folder_id→library_folders ON DELETE CASCADE, title, artist_id→artists,
       album_id→albums ON DELETE SET NULL, track_number, disc_number, duration_sec REAL, year, genre,
       cover_path, file_size, modified_at, added_at, source DEFAULT 'local', external_id,
       last_played_at, play_count DEFAULT 0, skip_count DEFAULT 0)
playlists(id PK, name, created_at, updated_at)
playlist_tracks(id PK, playlist_id→playlists ON DELETE CASCADE, track_id→tracks ON DELETE CASCADE,
       position, added_at, UNIQUE(playlist_id, position))
listening_history(id PK, track_id→tracks ON DELETE CASCADE, played_at, start_sec REAL,
       listened_sec REAL, completed INT, skipped INT)
```

Indexes: `tracks(album_id)`, `tracks(artist_id)`, `tracks(added_at)`, `tracks(title)`,
`tracks(folder_id)`, `playlist_tracks(playlist_id, position)`.

Migrations: ordered list applied in transactions, tracked via `PRAGMA user_version`. DB file:
`app_data_dir()/tempo.db`, WAL mode, foreign_keys=ON on every connection.
Covers dir: `app_data_dir()/covers`.

## Tauri command contract

All commands: `Result<T, String>`. Arg names in JS are camelCase (Tauri converts).

```
get_library_folders() -> Vec<LibraryFolder>
add_library_folder(path: String) -> LibraryFolder            // canonicalize, insert, then full scan runs separately
remove_library_folder(folderId: i64) -> ()                   // deletes folder row; tracks cascade
rescan_folder(folderId: i64) -> ScanSummary                  // async, emits scan://progress events
rescan_library() -> ScanSummary                              // async, emits scan://progress events
list_tracks(query: String, limit: i64, offset: i64) -> Vec<Track>   // query="" → browse by added_at desc
count_tracks() -> i64
search_all(query: String) -> SearchResults                   // tracks LIKE / albums / artists, limit ~100 each
list_albums(query: String) -> Vec<Album>
get_album(albumId: i64) -> AlbumDetail { album, tracks }
list_artists(query: String) -> Vec<Artist>
get_artist(artistId: i64) -> ArtistDetail { artist, albums }
create_playlist(name) -> Playlist
rename_playlist(playlistId, name) -> ()
delete_playlist(playlistId) -> ()
list_playlists() -> Vec<Playlist>
get_playlist(playlistId) -> Vec<PlaylistTrack>               // ordered by position
playlist_add_track(playlistId, trackId) -> ()
playlist_remove_track(playlistId, trackId) -> ()
playlist_move_track(playlistId, fromPos, toPos) -> ()
bump_play_count(trackId) -> ()
record_history(trackId, listenedSec: f64|null, completed: bool, skipped: bool) -> ()
```

Event `scan://progress` payload = `ScanProgress { phase: started|progress|completed, scannedFiles,
added, updated, removed, unchanged, errors, currentFile }` emitted during scans (progress every 25 files).

## AGENT-DB contract (`database.rs`)

```rust
pub struct Db { conn: Mutex<Connection> }
impl Db {
    pub fn open_at(path: &Path) -> Result<Self, String>;          // create dirs, migrate, WAL
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String>;
    pub fn list_file_stamps(&self) -> Result<HashMap<String, FileStamp>, String>;
    pub fn upsert_scanned_tracks(&self, new: &[TrackInput], updated: &[TrackInput]) -> Result<(u32, u32), String>;
    pub fn delete_tracks_by_paths(&self, paths: &[String]) -> Result<u32, String>;
}
```
Plus query helpers used by commands (folders CRUD, browse/search tracks, albums/artists detail,
playlists CRUD+ordering, play_count/history writes). Unit tests with in-memory or temp-file DB
must cover migrations idempotency and one happy path per group.

## AGENT-SCANNER contract (`scanner.rs`, `metadata.rs`)

```rust
pub const AUDIO_EXTENSIONS: &[&str] = &["mp3","flac","m4a","aac","ogg","opus","wav"];
pub struct ScanOutcome { pub new: Vec<TrackInput>, pub updated: Vec<TrackInput>,
                         pub removed: Vec<String>, pub unchanged: u32, pub errors: u32,
                         pub scanned_files: u32 }
pub struct Tick { pub scanned_files: u32, pub current_file: Option<String> }

pub fn collect_audio_files(root: &Path) -> Vec<PathBuf>;
pub fn scan_incremental(root: &Path, known_stamps: &HashMap<String, FileStamp>,
                        covers_dir: &Path, on_tick: &dyn Fn(Tick)) -> ScanOutcome;
// metadata.rs
pub fn read_metadata(path: &Path, covers_dir: &Path) -> Result<MetaParsed, String>;
pub struct MetaParsed { /* tag fields + cover_path already written to covers_dir */ }
```
Scanner is pure: no Tauri types, no DB writes. Incremental rule: file present in known_stamps with
same size+mtime → skip; else parse → goes to new/updated. Paths under root missing from disk → removed.

## Frontend api usage

`import { api } from './api/client'` — typed wrappers only, no business logic in components.
`onScanProgress(cb)` subscribes to backend scan events.

## AGENT-PLAYER contract

```ts
export function usePlayer(): PlayerApi
interface PlayerApi {
  currentTrack: UnifiedTrack | null; queue: UnifiedTrack[]; queueIndex: number;
  isPlaying: boolean; position: number; duration: number; volume: number;
  repeat: RepeatMode; shuffle: boolean;
  playTracks(tracks: UnifiedTrack[], startIndex?: number): void;
  toggle(): void; next(): void; previous(): void;
  seek(sec: number): void; setVolume(v: number): void;
  setRepeat(m: RepeatMode): void; toggleShuffle(): void;
  addToQueue(t: UnifiedTrack): void; removeFromQueue(index: number): void;
  clearQueue(): void;
}
```
Implementation: module-level singleton `PlayerController` owning an HTML5 `<Audio>` element +
`QueueController` (pure class: order, shuffle permutation, repeat off/all/one). React context only
mirrors state via subscription. On track start: `api.bumpPlayCount(dbId)` when local; on natural end:
`api.recordHistory(dbId, dur, true, false)`; on manual skip after ≥10s listened: recordHistory(..., skipped=true).
Local files resolved via `convertFileSrc(localPath)`.

## AGENT-UI contract

Pages export named components: `HomePage`, `LibraryPage`, `AlbumsPage`, `ArtistsPage`,
`PlaylistsPage`, `SettingsPage`. Layout exports `Sidebar`, `TopBar`, `PlayerBar`, `QueuePanel`.
Shared: `TrackList` (rows: index/cover/title/artist/album/duration, dblclick plays),
`Cover` (img with fallback initials), `EmptyState`, `Modal`.
Navigation: simple state-based routing owned by App (view name + selected id), passed via props/context
from App — pages must not implement their own router.
Dark flat theme, CSS custom properties from `styles/global.css`, system font stack, no CSS framework,
no blur/backdrop effects. Lists must stay virtualization-ready: flat rows, fixed heights, paged loads.

## Performance rules

- No polling loops; UI updates react to events/state changes only.
- Track lists: server-side paging (500/page) + "load more"; search limited to 200.
- Scanning happens in Rust threads, never blocks the webview.
- UI icons: `lucide-react` package only (tree-shakeable imports like `import { Play } from 'lucide-react'`).
