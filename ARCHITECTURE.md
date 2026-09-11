# Tempo — Architecture

Local-first desktop music player. Tauri 2 + React 18 + TypeScript + Vite on the front, Rust + SQLite
(`rusqlite`) underneath. No Electron, no backend server, no telemetry. Everything works offline;
network access is opt-in per feature (SoundCloud search, online lyrics, Discord cover hosting).

This document describes how the pieces fit together and which invariants the code relies on. For a
feature-level tour see [README.md](README.md).

## Runtime shape

Three things run at once:

1. **The webview** — the whole UI, plus playback. Audio is a single HTML5 `<audio>` element owned by
   a module-level singleton, not a React-managed node, so it survives re-renders and route changes.
2. **The Rust core** — the SQLite database, the filesystem scanner, tag/cover extraction, and all
   network calls that need to bypass browser CORS (SoundCloud, lyrics providers, image hosting).
3. **Detached worker threads** — library scans and SoundCloud downloads. They never block the
   webview; they report back by emitting Tauri events.

The frontend never touches SQLite or the filesystem directly. Every crossing goes through a Tauri
command, wrapped once in `src/api/client.ts`.

## Repository layout

```
src/                      React frontend (~11.7k LOC)
  api/                      typed wrappers over Tauri commands (client.ts) + event subscriptions (events.ts)
  components/common/        TrackList, Cover, Modal, ConfirmModal, Toast, TrackMenu, WaveProgress, …
  components/layout/        TitleBar, Sidebar, TopBar, PlayerBar, QueuePanel, BackgroundLayer
  components/integration/   PresenceBridge — pushes player state into the Discord driver
  components/onboarding/    first-run flow
  dnd/                      drag-and-drop for tracks and sidebar favorites
  features/lyrics/          providers, LRC parsing, overlay, React context
  hooks/                    useAsync, useLikes, useFolders, useScanProgress, useLibraryVersion, useSearchQuery
  i18n/                     EN / RU dictionaries + provider
  pages/                    11 screens (see below)
  player/                   playback engine: controller, queue, engine, React bindings
  providers/                music source abstraction (local, SoundCloud)
  state/                    nav (routing) + settings (persisted to localStorage)
  theme/                    token engine + 10 presets
  types/                    models.ts (mirrors Rust) + theme.ts
  utils/                    format, unified track mapping, playlists, likes/search stores
src-tauri/src/            Rust core (~8.4k LOC)
  database.rs               SQLite layer, schema, migrations, every query        (4.1k)
  commands.rs               Tauri command surface — all 77 commands             (1.3k)
  discord.rs                Rich Presence client over the local IPC pipe          (710)
  lyrics.rs                 five online lyrics providers + LRC assembly           (647)
  soundcloud_store.rs       stream cache: download, eviction, cache accounting     (432)
  scanner.rs                filesystem walk + incremental scan decisions           (333)
  soundcloud.rs             SoundCloud API client                                  (300)
  models.rs                 shared serde structs (Rust mirror of types/models.ts)  (266)
  lib.rs                    app setup, state, command registration                (139)
  metadata.rs               tag & cover extraction via lofty                       (113)
```

Screens: Home, Library, Albums, Artists, Playlists, Search, Profile, Settings, plus three detail
views (Album, Artist, Playlist). Listening history and statistics live **inside Profile**, not on a
separate page.

## Data model

`src/types/models.ts` (TS) and `src-tauri/src/models.rs` (Rust) are mirrors; serde structs carry
`#[serde(rename_all = "camelCase")]` so the wire format matches TypeScript naming.

Fourteen tables. Core library:

```
library_folders(id PK, path UNIQUE, enabled, added_at)
artists(id PK, name UNIQUE COLLATE NOCASE, image_path)
albums(id PK, title COLLATE NOCASE, artist_id→artists ON DELETE SET NULL, year, cover_path,
       UNIQUE(title COLLATE NOCASE, artist_id))
tracks(id PK, path UNIQUE, folder_id→library_folders ON DELETE CASCADE, title, artist_id→artists,
       album_id→albums ON DELETE SET NULL, track_number, disc_number, duration_sec REAL, year, genre,
       cover_path, file_size, modified_at, added_at, source DEFAULT 'local', external_id,
       last_played_at, play_count DEFAULT 0, skip_count DEFAULT 0, lyrics, search_text, artist_name,
       cached_at)
```

