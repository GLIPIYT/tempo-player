# Tempo 1.5.0 visual changelog

The editable composition is [poster.html](poster.html) with [poster.css](poster.css). The finished exports are [PNG](tempo-1.5.0-changelog.png) and [WebP](tempo-1.5.0-changelog.webp), 1280 pixels wide. WebP is used in release notes and the README; PNG is the full-quality sharing original.

## Figure sources

| Figure | Production UI |
|---|---|
| `home.png` | `HomeMixFeature` |
| `rule.png` | `CustomMixEditor` |
| `library.png` | `AlbumsPage`, shared collection controls |
| `profile.png` | `ProfilePage` |
| `history.png` | `ListeningHistoryDialog` |
| `lyrics.png` | `SyncedView`, production lyrics layout and controls |
| `processing.png` | `LyricsProcessingPanel` |

These are isolated renders of production components, not live screenshots. The user explicitly approved using their nickname, avatar and real music collection. `user-showcase.json` contains the selected display metadata, saved custom rule and snapshot, and actual listening totals used by the figures. Artwork copies are stored under `figures/covers/`; source credentials, cookies and local filesystem paths are not bundled. A saved older rule receives the same default artist-share range as the application.

The lyrics illustration contains only a short two-line excerpt. Its frozen playback position and cue windows are staged for illustration, not measured analysis results. The processing illustration stages both analyses in their completed state; it does not certify analysis of this particular track. Word refinement is described as experimental on the poster and in the release notes.

## Re-render

Use the project's existing Vite server at port 1420:

- `/src/previews/changelog/index.html?mode=home|rule|library|profile|history`
- `/docs/design/changelog-1.5.0/fixtures/lyrics.html`
- `/docs/design/changelog-1.5.0/fixtures/lyrics.html?view=processing`
- `/docs/design/changelog-1.5.0/poster.html`

The fixture entry points stub native calls and do not play audio or open a real database. Use a separate browser session, reduced motion, and wait for fonts and images to decode. Capture the Home element, the two dialog elements, and the other viewports at the sizes in the image files. Profile uses its real “Last 30 days” control for the capture. The history fixture includes the two captured months only.

The composition uses CSS type, shapes, SVG icons and the current Tempo mark. No generated product UI or invented track names are used. The Home fixture includes two additional built-in mix labels to keep the production navigator in its ordinary state; its active frame is the user's saved rule and actual snapshot.

Release preparation also adds Markdown image support to the real updater, so the same WebP can be read inside Tempo and opened in the browser.
