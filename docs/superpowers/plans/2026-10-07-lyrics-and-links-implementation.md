# Lyrics Appearance and External Link Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix recommendation artwork and external browser links, then add responsive, persistent controls for lyric alignment, size, fill, and progress-line appearance.

**Architecture:** Reuse the existing `ScArtwork` fallback component and Tauri opener plugin through one HTTP(S)-only utility. Store lyric presentation preferences in the existing local settings object; render them through CSS custom properties and a small geometry helper that measures the active text bounds.

**Tech Stack:** React 18, TypeScript, Vite, Tauri 2 opener plugin, CSS, localStorage-backed settings.

**Spec:** `docs/superpowers/specs/2026-10-07-lyrics-and-links-design.md`

## Global Constraints

- Work directly on `main`; do not create a branch or worktree.
- Commit each finished implementation task to `main` and push it to `origin/main`.
- Keep the current Tauri dev session running and use its Vite hot reload; restart it only if Tauri capability changes require a reload.
- Do not perform manual UI checks; the user will check the result.
- Do not add or run automated tests for this task; verify with `npm run build` and inspect the diff.
- Keep the existing Lyrics settings card and overlay structure; avoid unrelated UI redesign.

## Review Focus

- Unsupported URL schemes and malformed URLs must be rejected; a system-browser failure must surface a localized toast. Leave the browser interaction check to the user.
- A missing or broken recommendation artwork URL must reach the title fallback without showing a broken-image glyph. User checks this with recommendations that currently show the music-note placeholder.
- Older or malformed stored lyric settings must resolve to valid defaults. Verify statically through the loader/normalizer and build, without adding tests.
- A one-word lyric and a wrapped long lyric must not make a clipped progress path cross the rendered text bounds. User checks short and long lines in left/center/right alignment.
- Narrow and wide windows must keep the lyrics area responsive without horizontal overflow; user checks scaling and resizing.

---

### Task 1: Open external links through Tauri

**Files:**
- Create: `src/utils/externalLinks.ts`
- Modify: `src/updater/ReleaseNotes.tsx`
- Modify: `src/components/common/ScCards.tsx`
- Modify: `src/components/common/YtCard.tsx`
- Modify: `src/pages/SearchPage.tsx`
- Modify: `src/pages/ScArtistPage.tsx`
- Modify: `src/pages/ScPlaylistPage.tsx`
- Modify: `src/pages/YtCollectionPage.tsx`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/i18n/en.ts`, `src/i18n/ru.ts`

**Interfaces:**
- Produces `openExternalUrl(url: string): Promise<void>`; it parses an absolute URL, accepts only `http:` and `https:`, then calls `openUrl` from `@tauri-apps/plugin-opener`. Invalid URLs reject with an error.
- UI callers catch failures and show a localized `Could not open external link` toast.

- [ ] **Step 1: Add the shared opener and localized failure copy.** Keep URL parsing and protocol validation in the helper; do not silently ignore rejected URLs.
- [ ] **Step 2: Replace the affected `window.open` handlers.** Update the release-note anchors and external SoundCloud/YouTube Music actions listed above; retain their existing navigation and context-menu behavior.
- [ ] **Step 3: Permit web destinations in the main-window opener capability.** Allow HTTP(S) destinations while keeping validation in the helper so non-web schemes never reach the OS opener.
- [ ] **Step 4: Review the touched handlers and capability diff, then commit and push.**

**Commit:** `fix: open external links from the desktop app`

### Task 2: Use the shared artwork fallback in recommendations

**Files:**
- Modify: `src/components/home/RecommendationsShelf.tsx`
- Modify: `src/styles/home.css`
- Reuse: `src/components/common/ScArtwork.tsx`

**Interfaces:**
- Keep the recommendation card's existing `track.artworkUrl` as the primary URL and pass the track title to `ScArtwork` for its terminal fallback.
- The artwork box remains exactly the existing 118×118 card area; playback, drag-and-drop, and cache controls are unchanged.

- [ ] **Step 1: Replace the bare recommendation `<img>` and musical-note placeholder with `ScArtwork`.** Keep the cover wrapper and existing track click/drag behavior intact.
- [ ] **Step 2: Add recommendation-specific sizing for `.sc-art-box`, `.sc-art`, and the title fallback.** Ensure the common component fills the cover area without changing card geometry.
- [ ] **Step 3: Review the component/CSS diff, then commit and push.**

**Commit:** `fix: fall back from broken recommendation artwork`

### Task 3: Persist lyric appearance settings and add visual controls

**Files:**
- Modify: `src/state/settings.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/styles/theme.css`
- Modify: `src/i18n/en.ts`, `src/i18n/ru.ts`

**Interfaces:**
- Extend `AppSettings['lyrics']` with `textSizePx`, `fillEnabled`, `progressDirection` (`left-to-right | right-to-left | center-out`), `progressColorMode` (`theme | custom`), `progressColor`, `progressOpacityPct`, `progressThicknessPx`, and `progressClipToText`.
- Defaults: 21 px, fill enabled, left-to-right, theme color, `#ffffff` custom color, 35% opacity, 1.5 px thickness, and clip-to-text enabled. Clamp size to 16–40 px, opacity to 5–100%, and thickness to 1–6 px in 0.5 px steps; normalize enums and hex color when loading.
- Keep the existing `lyrics.alignment` values (`left | center | right`) and localStorage key unchanged.