Playlists, history, settings:

```
playlists(id PK, name, created_at, updated_at, pinned DEFAULT 0, pin_order, is_likes DEFAULT 0)
playlist_tracks(id PK, playlist_id→playlists ON DELETE CASCADE, track_id→tracks ON DELETE CASCADE,
       position, added_at, UNIQUE(playlist_id, position))
listening_history(id PK, track_id→tracks ON DELETE CASCADE, played_at, start_sec REAL,
       listened_sec REAL, completed INT, skipped INT)
app_settings(key PK, value)
```

Favorites, overrides, caches:

```
favorite_artists(artist_id PK→artists ON DELETE CASCADE, added_at)
favorite_albums(album_id PK→albums ON DELETE CASCADE, added_at)
favorite_order(kind, ref_id, position, PRIMARY KEY(kind, ref_id))
track_lyrics_override(track_id PK→tracks ON DELETE CASCADE, provider, source_artist, source_title,
       lrc, offset_ms, updated_at)
hidden_tracks(path PK, title, added_at)
cover_uploads(cover_path PK, url, uploaded_at)
```

Indexes: `tracks(album_id)`, `tracks(artist_id)`, `tracks(folder_id)`, `tracks(added_at)`,
`tracks(title)`, `tracks(source)`, `playlist_tracks(playlist_id, position)`.

Storage: `app_data_dir()/tempo.db` in WAL mode, `foreign_keys=ON` on every connection. Covers are
extracted to `app_data_dir()/covers`.

### Invariants worth knowing

**Library visibility.** A track is listed, searchable and counted only when

```sql
folder_id IS NOT NULL OR (source = 'soundcloud' AND cached_at IS NOT NULL)
```

A SoundCloud row exists as soon as you add it to a playlist, but it stays out of the library until
its audio is actually cached on disk. This predicate is a single constant in `database.rs`, reused
by every query.

**The Likes playlist** is the `playlists` row with `is_likes = 1`. It is created and pinned on every
database open, may be renamed, and cannot be deleted or unpinned — enforced both in the UI and in
SQL.

**`favorite_order` is deliberately not foreign-keyed.** Readers ignore ids they cannot resolve, and
`set_favorites_order` rewrites the table wholesale, so stale rows are collected on the next reorder.
It holds one shared ordering for pinned playlists, favorite artists and favorite albums together —
before it existed, "one continuous list" in the sidebar was really three lists that could not be
mixed.

**Two lyrics columns, on purpose.** `tracks.lyrics` is the automatic cache and gets overwritten on
every rescan (`lyrics = excluded.lyrics`). A user's pinned choice therefore lives in the separate
`track_lyrics_override` table, which rescans never touch.

**`hidden_tracks` is keyed by path, not track id.** Removing a local track from the library deletes
its row; the path is what the scanner sees on the next pass, so the file is not silently re-added.

**Playlist cover** is the `cover_path` of the last-added playlist track that has one, computed in
the shared `PLAYLIST_COLUMNS` projection.

## Migrations

An ordered `MIGRATIONS: &[&str]`, each applied inside `BEGIN … COMMIT` and tracked via
`PRAGMA user_version`. A failure rolls back and aborts startup with the migration number. Twelve so
far:

| # | What it does |
|---|---|
| 1 | initial schema — folders, artists, albums, tracks, playlists, history, indexes |
| 2 | `app_settings`; playlist pinning; `tracks.lyrics` |
| 3 | `tracks.search_text` |
| 4 | `tracks.artist_name`; index on `tracks(source)` |
| 5 | `tracks.cached_at`; `playlists.is_likes` + seed the Likes playlist |
| 6 | renumber `pin_order` so Likes sits first |
| 7 | `favorite_artists` |
| 8 | `favorite_albums`; `artists.image_path` |
| 9 | `cover_uploads` (Discord cover URL cache) |
| 10 | drop cached uploads — they were full-size art Discord's media proxy refused |
| 11 | drop catbox.moe URLs — that origin was unreliable behind Discord's proxy |
| 12 | `favorite_order`, `track_lyrics_override`, `hidden_tracks`, seeded from current state |

