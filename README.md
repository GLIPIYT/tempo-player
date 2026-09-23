# Tempo

<p align="center">
  <strong>Your music, together in one player.</strong><br>
  A local-first desktop player for the music you own and the music you find.
</p>

<p align="center">
  <a href="README.ru.md">Русская версия</a> ·
  <a href="https://github.com/GLIPIYT/tempo-player/actions/workflows/ci.yml"><img src="https://github.com/GLIPIYT/tempo-player/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a> ·
  <a href="LICENSE">MIT License</a>
</p>

Tempo is a local-first music player for Windows that brings your files, SoundCloud and YouTube Music into one library and queue. Your collection stays on your computer, and playback keeps going as you move between pages.

**[Get Tempo](https://github.com/GLIPIYT/tempo-player/releases)** · **[Report a problem](https://github.com/GLIPIYT/tempo-player/issues)**

<p align="center">
  <img src="docs/screenshots/tempo-showcase.png" alt="A visual tour of Tempo's home, library, albums, artists, playlists and settings" width="100%">
</p>

## One place for your music

| | |
|---|---|
| **Your files, in one library** | Scan MP3, FLAC, M4A, AAC, OGG, Opus and WAV folders. Tempo reads tags, finds covers and makes later scans incremental. Hide tracks without moving or deleting files. |
| **Music that travels with you** | Search SoundCloud and YouTube Music beside your local collection. Build a queue, shuffle, repeat, tune crossfade and loudness, change playback speed, shape local or cached tracks with a ten-band EQ, and choose a waveform or spectrum visualiser. |
| **A player that feels like yours** | Create playlists, like tracks, pin artists and albums, follow synced lyrics, and choose a theme, background, font and player layout. |

Tempo also includes a floating mini player, Discord Rich Presence, listening history, M3U8 playlist import/export and a built-in updater. You can use the local library without an account or cloud service.

## Get started

Current releases are Windows NSIS installers. To build Tempo from source, install [Node.js 22](https://nodejs.org/), [Rust](https://rustup.rs/) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/GLIPIYT/tempo-player.git
cd tempo-player
npm ci
npm run tauri dev
```

Create a Windows installer with `npm run tauri build`. For frontend-only work, `npm run dev` starts Vite; features that use the library or playback need the Tauri backend.

## Under the hood

| Area | Implementation |
|---|---|
| Desktop | Tauri 2; React 18, TypeScript and Vite |
| Playback | Persistent HTML audio engine, queue controller and `hls.js` for SoundCloud |
| Native core | Rust commands for scanning, metadata, networking and app integration |
| Storage | SQLite with ordered migrations; music files stay in their original folders |
| Sources | Local files, SoundCloud and YouTube Music through a shared track model |

The frontend crosses into Rust through typed wrappers in `src/api/`. The Rust core owns the database and filesystem work; React pages and providers work with shared track models. See [ARCHITECTURE.md](ARCHITECTURE.md) for the data model, module boundaries and runtime flows.

## Development checks

```bash
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

GitHub Actions runs frontend type checks, tests, hook-order and lint checks, workflow linting, and Rust tests on pushes and pull requests to `main`.

## Project

Tempo is in alpha (`0.8.3`) and Windows-first. The release workflow currently publishes a Windows installer. Network access is used by online features and the updater; the local library does not require an account or cloud service.

[Releases](https://github.com/GLIPIYT/tempo-player/releases) · [Issues](https://github.com/GLIPIYT/tempo-player/issues) · [Architecture](ARCHITECTURE.md)

Released under the [MIT License](LICENSE).
