# Tempo QoL batch — design

Date: 2026-09-03
Status: approved
Baseline: v0.3.0 (`88c1378`), `PRAGMA user_version = 11`

## Scope

Six independent blocks. One migration, nine new commands, no change to
`src-tauri/src/models.rs` (all new DTOs are separate types). Each block lands as
its own commit and is useful alone.

1. Favorites: one shared order across playlists / artists / albums
2. Lyrics: pin a chosen source per song, plus a timing offset
3. Player bar: stop the progress bar overlapping the right-hand controls
4. Hidden tracks: drop a local file from the library without touching the file
5. Small QoL: discord line dedup, instrumental breaks, track-menu navigation,
   undo toasts
6. Discord: pair fast lyric lines into one update, and spend the rate budget as
   a sliding window

Implementation order: migration → block 3 (cheapest, most visible) → block 4 →
block 1 → block 2 → block 5 → block 6. Block 6 comes last because it reuses the
line normaliser introduced in block 5.

## MIGRATION_12

```sql
CREATE TABLE IF NOT EXISTS favorite_order (
    kind TEXT NOT NULL,                -- 'playlist' | 'artist' | 'album'
    ref_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (kind, ref_id)
);
CREATE TABLE IF NOT EXISTS track_lyrics_override (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    source_artist TEXT,
    source_title TEXT,
    lrc TEXT NOT NULL,
    offset_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hidden_tracks (
    path TEXT PRIMARY KEY,
    title TEXT,
    added_at INTEGER NOT NULL
);
```

The migration also seeds `favorite_order` from existing data so the current
sidebar order survives the upgrade: pinned playlists by `pin_order`, then
favorite artists by `added_at`, then favorite albums by `added_at`.

`favorite_order` rows are not foreign keys — a deleted playlist leaves a stale
row, which readers ignore. `set_favorites_order` rewrites the table wholesale,
so stale rows are collected on the next reorder.

## Block 1 — favorites share one order

**Problem.** With sidebar grouping off, the ungrouped view renders three
separate `.fav-list` arrays and only `playlistRow` carries drag props. Order is
persisted for playlists only, via `playlists.pin_order`; `favorite_artists` and
`favorite_albums` have no order column at all.

**Design.** One flat list covers both modes: the grouped view is the same list
filtered per type, preserving relative order. `favorite_order` is the single
authority for sidebar order.

- `list_favorites_order() -> [{kind, refId}]`. The sidebar merges it with its
  three lists and **appends anything unknown at the end**, so an entry that
  appeared without going through the order table integrates instead of
  vanishing.
- `set_favorites_order(items)` — the client sends the whole desired sequence
  (`reorderFavorites` already computes it optimistically). In one transaction:
  clear, re-insert, then sync `playlists.pin_order` to the playlist
  subsequence so the `Playlist` DTO does not contradict the table.
  `move_pinned_playlist` stays for compatibility but the frontend stops using
  it.
- Drag: `artistRow` / `albumRow` gain `data-fav-index` (index into the flat
  array) and `data-fav-kind`. `beginPlaylistReorder` becomes
  `beginFavoriteReorder`; `hitFavIndex(x, y, restrictKind)` gains the filter.
  Grouped mode passes the dragged row's kind as `restrictKind`, so a playlist
  cannot be dropped into the artists section while index arithmetic stays
  global. Ungrouped mode passes `null` — everything reorders against
  everything.
- Artist and album rows need `if (consumeDragClick()) return` in `onClick`,
  otherwise a drag ends in navigation.

## Block 2 — pinned lyrics and offset

**Problem.** The overlay already has a provider dropdown
(`ProviderDropdown`), a manual artist/title search (`handleManualSearch`), and
a candidate list (`fetchOnlineLyricsCandidates`). The selection lives in an
in-memory `overlayCache` Map and is lost on restart. `tracks.lyrics` is a bare
TEXT column with no provenance, and `upsert_scanned_tracks` overwrites it with
`lyrics = excluded.lyrics` on every rescan.

**Design.** `tracks.lyrics` stays the automatic cache. The user's choice lives
in `track_lyrics_override`, so a rescan cannot clobber it and the scanner needs
no changes.

