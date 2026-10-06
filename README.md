# Tempo

<p align="center">
  <strong>Your music, together in one player.</strong><br>
  A Windows desktop player for your local collection and the music you find online.
</p>

<p align="center">
  <a href="README.ru.md">Русская версия</a> ·
  <a href="https://github.com/GLIPIYT/tempo-player/releases">Download for Windows</a> ·
  <a href="https://github.com/GLIPIYT/tempo-player/actions/workflows/ci.yml"><img src="https://github.com/GLIPIYT/tempo-player/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a> ·
  <a href="LICENSE">MIT License</a>
</p>

<p align="center">
  <a href="docs/screenshots/1.0.0/">
    <img src="docs/screenshots/tempo-showcase-en.png" alt="Tempo walkthrough: Home, library, albums, artists, playlists, search, playback, lyrics, profile and settings" width="100%">
  </a>
</p>

## What Tempo brings together

- **Your local library.** Scan folders with MP3, FLAC, M4A, AAC, OGG, Opus and WAV files. Tempo reads track tags and artwork, then lets you browse by track, album, artist or playlist. Your original music files stay where they are.
- **Online discovery.** Search SoundCloud and YouTube Music beside your own tracks. Build a queue from what you find, and cache supported tracks for later playback.
- **A player you can tune.** Use playlists, shuffle, repeat, playback speed, crossfade and loudness normalization. The ten-band equalizer works with local and cached audio; choose a waveform or spectrum visualizer.
- **Lyrics and listening history.** Follow synced lyrics, adjust their timing or edit the text. Your profile shows listening activity and recent plays.
- **A space that feels personal.** Choose themes, backgrounds, fonts and interface scale. Tempo also includes a floating mini player, Discord Rich Presence and M3U8 playlist import and export.
- **Recommendations on Home.** Browse a SoundCloud recommendation feed and a separate shelf for a frequently played genre.

## Keyboard shortcuts

Shortcuts work while Tempo is active and focus is outside a text field or control.

| Key | Action |
|---|---|
| `Space` | Play or pause |
| `←` / `→` | Previous or next track |
| `Ctrl` + `←` / `→` | Seek backward or forward by one second |
| `↑` / `↓` | Raise or lower volume by 5% |
| `M` | Mute or restore volume |
| `S` | Toggle shuffle |
| `R` | Cycle repeat: off, all, one |

## Install

Download the current Windows installer from [GitHub Releases](https://github.com/GLIPIYT/tempo-player/releases). The release workflow publishes an NSIS installer.

## Build from source

Tempo uses Node.js 22, stable Rust and the [Tauri prerequisites for Windows](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/GLIPIYT/tempo-player.git
cd tempo-player
npm ci
npm run tauri dev
```

Build a Windows installer with:

```bash
npm run tauri build
```

`npm run dev` starts the frontend only. The library, audio playback and native integrations require the Tauri app.

## Checks

Run the same frontend and Rust checks used by the repository's CI:

```bash
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

GitHub Actions runs the frontend type check, Vitest tests, hook-order check, ESLint, workflow linting and Rust tests on pushes and pull requests to `main`.

## Technology

| Area | Stack |
|---|---|
| Desktop app | Tauri 2 |
| Frontend | React 18, TypeScript and Vite |
| Native services | Rust commands for scanning, metadata, networking and system integration |
| Storage | SQLite; local music files remain in their original folders |
| Audio | HTML audio playback and `hls.js` for SoundCloud streams |

The frontend calls the Rust core through typed wrappers in `src/api/`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the application structure and data flows.

## Local data and online services

Tempo does not require an account for your local library. Library data, playlists and listening history are stored on the device. Online search, streams, lyrics, recommendations and update checks need an internet connection and depend on the relevant provider being available.

## Project links

[Releases](https://github.com/GLIPIYT/tempo-player/releases) · [Issues](https://github.com/GLIPIYT/tempo-player/issues) · [Architecture](ARCHITECTURE.md) · [License](LICENSE)