Migrations 10 and 11 are data-only invalidations: each cover simply re-uploads once on the next
presence update.

After migrating, `open_at` also runs `ensure_likes_playlist` and `backfill_search_text`.

## Tauri command surface

Every command returns `Result<T, String>`. Rust `snake_case` parameters are invoked as `camelCase`
from JS — Tauri converts. All 77 commands are registered in `lib.rs` and wrapped in
`src/api/client.ts`.

**Library & scanning**

```
get_library_folders() -> Vec<LibraryFolder>
add_library_folder(path) -> LibraryFolder          // canonicalize + insert; scan runs separately
remove_library_folder(folderId) -> ()              // tracks cascade
rescan_folder(folderId, force?) -> ScanSummary     // threaded, emits scan://progress
rescan_library(force?) -> ScanSummary              // threaded, emits scan://progress
list_tracks(query, limit, offset, sort?) -> Vec<Track>
count_tracks() -> i64
search_all(query) -> SearchResults                 // tracks / albums / artists
list_albums(query) -> Vec<Album>          get_album(albumId) -> AlbumDetail
list_artists(query) -> Vec<Artist>        get_artist(artistId) -> ArtistDetail
get_artist_tracks(artistId) -> Vec<Track>
hide_track(trackId) -> String             unhide_track(path) -> bool
list_hidden_tracks() -> Vec<HiddenTrack>
reveal_in_file_manager(path) -> bool
```

**Playlists & favorites**

```
create_playlist(name) / rename_playlist(id, name) / delete_playlist(id) / list_playlists()
get_playlist(playlistId) -> Vec<PlaylistTrack>     // ordered by position
playlist_add_track(playlistId, trackId) / playlist_remove_track(playlistId, trackId)
playlist_move_track(playlistId, fromPos, toPos)
set_playlist_pinned(playlistId, pinned) / move_pinned_playlist(playlistId, newOrder)
list_favorites_order() -> Vec<FavoriteOrderEntry>  / set_favorites_order(items)
toggle_favorite_artist(artistId) -> bool  / list_favorite_artists() / is_favorite_artist(artistId)
toggle_favorite_album(albumId) -> bool    / list_favorite_albums()  / is_favorite_album(albumId)
like_track(trackId) / unlike_track(trackId) / list_liked_track_ids()
export_playlist_m3u8(playlistId, path) -> usize
import_playlist_m3u8(path, name) -> Playlist
```

**Playback stats & history**

```
bump_play_count(trackId)
record_history(trackId, listenedSec?, completed, skipped)
get_history(limit, offset) -> Vec<HistoryEntryDto>     clear_history() -> u32
get_analytics(sinceSecs?) -> AnalyticsData
get_top_tracks(limit) -> Vec<TopTrackItem>             // all-time play-count ranking
get_hour_picks(limit) -> Vec<Track>                    // most played in the current local hour ±1
get_daily_minutes(days) -> Vec<DailyMinutes>
```

**Lyrics**

```
get_track_lyrics(trackId) -> Option<String>            set_track_lyrics(trackId, lyrics)
fetch_online_lyrics(artist, title) -> …                // best match
fetch_online_lyrics_all(artist, title) -> Vec<OnlineLyricsCandidate>
get_lyrics_override(trackId) -> Option<LyricsOverride>
set_lyrics_override(trackId, provider, sourceArtist?, sourceTitle?, lrc, offsetMs)
set_lyrics_override_offset(...)                        clear_lyrics_override(trackId)
```

**SoundCloud**

