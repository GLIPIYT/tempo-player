# Functional roadmap

This file keeps the agreed product ideas with the repository so they remain available across sessions.

## 1. Lyrics source and version selection — implemented

- Return every useful LRCLIB result instead of silently choosing the first synced result (or first plain result).
- Include LRCLIB's record ID, track, artist, album, duration, instrumental flag, and available plain/synced text.
- Show enough match details to distinguish album versions, remasters, edits, and sped-up tracks; keep the synced/plain badge.
- Let the user pin a specific result to a local track and return to automatic selection.
- Preserve existing provider selection and per-track timing offset. Deduplicate exact duplicates without hiding distinct versions.
- LRCLIB search exposes recording/release metadata, not a lyric contributor name; the picker distinguishes records and text versions rather than uploaders.

## 2. Playback speed — implemented

- Add a speed control with useful presets and a reset to 1×. Done: the player bar offers 0.5×–2× presets and a reset.
- Offer pitch preservation where supported; keep speed changes consistent across playback channels and crossfades. Done: rate and pitch preference apply to both engine channels and the outgoing crossfade element.
- Keep synced lyrics anchored to media position for ordinary playback-rate changes. Done: lyrics continue to follow the media element's current time.

## 3. Equalizer — implemented

- Added a five-band graphic EQ with flat, bass, treble, vocal and rock presets, editable custom settings, and up to 12 named user presets.
- EQ runs on the local/cached audio graph. Uncached SoundCloud streams still bypass that graph to avoid cross-origin silence, and the settings card explains the limit.
- Automatic headroom is calculated from the combined filter response to prevent boosted bands from clipping.

## 4. Lyrics timing and appearance

- Extend the existing per-track offset with a time-scale adjustment for alternate edits and sped-up/slowed-down recordings.
- Consider two-point calibration: match one line near the start and another later, then derive offset and scale.
- Add lyric-specific controls for size, line spacing, current-line emphasis, and background/contrast.

## 5. Smart playlists

- Build rule-based playlists from existing library data, such as recently added, most played, never played, and tracks not heard recently.
- Keep their results dynamic as play counts and library contents change.