- [ ] **Step 1: Add the types, defaults, and normalization for all new lyric settings.** Ensure an older settings object without these fields resolves to the specified defaults.
- [ ] **Step 2: Replace the text-only alignment segmented control with three compact visual preview cards.** Keep left/center/right meanings and accessible labels/pressed state.
- [ ] **Step 3: Add the text-size, fill, direction, theme/custom color, opacity, thickness, and clipping controls to the existing Lyrics card.** Keep settings compact and use the shared slider/switch styling.
- [ ] **Step 4: Add concise English and Russian labels and styles for the preview cards.** Review the complete settings diff, then commit and push.

**Commit:** `feat: add lyric appearance controls`

### Task 4: Apply lyric settings to layout, notes, and progress rendering

**Files:**
- Create: `src/features/lyrics/progressGeometry.ts`
- Modify: `src/features/lyrics/LyricsOverlay.tsx`
- Modify: `src/features/lyrics/lyrics.css`
- Modify: `src/styles/theme.css`

**Interfaces:**
- `resolveLyricProgressGeometry(row: DOMRectReadOnly, text: DOMRectReadOnly, alignment: 'left' | 'center' | 'right', clipToText: boolean): { leftPx: number; widthPx: number }` positions a responsive progress path with a maximum width of 420 CSS pixels and optionally clamps it to the active rendered text bounds.
- `LyricsOverlay` passes the persisted lyric settings to the synced/plain views using CSS custom properties for font size, color, opacity, and thickness.

- [ ] **Step 1: Expand `.lyr-body` and lyric content to use available width.** Preserve the artwork/player column and the existing narrow-window single-column layout.
- [ ] **Step 2: Align `.lyr-notes` with the selected lyric alignment.** Center and right alignment must move the pause animation with the lyric text.
- [ ] **Step 3: Add responsive geometry for the fixed-width progress path.** Measure active text bounds when the active line/layout changes, not on every playback tick; position the path according to alignment and clamp it only when the setting is enabled.
- [ ] **Step 4: Render left-to-right, right-to-left, and center-out progress using transform origins.** Apply theme/custom color, opacity, and thickness; keep theme gradients when theme color is selected.
- [ ] **Step 5: Apply the configured base font size to synced and plain lyrics.** Preserve the current active-line size ratio; when fill is disabled, show the active line as a static highlight without progressive text fill.
- [ ] **Step 6: Review layout and rendering changes, then commit and push.**

**Commit:** `feat: apply lyric appearance settings`

### Task 5: Compile and hand over manual checks

**Files:**
- Verify: all files listed above.
- Update: `.task-plans/07.10.26 plan.md` with the final result and commit/push state.

- [ ] **Step 1: Run `npm run build`.** Expected: TypeScript and Vite build complete successfully; do not run test scripts.
- [ ] **Step 2: Confirm the existing Vite and `target/debug/tempo.exe` processes remain active.** Restart the current `npm run tauri dev` session only if capability changes were not picked up.
- [ ] **Step 3: Inspect `git diff --check` and `git status --short --branch`.** Expected: no whitespace errors and no uncommitted task files.
- [ ] **Step 4: Give the user a concise manual checklist for artwork fallback, browser links, lyric alignment/layout, all new controls, and settings persistence.**