```
sc_search_tracks(query, limit, offset) -> Vec<ScTrack>
sc_stream_url(trackId) -> String
sc_get_playback(trackId) -> ScPlayback                 // starts a background download
sc_upsert_track(track) -> i64                          add_sc_track_to_playlist(...)
sc_cache_info() -> ScCacheInfo { path, totalBytes, fileCount, limitBytes }
set_sc_cache_dir(path)     clear_sc_cache() -> (u32, u32)     sc_set_cache_limit(bytes)
```

**Appearance, integration, misc**

```
get_app_setting(key) -> Option<String>     set_app_setting(key, value)
import_font(path) / import_background(path) / import_avatar(path) / import_artist_image(...)
get_covers_cache_info() -> CoversCacheInfo             clear_covers_cache()
set_taskbar_progress(position, duration, playing?)
discord_set_presence(clientId, details, state?, largeText?, startMs?, endMs?,
                     largeImage?, smallImage?, reason?)
discord_clear_presence()
upload_cover(coverPath) -> String                      // hosts a cover so Discord can fetch it
```

## Events

Rust → frontend, subscribed in `src/api/events.ts`:

| Event | Payload | When |
|---|---|---|
| `scan://progress` | `ScanProgress { phase: started \| progress \| completed, scannedFiles, added, updated, removed, unchanged, errors, currentFile }` | during scans, throttled to at most one event every 150 ms (`PROGRESS_INTERVAL_MS`) |
| `library://changed` | SoundCloud track id | a background download finished caching, so the track just became library-visible |

There is no polling anywhere; the UI reacts to these events and to local state only.

## Rust modules

### `database.rs`

Owns the connection and every query.

```rust
pub struct Db { conn: Mutex<Connection> }

impl Db {
    pub fn open_at(path: &Path) -> Result<Self, String>;   // mkdir, WAL, migrate, seed, backfill
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>)
        -> Result<T, String>;
    pub fn list_file_stamps(&self) -> Result<HashMap<String, FileStamp>, String>;
    pub fn upsert_scanned_tracks(&self, new: &[TrackInput], updated: &[TrackInput])
        -> Result<(u32, u32), String>;
    pub fn delete_tracks_by_paths(&self, paths: &[String]) -> Result<u32, String>;
}
```

Everything else is query helpers grouped by domain. Shared column projections
(`TRACK_COLUMNS`, `PLAYLIST_COLUMNS`, `FOLDER_COLUMNS`, the visibility predicate) are constants, so
a change to what a "track row" means happens in one place.

### `scanner.rs` + `metadata.rs`

```rust
pub const AUDIO_EXTENSIONS: &[&str] = &["mp3","flac","m4a","aac","ogg","opus","wav"];

pub fn collect_audio_files(root: &Path) -> Vec<PathBuf>;
pub fn scan_incremental(root: &Path,
                        folder_id: i64,
                        known_stamps: &HashMap<String, FileStamp>,
                        hidden_paths: &HashSet<String>,
                        covers_dir: &Path,
                        on_tick: &dyn Fn(Tick)) -> ScanOutcome;

// metadata.rs
pub fn read_metadata(path: &Path, covers_dir: &Path) -> Result<MetaParsed, String>;
```

The scanner is pure: no Tauri types, no database writes. It receives the known file stamps and the
set of hidden paths, returns a
`ScanOutcome { new, updated, removed, unchanged, errors, scanned_files }`, and the caller persists
it.

**Incremental rule:** a file already known with the same size *and* mtime is skipped; anything else
is parsed and lands in `new` or `updated`. Paths under the root that no longer exist on disk go to
`removed`. Paths in `hidden_paths` are skipped entirely, which is what keeps a track the user
removed from coming back on the next pass. Together this is what makes rescans near-instant.

### `soundcloud.rs` + `soundcloud_store.rs`

`soundcloud.rs` is the API client. `soundcloud_store.rs` is the cache.

A SoundCloud track is upserted into `tracks` with `path = 'soundcloud://{id}'`, `folder_id NULL`,
`cached_at NULL` — present in the database, invisible in the library. `sc_get_playback` returns a
playable URL immediately and downloads the progressive stream in the background; on success it sets
`cached_at` + `file_size`, emits `library://changed`, and enforces the cache limit by evicting the
least-recently-played files. Startup maintenance re-syncs `cached_at` against the cache directory
and prunes duplicate local rows.