- Selecting a row in the dropdown pins it:
  `set_lyrics_override(trackId, provider, sourceArtist, sourceTitle, lrc, offsetMs)`.
  The first dropdown entry is "Auto (reset)" → `clear_lyrics_override`. A
  "Pinned" badge appears in the overlay header.
- `lyricsService.fetchLyrics` checks the override **first**, before embedded, so
  the overlay and Discord always agree. `lyricsService.invalidate(sourceId)` is
  added so Discord picks up a change immediately rather than on the next track.
- Offset ±0.5s: buttons in the header, `offset_ms` on the same row. Editing the
  offset of auto lyrics pins the current selection — there is nowhere else to
  store it. Applied at parse time, so it affects Discord too.
- Tracks without `dbId` (SoundCloud results not in the cache) cannot pin —
  there is no row to pin to. Their dropdown stays session-only, as today.

## Block 3 — player bar at narrow widths

**Root cause.** Not the waveform. `.pb-right` sits in a
`minmax(0, 0.85fr)` column, so it can be squeezed *below* its content width,
while everything inside is `flex-shrink: 0` plus a fixed 78px volume slider.
The content overflows its track and, with `justify-content: flex-end`, spills
left underneath the progress bar. The waveform itself shrinks correctly
(`flex: 1; min-width: 0` on `.wave`).

**Design.**
- Structural fix: the fourth column becomes `auto`. Only "now playing" and the
  progress column shrink; the overlap is gone at every width, with no queries
  involved.
- Volume collapse: `container-type: inline-size` on `.playerbar` plus
  `@container (max-width: …)` hides the slider and enables a popover under the
  speaker icon. A container query, not `@media`, because the player's width also
  depends on the sidebar (200–340px), which the window does not know about. If
  the query fails to apply, the layout is already unbroken.

## Block 4 — hidden tracks

**Design.** "Gone from the library" is implemented as: delete the `tracks` row
and record the **path** in `hidden_tracks`. The path is durable — it survives a
rescan and a folder being removed and re-added. The big win is that none of the
six read paths (search, albums, artists, top tracks, hour picks, history) need
changes, because the row simply is not there; there is no risk of a hidden
track leaking onto the home page.

- `hide_track(trackId)` — read the path, insert into the blacklist, delete the
  row, prune orphaned albums/artists (reusing the existing logic from
  `delete_tracks_by_paths`), return the path for undo. If the track is playing,
  skip to the next one.
- Scanner: `scan_incremental` receives the blacklist and skips those paths
  before reading metadata. Comparison is case-insensitive (Windows).
- `unhide_track(path)` — remove from the blacklist, find the owning folder by
  path prefix, read metadata, insert that one file. No full folder rescan.
- **Named side effect:** `listening_history` and `playlist_tracks` reference
  `tracks(id)` with `ON DELETE CASCADE`, so hiding erases that track's
  listening history and play count and removes it from playlists. For junk
  sounds that is the point. The toast offers undo for a misclick, but stats
  after restoring will be zero.
- UI: a "Don't show" item with a dislike icon in `TrackMenu` (local tracks
  only), plus a Settings → Library card listing hidden tracks with a restore
  button per row.

## Block 5 — small QoL

- **Discord line dedup.** The send gate normalises before comparing: case,
  repeated whitespace, trailing punctuation. "Ла ла ла" / "Ла ла ла." /
  "ЛА ЛА ЛА" stop being three separate sends. The text sent to Discord stays
  verbatim.
- **Instrumental breaks.** `parseLrc` currently drops lines that have a
  timecode but no text (`lrc.ts:27-28`) — exactly how LRC marks an
  instrumental. It starts keeping them; `lyricLineAt` returns null for them, so
  Discord shows the artist instead of a stuck last-sung line. In the overlay an
  empty line becomes a `notes` segment (♪ instead of a gap).
- **Track menu:** "Go to artist", "Go to album", "Show in Explorer". Explorer
  is a small Rust command running `explorer /select,<path>` with arguments
  passed as an array (no shell), so there is no injection surface and no new
  dependency.
- **Undo toasts:** `toast.show` gains an optional
  `action: { label, run }`. Hiding a track is its first consumer.

