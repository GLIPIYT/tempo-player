# SoundCloud library imports, recommendations, and UI fixes

**Status:** design approved in chat; awaiting document review before implementation
**Date:** 2026-10-02 22:53 Asia/Yekaterinburg
**Implementation target:** three commits directly on `main`

## Goals

- Make saved SoundCloud tracks and collections appear in the local artist catalog with their SoundCloud profile artwork.
- Provide useful track actions from online collection pages and search all YouTube Music result types from the default “All” view.
- Correct the reported Home, collection, Settings, and profile visual issues.
- Add a SoundCloud recommendation shelf to Home, seeded from the user's most-played tracks, with a way to continue loading recommendations.
- Keep UI testing manual for the user; do not automate desktop interaction.

## 1. Library and presentation fixes

### SoundCloud artists and avatars

The SoundCloud API mapping already uses the uploader's username as the track artist, but `upsert_sc_track` stores only that text. This leaves `artist_id` unset, so cached tracks do not create an entry in the Artists catalog. SoundCloud tracks also discard the uploader's `avatar_url`.

Extend the SoundCloud track DTO with the uploader avatar URL. When the user saves or caches a SoundCloud track or collection, create or reuse an artist record for each distinct uploader, associate the imported tracks with that artist, and store the avatar under Tempo's managed avatar directory. Preserve an existing manually selected artist image. Ordinary stream-only playback will continue to leave the Artists catalog unchanged, per the user's choice.

Artist imports already create/link an artist and its tracks; they should also preserve the SoundCloud account avatar. Playlist and album imports should link each track to its uploader artist without inventing album associations where the source provides none.

### Track actions on online pages

Add a right-click menu to tracks in SoundCloud playlist/album and artist pages, and YouTube Music collection pages. It will offer:

- **Play** — start the selected online track.
- **Cache track** — download and file that track in the local library using the existing provider-specific cache/upsert paths. SoundCloud caching also creates/links the uploader and stores their avatar. The action does not silently create a local playlist.

Use the same menu behavior for album, playlist, and artist track rows where those rows share the online collection views.

### YouTube Music search

In the default “All” view, launch track search and playlist, album, and artist collection searches concurrently. Keep category-specific results and loading/errors independent so one slow or failed collection request does not hide successful track results. Selecting one category continues to filter to that result type.

### Visual fixes

- Give Home mix play buttons white text. Add a thin text outline only when the active gradient is bright; keep “From your library”, “Artist mix”, and related mix descriptions white.
- Remove the playlist-only hero grid reversal so playlist artwork is on the left like album and artist artwork.
- Use a shared primary play-action treatment across playlist, album, and artist pages and their cards. Normalize gradient clipping, dimensions, radius, icon placement, and hover colors; keep the album hover action aligned with the same tokens.
- Make the profile recent-history row use an explicit three-column grid (track title/artist, album, played time). The current generic track-list grid reserves columns for a track number and row actions that this profile markup does not render; this squeezes the track title and makes the album column look like the title.
- Constrain and wrap storage paths to prevent horizontal overflow. Route wheel scrolling over otherwise empty parts of Settings to the settings content scroller while preserving normal control interactions.
- Keep album artist names white regardless of theme.

## 2. Home recommendation shelf

Add a dedicated shelf at the bottom of Home, after the existing home content. Reuse Tempo's track-card styling and provide clear loading, no-listening-history, no-results, and retry states. The shelf should not prevent the rest of Home from rendering while SoundCloud is unavailable. It will display “for you” recommendations and a concise hint that they are based on frequently played tracks.

## 3. SoundCloud recommendation flow

### Seeds and result selection

- Read the existing top 40 tracks ordered by play history.
- Choose up to three distinct seed tracks randomly from that pool. If a seed already has a SoundCloud external ID, use it directly. Otherwise, search SoundCloud by its title and artist and select the closest plausible match.
- For each matched seed, request the SoundCloud track-related list or its track station (`station_urn` via `/system-playlists/{id}`). Combine results, remove the seeds and duplicates, and show at most 24 playable tracks at a time.
- Cache the current recommendation batch in memory for 30 minutes to avoid repeating requests on every Home render. “Load more” samples unused seeds from the same pool and appends deduplicated results; if no unused seed remains, it can sample again while still filtering already-shown tracks.
- Start loading when the recommendation shelf approaches view, so Home's initial content remains responsive. Offer retry after provider failures and show an honest empty state if there is no listening history or no matching SoundCloud catalog.
- Selecting a recommendation plays it; right-click uses the same play/cache actions as other online SoundCloud tracks.

### Provider reliability

Tempo already derives the SoundCloud website `client_id` dynamically for its existing API-v2 requests. Current direct probes returned recommendation/station data from the site's anonymous API surface. This is not a stable public contract: SoundCloud's published API documentation describes related-track and system-playlist routes under OAuth security. The implementation should reuse the current client-ID mechanism, keep requests bounded, and handle rejection/shape changes as recoverable empty/error states. Do not embed user credentials or a fixed client ID.

## Commit boundaries

1. **Library and visual fixes:** SoundCloud artist/avatar linking, online track menus, YouTube “All” search, and the requested visual corrections.
2. **Home recommendations UI:** the bottom shelf and its loading/empty/error states, initially backed by an empty provider result.
3. **SoundCloud recommendations:** seed resolution, related/station retrieval, deduplication, session caching, and “Load more”.

Each implementation commit is pushed directly to `main`; no feature branches or worktrees.

## Verification and manual review

- Use compile/build checks to catch type and Rust errors; do not add or run automated test suites unless separately requested.
- Leave manual app and visual checks to the user. Review points: a cached SoundCloud track appears under Artists with its avatar; SC/YT online track context menus play/cache; YouTube “All” shows all four result types; profile recent rows show track title separately from album; Settings scroll works over blank space without a horizontal bar; gradient play controls and Home mix text look correct; Home recommendations can load, continue, and recover from provider failure.
- Keep the Tauri development player running after code changes for the user's review.

## Research sources to cite in the final report

- SoundCloud API guide: https://developers.soundcloud.com/docs/api/guide
- Official OpenAPI specification: https://github.com/soundcloud/api/blob/master/openapi/api.yaml
- Official API release notes: https://github.com/soundcloud/api/releases
