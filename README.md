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
  <a href="docs/design/changelog-1.6.0/tempo-1.6.0-changelog.webp">
    <img src="docs/design/changelog-1.6.0/figures/home.webp" alt="Tempo Home in a light theme" width="100%">
  </a>
</p>

## Tempo 1.6 — a lighter look

Light themes, a new Home layout, and more control over how each track sounds.

- **Light, dark or automatic.** Choose a palette or set the appearance of a custom theme. The Settings sidebar takes you straight to the right section.
- **Your mixes on Home.** Expand the mix column or browse recommendations, likes and recently played tracks in their own shelves.
- **Volume and speed per track.** Tempo remembers your preferences and can draw waveforms from local and YouTube Music audio.
- **A listening report for each playlist.** Open the graph on a local album, artist or playlist page. The diagnostics panel in About checks music services and other connections.

<details>
<summary><strong>See the 1.6 update in pictures</strong></summary>

![Tempo 1.6.0](docs/design/changelog-1.6.0/tempo-1.6.0-changelog.webp)

</details>

[What’s new in 1.6.0](docs/releases/v1.6.0.md) · [Download Tempo](https://github.com/GLIPIYT/tempo-player/releases/latest)

## What Tempo brings together

- **Your local library.** Scan folders with MP3, FLAC, M4A, AAC, OGG, Opus and WAV files. Tempo reads track tags and artwork, then lets you browse by track, album, artist or playlist. Your original music files stay where they are.
- **Online discovery.** Search SoundCloud and YouTube Music beside your own tracks. Build a queue from what you find, and cache supported tracks for later playback.
- **A player you can tune.** Use playlists, shuffle, repeat, playback speed, crossfade and loudness normalization. The ten-band equalizer works with local and cached audio; choose a waveform or spectrum visualizer.
- **Lyrics and listening history.** Follow synced lines and words, edit lyrics or combine text with another version’s timings. Your profile opens listening details by month, day and hour.
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
| Audio | Native Rust playback with rodio, DSP and managed FFmpeg for streams and additional formats |

The frontend calls the Rust core through typed wrappers in `src/api/`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the application structure and data flows.

## Local data and online services

Tempo does not require an account for your local library. Library data, playlists and listening history are stored on the device. Online search, streams, lyrics, recommendations and update checks need an internet connection and depend on the relevant provider being available.

Streaming and some file formats, including Opus, use an FFmpeg decoder downloaded automatically on first use. That initial download needs internet access; the decoder is then kept on the device for offline playback of supported local and cached files.

## Project links

[Releases](https://github.com/GLIPIYT/tempo-player/releases) · [Issues](https://github.com/GLIPIYT/tempo-player/issues) · [Architecture](ARCHITECTURE.md) · [License](LICENSE)
