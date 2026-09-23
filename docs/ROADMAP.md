# Functional roadmap

This file keeps the agreed product ideas with the repository so they remain available across sessions.

## 1. Lyrics source and version selection — implemented

- Return every useful LRCLIB result instead of silently choosing the first synced result (or first plain result).
- Include LRCLIB's record ID, track, artist, album, duration, instrumental flag, and available plain/synced text.
- Show enough match details to distinguish album versions, remasters, edits, and sped-up tracks; keep the synced/plain badge.
- Let the user pin a specific result to a local track and return to automatic selection.
- Preserve existing provider selection and per-track timing offset. Deduplicate exact duplicates without hiding distinct versions.
- LRCLIB search exposes recording/release metadata, not a lyric contributor name; the picker distinguishes records and text versions rather than uploaders.

## 2. Playback speed

- Add a speed control with useful presets and a reset to 1×.
- Offer pitch preservation where supported; keep speed changes consistent across playback channels and crossfades.
- Keep synced lyrics anchored to media position for ordinary playback-rate changes.

## 3. Equalizer

- Add a small parametric or graphic EQ with a few presets and user presets.
- Start on the local/cached audio graph, where Web Audio filters can be applied safely.
- Decide how uncached online streams should participate before promising EQ for every source; those currently bypass the graph to avoid cross-origin silence.
- Prevent filter boosts from clipping with suitable preamp/headroom handling.

## 4. Lyrics timing and appearance

- Extend the existing per-track offset with a time-scale adjustment for alternate edits and sped-up/slowed-down recordings.
- Consider two-point calibration: match one line near the start and another later, then derive offset and scale.
- Add lyric-specific controls for size, line spacing, current-line emphasis, and background/contrast.

## 5. Smart playlists

- Build rule-based playlists from existing library data, such as recently added, most played, never played, and tracks not heard recently.
- Keep their results dynamic as play counts and library contents change.
