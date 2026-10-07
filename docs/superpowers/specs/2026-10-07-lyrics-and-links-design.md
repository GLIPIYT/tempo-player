# Lyrics Appearance and External Link Reliability

## Goal

Fix missing artwork in SoundCloud recommendation cards and external links that fail to open in the desktop app, then make the lyrics view responsive and configurable without redesigning its overall layout.

## Scope

### Recommendation artwork

- Render recommendation covers through the shared SoundCloud artwork component instead of a bare `<img>`.
- Try the component's alternate artwork URL forms after a load failure.
- Keep the cover area stable while loading and show the track-title fallback if every URL fails or the provider supplied no artwork URL.
- Preserve recommendation card playback, drag-and-drop, and cache controls.

### External links

- Add one shared external-link helper backed by Tauri's opener plugin.
- Accept only absolute `http:` and `https:` URLs. Reject other schemes before invoking the opener.
- Route release-note Markdown anchors and the SoundCloud/YouTube Music “open” actions through the helper; do not use `window.open` for these actions.
- Extend the opener capability for HTTP(S) destinations. A click remains the only way these links are launched. If opening fails, show a localized error toast rather than silently doing nothing.

### Lyrics layout and alignment

- Expand the lyrics column into the available window width while keeping the artwork/player column readable. Use a responsive grid so narrow windows do not gain horizontal overflow.
- Keep three alignment choices: left, center, and right. In settings, show them as compact selectable previews with line glyphs, consistent with the existing theme-card treatment.
- Apply alignment to the inter-line music-note pause animation as well as synced and plain lyrics.

### Lyrics appearance settings

Persist these preferences inside the existing `lyrics` settings object. Older settings files inherit the defaults; malformed or out-of-range values are normalized when loaded.

| Setting | Default | Range / choices |
| --- | --- | --- |
| Text size | 21 px | 16–40 px, 1 px steps; active line remains about 4/3 the base size |
| Active-line fill animation | On | On: progressive text fill; off: static active-line highlight |
| Progress direction | Left to right | Left to right, right to left, center outward |
| Progress color | Theme color | Theme color or custom RGB color |
| Progress opacity | 35% | 5–100%, 1% steps |
| Progress thickness | 1.5 px | 1–6 px, 0.5 px steps |
| Keep progress within lyric text | On | On: clamp the line to the rendered lyric text bounds; off: allow it to extend beyond the text while remaining inside the lyrics column |

- The progress path has a fixed responsive maximum width of 420 CSS pixels, independent of phrase length. With text clamping enabled, its width is capped at the visible lyric text bounds. Its anchor follows the selected text alignment; direction controls the fill origin. Center-out grows symmetrically from the center.
- Theme color remains the default and follows theme changes. Custom color is persisted and used only while custom mode is selected.
- The settings controls stay in the existing Lyrics card; no separate settings page is introduced.

## Data and compatibility

- No database or provider format changes are required.
- New lyric preferences use defaults in `defaultSettings`, are clamped in the existing settings loader, and are merged through the existing update path.
- Existing users retain the current layout choices and effects unless a new setting is explicitly changed. Left alignment, 21 px base size, active-line fill, theme color, and left-to-right movement are the defaults.

## Failure behavior

- An unavailable SoundCloud image falls through alternate URLs and then to a non-broken title-based placeholder; it must not leave a broken-image icon.
- An unsupported URL scheme is not opened. A valid HTTP(S) URL that the OS cannot open produces a localized toast.
- Missing/invalid lyric settings fall back to the defaults and must not break rendering.

## Acceptance criteria

1. Recommendation artwork either loads from an available candidate URL or resolves to the title fallback without a broken image.
2. Release-note links and the supported SoundCloud/YouTube Music open actions launch in the system browser from the desktop app; only HTTP(S) links are accepted, and failures are visible.
3. Pause notes move with left, center, and right lyric alignment.
4. The lyrics text uses the available horizontal space responsively while preserving the artwork/player column.
5. The settings page provides visual alignment choices and the listed appearance controls; each preference survives app restart.
6. Progress fill honors direction, color, opacity, thickness, and text-bound clamping; disabling text fill leaves the active line visibly highlighted.

## Verification and user review

- Implementation verification: TypeScript and Tauri dev compilation; automated tests may cover settings normalization and pure progress geometry if needed.
- Manual interaction checks are left to the user: image fallback, browser launch, all three alignment previews, narrow/wide window behavior, and persistence of each slider/toggle/color choice.

## Out of scope

- Changes to lyrics providers, timing data, or the active-line timing algorithm.
- Replacing the lyrics overlay or redesigning unrelated settings cards.
- Retrying artwork indefinitely after every network failure; the shared component's existing alternate-URL fallback sequence is sufficient.
