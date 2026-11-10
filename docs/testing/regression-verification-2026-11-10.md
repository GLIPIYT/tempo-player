# UI regression verification — 2026-11-10

## Setup

Ran a separate headless Playwright CLI session against the ignored fixture at `/.task-plans/ui-personalization-check/fixture.html`. The harness mounted the real `VisualizerSettingsPanel`, `CustomMixEditor`, `ListeningHistoryDialog`, and `SyncedView` components. Tauri calls and listening/artist APIs used deterministic mocks; no native database, audio playback, or user data was accessed.

## Verified

- **Visualizer modes and persistence:** Clicked all four styles for both player and lyric visualizers. The detail sliders report maximums of 192 and 288. Off state dims its settings block. After reload, player style remained `off` while lyric style remained `bars`, with each configuration stored independently.
- **Visualizer switches and preview:** Theme-color and match-background switches excluded one another. While match-background was enabled, the theme-color switch was disabled and its row computed to opacity `0.38` with `grayscale(1)`. With the custom white theme (`--bg: #fff`), the background-color preview produced equal RGB channels (~0.659 sRGB), so the result was neutral gray.
- **Scale and reduced motion:** The 100% and 125% controls set `.app-root` zoom to `1` and `1.25`. Under reduced-motion emulation, switching between player and lyric visualizers left the controls, preview, heading, and dimmed switch with no active animations, `animation-duration: 0s`, and `transition-duration: 0s`.
- **Custom rule editor:** The name input focused on open; switching to description focused the textarea. Copying the preset loaded Artist 04/05 and shares 30–40%. The dropdown stayed open at 100 ms and 500 ms; searching `artist 06` returned only Artist 06. Selecting it and saving called the fixture callback with the edited title/description and IDs `[104, 105, 106]`. Blacklist mode and an empty artist selection both disabled the two share sliders.
- **Listening history:** The October chart rendered fixture data; hovering a day issued a request anchored to that day. Drilling into Oct 10 showed 24 hour hit targets; selecting hour 14 opened 12 five-minute segments. A five-minute hover compared against the last active five-minute period (9 Oct, 18:00–18:05); equal values showed a neutral `0%` pill with both values in its tooltip. Missing-baseline mode showed `—` for all four metrics. Zero-baseline mode showed `—` when the current metric was positive and the previous value was zero, with both values in the tooltip.
- **Small history dialog:** At 540×720, the dialog stayed within the viewport (top 20, bottom 700); its body had `overflow-y: auto`, a thin scrollbar, and 651 px of content in a 632 px viewport.
- **Synced lyric anchor:** The real `SyncedView` active row stayed at 0.380–0.381 of stage height through collapse, restore, and 125% zoom. Restore returned the track transform to its expanded value.

## Limits

The fixture uses fake artists and listening statistics, so these checks do not establish behavior against a real library, native Tauri commands, actual audio, or network services. The collapse/restore harness changes the real `SyncedView` layout key through fixture buttons; it does not exercise the complete production lyrics page. Keyboard collapse/restore and the month-hover tooltip text were not captured in this pass. The small-screen scrollbar result is based on computed style and scroll geometry, not an OS-level screenshot.

No confirmed functional regression remained in the scenarios listed above after the reduced-motion CSS update.
