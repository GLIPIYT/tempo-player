# 🎵 Tempo

**English** · [Русский](README.ru.md)

**A local-first desktop music player.** Your files, your library, no accounts, no cloud — everything works offline.

Built with **Tauri 2 + React 18 + TypeScript** on the frontend and **Rust + SQLite** under the hood. No Electron, no backend server, no telemetry.

![Version](https://img.shields.io/badge/version-0.6.0-blue) ![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black) ![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white) ![Rust](https://img.shields.io/badge/Rust-2021-DEA584?logo=rust&logoColor=black) ![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white) ![License](https://img.shields.io/badge/license-MIT-green)

![Tempo — home screen](docs/screenshot.png)

## ✨ Features

### Library

- **Local library** — point Tempo at your music folders (MP3, FLAC, M4A, AAC, OGG, Opus, WAV) and it builds a browsable collection of albums, artists and tracks.
- **Fast incremental scanning** — files are parsed by tag (via `lofty`), album covers are extracted to the app data folder. Unchanged files (same size + mtime) are skipped, so rescans are near-instant. Scanning runs in Rust threads and never blocks the UI.
- **Remove without deleting** — hide a local track from the library and it stays hidden across rescans, while the file itself is left untouched on disk.
- **Reveal in file manager** — jump straight from a track to its folder.
- **Right-click menus everywhere** — tracks, album and artist cards, and home sections, all offering the same actions as the row menu. Sections can be hidden until tomorrow.

### Playback

- **Full playback engine** — queue with shuffle, repeat (off / all / one), seek, volume; play counts and listening history are recorded automatically.
- **Persistent player** — the audio element lives outside the React tree, so navigating around the app never interrupts a track.
- **Taskbar progress** — playback position mirrored onto the Windows taskbar.
- **Optional waveform** — a wave-style progress bar instead of the plain one.
- **Crossfade** — overlap the end of a track with the start of the next, anywhere from 1 to 12 seconds. Off by default.
- **Spectrum visualiser** — a live spectrum on a band above the player bar, drawn as bars, a wave or a line in the theme accent, with adjustable detail, height, opacity and smoothing. It reads the same analyser the silence watchdog uses, so it reflects what you actually hear: after loudness normalisation and after the crossfade ramp. Tracks streamed without a cache play outside the audio graph, so the band stays blank on those.

### Playlists & favorites

- **Playlists** — create, reorder, rename; add tracks from anywhere in the app.
- **Likes** — a built-in, always-pinned Likes playlist.
- **Favorite artists and albums** — pin them next to your playlists in the sidebar, in one shared drag-and-drop order.
- **M3U8 import & export** — move playlists in and out of Tempo.

### Lyrics

- **Synced lyrics** — from embedded tags, `.lrc` sidecar files, or five online providers (lrclib, textyl, Musixmatch, lyrics.ovh, Genius) as a fallback.
- **Distraction-free overlay** — the active line highlighted, with lookahead.
- **Pin and nudge** — pin a specific provider, or even another song's lyrics, per track, and shift the timing by milliseconds until it lines up.

### Beyond your library

- **SoundCloud provider** — search and stream from SoundCloud alongside your local library through a unified provider abstraction. Streams are cached on disk with a configurable size limit and least-recently-played eviction; a cached track joins your library automatically.
- **Cache before playing** — optional: download a SoundCloud track in full before it starts. The first play waits a little, but the track then comes off disk instead of streaming past the audio graph, which is what lets the spectrum visualiser work on it.
- **Discord Rich Presence** — show what you're listening to, with cover art, a real progress bar, and the current lyric line. Talks to Discord over the local IPC pipe; off by default.

### Look and feel

- **Floating mini player** — a compact always-on-top window that rests as a pill at the top edge of the screen. Click to expand into cover, transport, seek, volume, like, repeat and shuffle; it can pop open on its own when the track changes and collapse again. Off by default.
- **Ten built-in themes** — plus a custom mode where you pick base colours and override individual tokens.
- **Two player bar layouts** — classic keeps the progress bar between the transport and the volume controls; modern centres the transport and runs the progress line along the top edge of the bar.
- **Your own font and background** — import a font file, set a background image with adjustable dim and blur, scale the whole UI.
- **Bilingual UI** — English and Russian out of the box, or follow the system language.

### Staying current

- **Built-in updater** — Tempo checks GitHub for new releases when it starts and offers the newest one you have not skipped. The changelog is the release's own notes, and download and install are a single action: the app closes and comes back on the new version. Settings lists every release above the one you are running, so an older version can be picked deliberately, and a skipped release comes back as soon as a newer one exists.

## 🖥️ Screens

Home · Library · Albums · Artists · Playlists · Search · Profile · Settings — plus album, artist and playlist detail views, a persistent player bar and a queue panel. Listening statistics and history live on the Profile screen.

## 🧱 Tech stack

| Layer | Tech |
|---|---|
| Shell | Tauri 2 (no Electron) |
| UI | React 18 + TypeScript (strict) + Vite 6, `lucide-react` icons, hand-rolled CSS (no framework) |
| Playback | HTML5 `<audio>` singleton + pure queue controller (shuffle permutation, repeat modes), `hls.js` for SoundCloud |
| Backend | Rust: `rusqlite` (bundled SQLite, WAL mode), `walkdir`, `lofty`, `reqwest`, `image` |
| Data | Single SQLite file in the app data dir; ordered migrations tracked via `user_version` |
| Search | SQL `LIKE` queries across tracks / albums / artists, paged lists (500/page) |

## 🚀 Getting started

**Prerequisites:** [Node.js 18+](https://nodejs.org), [Rust](https://rustup.rs), and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
# install dependencies
npm install

# run in development mode
npm run tauri dev

# build a release installer (Windows: NSIS .exe)
npm run tauri build
```

The frontend can also be developed standalone (`npm run dev`) with Vite hot reload on port 1420 — though anything touching the library or playback needs the Rust core, so use `tauri dev` for real work.

Checks:

```bash
npm run typecheck                                  # TypeScript, strict
cargo test --manifest-path src-tauri/Cargo.toml    # 62 Rust unit tests
```

## 📁 Project structure

```
src/                  # React frontend
  api/                #   typed wrappers over Tauri commands + event subscriptions
  components/         #   shared UI, layout (sidebar, player bar, queue), onboarding
  dnd/                #   drag-and-drop for tracks and sidebar favorites
  features/lyrics/    #   lyrics providers, LRC parsing, overlay
  hooks/              #   async data, likes, folders, scan progress
  i18n/               #   EN / RU translations
  pages/              #   Home, Library, Albums, Artists, Playlists, Search, Profile, Settings + detail views
  player/             #   playback engine: controller, queue, React bindings
  providers/          #   music source abstraction (local, SoundCloud)
  state/              #   routing + persisted settings
  theme/              #   token engine + presets
src-tauri/            # Rust backend
  src/database.rs     #   SQLite layer + migrations
  src/commands.rs     #   Tauri command surface (Result<T, String>)
  src/scanner.rs      #   filesystem walk + incremental scan logic
  src/metadata.rs     #   tag & cover extraction (lofty)
  src/lyrics.rs       #   online lyrics providers
  src/soundcloud*.rs  #   SoundCloud API client + stream cache
  src/discord.rs      #   Rich Presence over the local IPC pipe
```

The full architecture, data model and module contracts are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

## 🗺️ Status

`v0.6.0` — alpha, Windows-first. Playback, library scanning, playlists, favorites, lyrics, search, SoundCloud, Discord presence, a floating mini player, right-click menus throughout, two player bar layouts, crossfade, a spectrum visualiser and a built-in updater all work. The release pipeline currently ships a Windows NSIS installer only; the codebase itself has no Windows-specific dependencies beyond the Discord IPC pipe path and taskbar progress.

Known gaps: the frontend has no automated tests yet, and there is no linter in CI.

## 📄 License

Released under the [MIT License](LICENSE).