### `lyrics.rs`

Five online providers, all returning LRC: **lrclib**, **textyl**, **Musixmatch**, **lyrics.ovh**,
**Genius**.

They are not tried one after another. For each candidate spelling of the query, the first three are
**raced** and the first non-empty answer wins (`race_first`); only if all three come back empty are
**lyrics.ovh** and **Genius** raced as a second group. The whole chain is wrapped in a 12-second
timeout, so a slow provider cannot hold up the UI.

The candidate spellings come from `clean_pair` and `build_variants`, which strip bracketed suffixes
like `(Remastered)` and try several artist/title forms — the difference between a hit and a miss is
usually punctuation. Around that: HTML entity decoding, tag stripping, seconds→LRC timestamp
formatting, and a 256-entry in-process memo cache keyed by lowercased `artist|title`, so a failed
lookup is not repeated.

`fetch_online_lyrics_all` skips the racing and returns every candidate it can find, so the UI can
offer a choice instead of guessing.

### `discord.rs`

A hand-rolled Rich Presence client speaking the Discord IPC protocol over the local named pipe
(`\\.\pipe\discord-ipc-{0..9}` on Windows). Single-threaded by design — a synchronous pipe handle
serialises requests. It is event-driven: the frontend pushes updates through `PresenceBridge`, and
the driver rate-limits to one send per second, refreshes every 60s, and reconnects after 5s when
Discord goes away.

Covers need a public URL because Discord's media proxy fetches artwork itself, so `upload_cover`
downscales a local cover and hosts it, memoising the result in `cover_uploads`.

## Frontend architecture

### Routing and settings

Routing is a discriminated union in `src/state/nav.tsx` — no router library:

```ts
export type View =
  | { name: 'home' } | { name: 'library' } | { name: 'albums' } | { name: 'artists' }
  | { name: 'playlists' } | { name: 'profile' } | { name: 'settings' } | { name: 'search' }
  | { name: 'album'; id: number } | { name: 'artist'; id: number } | { name: 'playlist'; id: number }
```

Pages must not implement their own routing; they call `useNav().navigate(view)`.

`src/state/settings.tsx` holds appearance and integration preferences, persisted to `localStorage`
under `tempo.settings.v1` and merged over `defaultSettings` on load, so a partial or corrupt blob
degrades to defaults instead of crashing. Grouped as `lang`, `theme`, `startupPage`, `profile`,
`discord`, `lyrics`, `font`, `background`, `player`, `sidebar`. Data that the Rust side needs
(cache limits, paths) lives in `app_settings` instead.

### Playback

```ts
export function usePlayer(): PlayerApi

interface PlayerApi {
  currentTrack: UnifiedTrack | null; queue: UnifiedTrack[]; queueIndex: number
  isPlaying: boolean; position: number; duration: number; volume: number
  repeat: RepeatMode; shuffle: boolean
  playTracks(tracks: UnifiedTrack[], startIndex?: number): void
  toggle(): void; next(): void; previous(): void
  seek(sec: number): void; setVolume(v: number): void
  setRepeat(m: RepeatMode): void; toggleShuffle(): void
  addToQueue(t: UnifiedTrack): void; removeFromQueue(index: number): void; clearQueue(): void
}
```

A module-level `PlayerController` singleton owns the `<audio>` element and a `QueueController` — a
pure class holding the order, the shuffle permutation and the repeat mode (`off` / `all` / `one`).
React context only mirrors state through a subscription, so playback never depends on the component
tree staying mounted.

Local files are resolved with `convertFileSrc(path)`; SoundCloud HLS goes through `hls.js`.

Stat writes happen on well-defined edges: `bumpPlayCount(dbId)` when a local track starts,
`recordHistory(dbId, dur, true, false)` on natural end, and `recordHistory(..., skipped = true)` on
a manual skip after at least 10 seconds listened.

