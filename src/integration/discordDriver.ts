import { invoke } from '@tauri-apps/api/core'
import { lyricLineAt, lyricsService } from '../features/lyrics/lyricsService'
import { playerController } from '../player/controller'

/**
 * Discord Rich Presence driver, modelled after the proven SoundCloud Desktop
 * implementation: it decides WHEN to push an update (track change, play/pause,
 * synced-lyric line flip, seek drift) and recomputes timestamps at send time
 * (start = now - elapsed), so Discord's progress bar always matches the player.
 * The Rust side is a dumb reliable pipe: it connects, heartbeats, retries.
 */

const LOGO_ASSET = 'tempo_logo'
const SETTINGS_KEY = 'tempo.settings.v1'
/** discord accepts ~5 updates / 20s; lyric-heavy tracks must stay inside it */
const LYRIC_MIN_GAP_MS = 4000
const SEEK_DEBOUNCE_MS = 300
/** a position jump bigger than this (seek / buffering) re-syncs the timeline */
const SEEK_DRIFT_SEC = 2

interface DriverSettings {
  clientId: string
  lang: 'ru' | 'en' | 'system'
  lyricsCache: boolean
}

function readSettings(): DriverSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as {
      discord?: { enabled?: boolean; clientId?: string }
      lang?: 'ru' | 'en' | 'system'
      lyrics?: { cacheOnline?: boolean }
    }
    if (!s.discord?.enabled || !s.discord.clientId?.trim()) return null
    return {
      clientId: s.discord.clientId.trim(),
      lang: s.lang ?? 'system',
      lyricsCache: s.lyrics?.cacheOnline ?? true,
    }
  } catch {
    return null
  }
}

function pausedLabel(lang: DriverSettings['lang']): string {
  const ru = lang === 'ru' || (lang === 'system' && navigator.language.toLowerCase().startsWith('ru'))
  return ru ? 'На паузе' : 'Paused'
}

let lastTrackKey: string | null = null
let lastPlaying = false
let lastLine: string | null = null
let lastSentAt = 0
let lastSentElapsed = -1
let presenceActive = false
let seekTimer: number | null = null
let installed = false

/** local cover path -> public catbox URL (uploads happen once per path) */
const coverUrls = new Map<string, string>()
const coverPending = new Map<string, Promise<void>>()

function activeLine(trackKey: string, position: number): string | null {
  const cur = lyricsService.getCurrent()
  if (!cur || cur.trackId !== trackKey) return null
  return lyricLineAt(cur.result, position)
}

/** Public image URL for the presence. Remote covers go out as-is; local files
 *  are uploaded to catbox in the background and start out as the logo asset. */
function coverImage(track: { coverPath: string | null; sourceId: string }): string {
  const path = track.coverPath
  if (!path) return LOGO_ASSET
  if (/^https?:\/\//.test(path)) return path
  const cached = coverUrls.get(path)
  if (cached) return cached
  void uploadCover(path, track.sourceId)
  return LOGO_ASSET
}

function uploadCover(path: string, sourceId: string): Promise<void> {
  const existing = coverPending.get(path)
  if (existing) return existing
  const pending = invoke<string>('catbox_upload_cover', { path })
    .then(url => {
      if (typeof url === 'string' && url.startsWith('https://')) {
        coverUrls.set(path, url)
        // the presence went out with the logo - push a fresh update now that
        // the real artwork URL exists
        const snap = playerController.getSnapshot()
        if (snap.currentTrack?.sourceId === sourceId) sendPresence(snap)
      }
    })
    .catch(() => {})
    .finally(() => {
      coverPending.delete(path)
    })
  coverPending.set(path, pending)
  return pending
}

function sendPresence(snap: ReturnType<typeof playerController.getSnapshot>): void {
  const settings = readSettings()
  const track = snap.currentTrack
  if (!settings || !track) return
  const playing = snap.isPlaying
  const dur = snap.duration > 0 ? snap.duration : (track.durationSec ?? 0)
  const elapsed = Math.max(0, snap.position)
  const start = playing ? Date.now() - Math.round(elapsed * 1000) : null
  const end = playing && dur > 0 && start !== null ? start + Math.round(dur * 1000) : null
  const line = playing ? activeLine(track.sourceId, snap.position) : null
  if (playing) lastLine = line
  lastSentAt = Date.now()
  lastSentElapsed = elapsed
  presenceActive = true
  void invoke('discord_set_presence', {
    clientId: settings.clientId,
    details: track.title,
    state: playing
      ? line ?? (track.artists.join(', ') || null)
      : pausedLabel(settings.lang),
    startMs: start,
    endMs: end,
    largeImage: coverImage(track),
    smallImage: null,
  }).catch(() => {})
}

function clearPresence(): void {
  if (!presenceActive) return
  presenceActive = false
  void invoke('discord_clear_presence').catch(() => {})
}

function resetTracking(): void {
  lastTrackKey = null
  lastPlaying = false
  lastLine = null
  lastSentElapsed = -1
  if (seekTimer !== null) {
    window.clearTimeout(seekTimer)
    seekTimer = null
  }
}

function onPlayerChange(): void {
  const snap = playerController.getSnapshot()
  const track = snap.currentTrack
  const settings = readSettings()
  if (!track || !settings) {
    clearPresence()
    resetTracking()
    return
  }

  const trackChanged = track.sourceId !== lastTrackKey
  const playChanged = snap.isPlaying !== lastPlaying

  if (trackChanged) {
    lyricsService.ensure(track, settings.lyricsCache)
    lastTrackKey = track.sourceId
    lastLine = null
    lastSentElapsed = -1
    lastPlaying = snap.isPlaying
    sendPresence(snap) // track switch is critical: always goes out immediately
    return
  }
  if (playChanged) {
    lastPlaying = snap.isPlaying
    sendPresence(snap) // pause/resume must freeze/restart the discord timer
    return
  }
  if (!snap.isPlaying) return

  const line = activeLine(track.sourceId, snap.position)
  if (line !== lastLine) {
    lastLine = line
    // rate-limit lyric pushes; a skipped line is fine, the next flip catches up
    if (Date.now() - lastSentAt >= LYRIC_MIN_GAP_MS) sendPresence(snap)
    return
  }

  if (lastSentElapsed >= 0 && Math.abs(snap.position - lastSentElapsed) >= SEEK_DRIFT_SEC) {
    if (seekTimer === null) {
      seekTimer = window.setTimeout(() => {
        seekTimer = null
        sendPresence(playerController.getSnapshot())
      }, SEEK_DEBOUNCE_MS)
    }
  }
}

/** Re-evaluates presence after a settings change (e.g. RPC disabled). */
export function discordSettingsChanged(): void {
  onPlayerChange()
}

/** Wires the driver to the player; returns an unsubscribe function. */
export function startDiscordDriver(): () => void {
  if (installed) return () => {}
  installed = true
  const unsubPlayer = playerController.subscribe(onPlayerChange)
  const unsubLyrics = lyricsService.subscribe(onPlayerChange)
  return () => {
    installed = false
    unsubPlayer()
    unsubLyrics()
  }
}
