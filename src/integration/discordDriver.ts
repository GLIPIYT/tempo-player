import { invoke } from '@tauri-apps/api/core'
import { normalizeLyricText } from '../features/lyrics/lrc'
import { lyricLineAt, lyricsService } from '../features/lyrics/lyricsService'
import { playerController } from '../player/controller'

/**
 * Discord Rich Presence driver, modelled after the proven SoundCloud Desktop
 * implementation: it decides WHEN to push an update (track change, play/pause,
 * synced-lyric line flip, seek drift) and recomputes timestamps at send time
 * (start = now - elapsed), so Discord's progress bar always matches the player.
 * The Rust side is a dumb reliable pipe: it connects, heartbeats, retries.
 */

const SETTINGS_KEY = 'tempo.settings.v1'
/** discord accepts ~5 updates / 20s; non-critical sends wait this long */
const SEND_MIN_GAP_MS = 4000
/** critical sends (track/play) may not wait the full gap, but still spaced */
const SEND_IMMEDIATE_GAP_MS = 1000
/** merge triggers firing together; the timer picks up the freshest state */
const SEND_COALESCE_MS = 250
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
/**
 * The last line that went out, in comparison form (see `lineKey`). Null means
 * nothing has been sent for this track yet - kept distinct from '' so a track
 * without lyrics does not look like a line flip on its first tick.
 */
let lastLine: string | null = null
let lastInvokeAt = 0
/** position seen on the previous tick; a jump between ticks means a seek */
let lastObservedElapsed = -1
let presenceActive = false
let sendTimer: number | null = null
let installed = false

/** local cover path -> public image-host URL (uploads happen once per path) */
const coverUrls = new Map<string, string>()
const coverPending = new Map<string, Promise<void>>()
/** paths whose upload failed -> when another attempt is allowed */
const coverRetryAt = new Map<string, number>()
/** consecutive failures per path, drives the backoff */
const coverFailures = new Map<string, number>()
const UPLOAD_RETRY_BASE_MS = 30_000
const UPLOAD_RETRY_MAX_MS = 15 * 60_000

function activeLine(trackKey: string, position: number): string | null {
  const cur = lyricsService.getCurrent()
  if (!cur || cur.trackId !== trackKey) return null
  return lyricLineAt(cur.result, position)
}

/**
 * The value `lastLine` is compared on. A repeated chorus line usually differs only
 * in case or a trailing dot, and each such near-duplicate would otherwise cost one
 * of the five updates Discord allows per 20s.
 */
function lineKey(line: string | null): string {
  return normalizeLyricText(line)
}

/** Public image URL for the presence, or null to send no assets at all
 *  (discord then shows the application icon). Remote covers go out as-is;
 *  local files are uploaded to the image host in the background. */
function coverImage(track: { coverPath: string | null; sourceId: string }): string | null {
  const path = track.coverPath
  if (!path) return null
  if (/^https?:\/\//.test(path)) return path
  const cached = coverUrls.get(path)
  if (cached) return cached
  const retryAt = coverRetryAt.get(path)
  // a failed upload backs off instead of firing on every presence update
  if (retryAt !== undefined && Date.now() < retryAt) return null
  void uploadCover(path, track.sourceId)
  return null
}

function uploadCover(path: string, sourceId: string): Promise<void> {
  const existing = coverPending.get(path)
  if (existing) return existing
  const pending = invoke<string>('upload_cover', { coverPath: path })
    .then(url => {
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        throw new Error(`image host returned an unusable url: ${String(url)}`)
      }
      coverUrls.set(path, url)
      coverRetryAt.delete(path)
      coverFailures.delete(path)
      // the presence went out without artwork - push a fresh update now
      // that the real cover URL exists
      const snap = playerController.getSnapshot()
      if (snap.currentTrack?.sourceId === sourceId) requestSend(snap, 'cover', true)
    })
    .catch(err => {
      const failures = (coverFailures.get(path) ?? 0) + 1
      coverFailures.set(path, failures)
      const wait = Math.min(UPLOAD_RETRY_BASE_MS * 2 ** (failures - 1), UPLOAD_RETRY_MAX_MS)
      coverRetryAt.set(path, Date.now() + wait)
      // surfaced rather than swallowed: a silent failure here is exactly why the
      // placeholder was so hard to explain
      console.warn(
        `[tempo discord] cover upload failed (attempt ${failures}, retry in ${Math.round(wait / 1000)}s):`,
        err,
      )
    })
    .finally(() => {
      coverPending.delete(path)
    })
  coverPending.set(path, pending)
  return pending
}

function doSend(snap: ReturnType<typeof playerController.getSnapshot>, reason: string): void {
  const settings = readSettings()
  const track = snap.currentTrack
  if (!settings || !track) return
  const playing = snap.isPlaying
  const dur = snap.duration > 0 ? snap.duration : (track.durationSec ?? 0)
  const elapsed = Math.max(0, snap.position)
  const start = playing ? Date.now() - Math.round(elapsed * 1000) : null
  const end = playing && dur > 0 && start !== null ? start + Math.round(dur * 1000) : null
  const line = playing ? activeLine(track.sourceId, snap.position) : null
  if (playing) lastLine = lineKey(line)
  lastInvokeAt = Date.now()
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
    reason,
  }).catch(() => {})
}

/**
 * Single entry point for every presence push. Critical events (track switch,
 * play/pause) go out straight away but never more than once a second; all
 * other triggers (lyric line, seek drift, cover ready) are coalesced and
 * spaced 4s apart so discord's ~5-updates-per-20s budget is never blown -
 * that budget is exactly what made track changes invisible before.
 */
function requestSend(
  snap: ReturnType<typeof playerController.getSnapshot>,
  reason: string,
  immediate = false,
): void {
  if (!snap.currentTrack || !readSettings()) return
  const since = Date.now() - lastInvokeAt
  if (immediate && since >= SEND_IMMEDIATE_GAP_MS) {
    if (sendTimer !== null) {
      window.clearTimeout(sendTimer)
      sendTimer = null
    }
    doSend(snap, reason)
    return
  }
  // latest wins: a scheduled timer always picks up the freshest snapshot
  if (sendTimer !== null) return
  const wait = immediate
    ? SEND_IMMEDIATE_GAP_MS - since
    : Math.max(SEND_COALESCE_MS, SEND_MIN_GAP_MS - since)
  sendTimer = window.setTimeout(() => {
    sendTimer = null
    doSend(playerController.getSnapshot(), `${reason}+deferred`)
  }, wait)
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
  lastObservedElapsed = -1
  if (sendTimer !== null) {
    window.clearTimeout(sendTimer)
    sendTimer = null
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
    lastObservedElapsed = -1
    lastPlaying = snap.isPlaying
    requestSend(snap, 'track', true)
    return
  }
  if (playChanged) {
    lastPlaying = snap.isPlaying
    requestSend(snap, snap.isPlaying ? 'play' : 'pause', true)
    return
  }
  if (!snap.isPlaying) return

  const line = activeLine(track.sourceId, snap.position)
  const jumped = lastObservedElapsed >= 0 && Math.abs(snap.position - lastObservedElapsed) >= SEEK_DRIFT_SEC
  lastObservedElapsed = snap.position
  const key = lineKey(line)
  if (key !== lastLine) {
    lastLine = key
    // a skipped line is fine, the deferred send picks up the current one
    requestSend(snap, 'lyric')
    return
  }

  if (jumped) {
    requestSend(snap, 'seek')
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