### Provider abstraction

Local files and SoundCloud implement one interface, so pages can treat sources uniformly:

```ts
export interface MusicProvider {
  id: string; name: string; capabilities: ProviderCapabilities
  search(query: string): Promise<SearchHit[]>
  getTrack?(id: string): Promise<UnifiedTrack>
  getArtist?(id: string): Promise<Artist>
  getAlbum?(id: string): Promise<Album>
}
```

`UnifiedTrack` (`src/utils/unified.ts`) is the shape everything downstream consumes; a track carries
its `source` and an optional local database id.

### Lyrics

`features/lyrics/` composes providers behind one context: embedded tags → `.lrc` sidecar → online
fallback. `lrc.ts` parses and formats LRC; the overlay renders the active line with lookahead. A
user can pin a specific provider — or another song's lyrics entirely — per track, with a millisecond
offset, stored in `track_lyrics_override`.

### Theme

Themes are CSS custom properties, not classes. `types/theme.ts` defines twelve `ThemeTokens`
(`bg`, `surface`, `accent`, `playButton`, …) and `TOKEN_VARS` maps each to a CSS variable;
`theme/engine.tsx` writes them onto the document root. An `ActiveTheme` is either
`{ kind: 'preset', presetId }` — ten presets ship in `theme/presets.ts` — or
`{ kind: 'custom', custom }`, where a few base colours are derived into the full token set with
per-token overrides on top.

### Window chrome

The window runs with `decorations: false` and a custom in-app title bar
(`components/layout/TitleBar.tsx`): drag region via `data-tauri-drag-region`, custom
minimize / maximize-restore / close buttons on the Tauri window API, double-click to toggle
maximize. Capabilities live in `src-tauri/capabilities/default.json`.

## Conventions

- Rust commands return `Result<T, String>`; serde structs use `#[serde(rename_all = "camelCase")]`.
- TypeScript runs in `strict` mode. There is no `any` in `src/`, and it should stay that way.
- `src/types/models.ts` and `src-tauri/src/models.rs` are mirrors — change both together.
- Components import `{ api }` from `src/api/client`. No `invoke` calls and no business logic in
  components.
- Icons come from `lucide-react` only, via tree-shakeable named imports.
- Hand-written CSS with custom properties; no CSS framework.
- Comments explain *why*, not *what* — see the migration block in `database.rs` for the intended
  tone.
- Code and identifiers in English.

## Performance rules

- No polling loops. The UI reacts to events and state changes only.
- Track lists page server-side (500 per page) with "load more"; search results are capped.
- Lists stay virtualization-ready: flat rows, fixed heights, paged loads.
- Scanning and downloading happen on Rust threads and must never block the webview.
- Release builds use `lto = "thin"`, `codegen-units = 1`, `strip = true`.

## Testing

62 Rust unit tests run against in-memory or temp-file databases, covering migration idempotency,
scanner decisions, the SoundCloud cache, and one happy path per query group:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm run typecheck
```

CI runs both on every push and pull request to `main`.

The frontend currently has no automated tests. The highest-value targets are the pure modules —
`player/queue.ts` (shuffle permutation, repeat transitions), `features/lyrics/lrc.ts` (parsing),
`utils/format.ts` and `utils/unified.ts`.

## Code graph

`graphify-out/` holds a persistent knowledge graph of this repository (~1270 nodes, ~3740 edges,
~100 communities). It is built from the AST, so it needs no API key, and it is gitignored —
local-only.

Use it to navigate instead of reading files one by one:

```bash
graphify query "<question>"      # BFS over the graph; returns nodes with file:line
graphify explain "<Symbol>"      # one node and its neighbours
graphify path "A" "B"            # shortest path between two concepts
graphify affected "<Symbol>"     # reverse traversal: what depends on this
graphify update .                # re-extract changed files (fast, no LLM)
```

`graphify-out/GRAPH_REPORT.md` carries the god nodes, the community map and the knowledge gaps.
The graph records the commit it was built from, so treat it as stale after a batch of code changes
and refresh it with `graphify update .`.