All new UI strings go into `ru.ts`; English strings are the keys themselves.

## Block 6 — Discord: paired fast lines, sliding rate window

**Why `large_text` works as a second text slot.** For a listening activity
(type 2) Discord renders `large_text` as a third line under `details` and
`state`. That was measured in `88c1378`, where a constant "Tempo" there read as
a caption on every song. The field we removed as useless is a second text slot,
and top-to-bottom order comes out chronologically correct on its own: `state` is
the current line, `large_text` the next one.

**Pairing.** When line N becomes active, the driver looks at N+1's timecode. If
`next.timeSec - cur.timeSec < 2s`, one update goes out with `state` = N and
`large_text` = N+1, and N+1 is marked as already shown — when it becomes
active, nothing is sent, because it is already on screen. Four fast chorus lines
cost two requests and all four are visible. Longer runs are cut into pairs:
(N, N+1), (N+2, N+3).

**A repeated line is not paired with itself.** If N+1 normalises equal to N —
"Ла ла ла" / "Ла ла ла." — the second slot is left empty and the line is shown
once, on one line, rather than stacked twice. N+1 is still marked as shown, so
the repeat costs no extra request either. Same comparator as the send gate
below.

Today the opposite happens on such a chorus: `requestSend` returns early while a
timer is live (`discordDriver.ts:181`), and the deferred send takes whichever
line is current by then. Intermediate lines are never shown at all.

Code changes:
- `lyricLineAt` returns only text. `lyricSliceAt(result, pos)` is added,
  returning `{ text, nextText, gapSec }` so the driver can see the gap. The
  existing function stays for other callers.
- The driver tracks `pairedAhead: string | null`. The flip comparison uses the
  **normalised** comparator from block 5, otherwise "Ла ла ла" and
  "Ла ла ла." diverge and the pair is sent twice.
- `large_text: Option<String>` is threaded through
  `discord_set_presence` → `set_presence` → `PresenceMsg::Set` → `SetPayload` →
  `activity_args`, with the same `fit_field` treatment: 128 bytes, padded to 2
  characters (a one-syllable line would otherwise reject the whole activity).
- The comment in `activity_args` is rewritten: the field is omitted **until the
  frontend sends a second line**, not always. The existing test at
  `discord.rs:526-531` stays as the "not sent → null" case; a new one covers
  "sent → present".

**Open question, to be measured.** `large_text` lives inside the `assets`
object, and `assets` is only sent when `large_image` is present. While a cover
is still uploading (the first seconds of a track) or absent, the second slot
does not exist. Whether `assets` with only `large_text` and no image renders is
unverified: `src-tauri/examples/discord_probe.rs` gets a case J to measure it.
If it renders, pairing always works. If not, pairing silently disables itself
when there is no cover and behaviour there stays as today.

**Rate budget.** The current model is fixed intervals: 4000ms for normal sends,
1000ms for critical ones. Discord's actual limit is ~5 updates per 20 seconds —
a sliding window, not a pause. The driver keeps timestamps of recent sends and
counts the window: while fewer than five sit in the trailing 20s, a send goes
out immediately instead of waiting four seconds. One token is reserved for
critical events (track change, play/pause) so a track switch is never
invisible — the exact bug that made the limit matter. Together with pairing, a
fast chorus fits the budget and still goes out in full.

**Side effects.** The next line is visible a couple of seconds before it is
sung — a mild spoiler. On clients that hide the third line (mobile, compact
view) the second line of a pair does not show; behaviour degrades to today's.

The 2s threshold becomes a named constant `LYRIC_PAIR_MAX_GAP_SEC` next to the
others in `discordDriver.ts`.

## Verification

`npm run typecheck` plus `cargo test --manifest-path src-tauri/Cargo.toml`.
There is no JS test runner in the project, so tests go on the Rust side:

- the scanner skips blacklisted paths
- `set_favorites_order` yields a stable sequence and tolerates unknown ids
- a lyrics override survives a repeated `upsert_scanned_tracks`
- `activity_args` omits `large_text` when absent and includes it when present

The player-bar overlap is checked by hand, shrinking the window to 960px with
both progress bar styles.
