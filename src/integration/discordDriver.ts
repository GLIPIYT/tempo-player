import { invoke } from '@tauri-apps/api/core'
import { normalizeLyricText } from '../features/lyrics/lrc'
import { lyricSliceAt, lyricsService } from '../features/lyrics/lyricsService'
import type { LyricSlice } from '../features/lyrics/lyricsService'
import { playerController } from '../player/controller'

/**
 * Discord Rich Presence driver, modelled after the proven SoundCloud Desktop
 * implementation: it decides WHEN to push an update (track change, play/pause,
 * synced-lyric line flip, seek drift) and recomputes timestamps at send time
 * (start = now - elapsed), so Discord's progress bar always matches the player.
 * The Rust side is a dumb reliable pipe: it connects, heartbeats, retries.
 */

const SETTINGS_KEY = 'tempo.settings.v1'
/**
 * Discord's real budget is about five updates inside a sliding 20s window - not a
 * fixed pause between two of them. Modelling it as a window is what lets a pair of
 * fast lyric lines go out back to back instead of one of them being dropped.
 */
const RATE_WINDOW_MAX = 5
const RATE_WINDOW_MS = 20_000
/**
 * Slots held back from ordinary updates. A track change or a play/pause must never
 * queue behind a chorus: those are the events the user is actually looking at.
 */
const RATE_CRITICAL_RESERVE = 1
/** two frames in the same instant race in discord's own ordering */
const SEND_MIN_SPACING_MS = 1000
/** merge triggers firing together; the timer picks up the freshest state */
const SEND_COALESCE_MS = 250
/** a position jump bigger than this (seek / buffering) re-syncs the timeline */
const SEEK_DRIFT_SEC = 2
/**
 * Two lines closer together than this cannot each have their own update - the
 * window would eat one - so they are sent together, the current line as `state`
 * and the next as the third row. Above it each line gets its own update and the
 * second slot stays empty.
 */
const LYRIC_PAIR_MAX_GAP_SEC = 2

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
/**
 * A line already shown in the second slot of an earlier update, in comparison
 * form. When it becomes the active line no new update is sent: it is on screen
 * already, and spending a request to move it up one row would cost the line after
 * it. Cleared as soon as the active line moves past it.
 */
let pairedAhead: string | null = null
/** timestamps of the frames actually handed to discord, newest last */
let sendTimes: number[] = []
/** position seen on the previous tick; a jump between ticks means a seek */
let lastObservedElapsed = -1
let presenceActive = false
let sendTimer: number | null = null
/** when the scheduled send is due, so a nearer trigger can pull the timer in */
let sendAt = 0
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

function activeSlice(trackKey: string, position: number): LyricSlice {
  const cur = lyricsService.getCurrent()
  if (!cur || cur.trackId !== trackKey) return { text: null, nextText: null, gapSec: Infinity }
  return lyricSliceAt(cur.result, position)
}

/**
 * The value `lastLine` is compared on. A repeated chorus line usually differs only
 * in case or a trailing dot, and each such near-duplicate would otherwise cost one
 * of the five updates Discord allows per 20s.
 */
function lineKey(line: string | null): string {
  return normalizeLyricText(line)
}

/**
 * The pair actually sent for a slice: the active line, and the next one only when
 * it arrives too soon to get an update of its own.
 *
 * A repeat is never paired with itself. When the next line normalises equal to the
 * current one - "Ла ла ла" against "Ла ла ла." - the second slot stays empty and
 * the line is shown once rather than stacked twice, but it is still reported as
 * `paired`, so the repeat costs no request when it becomes active either.
 *
 * `hasCover` gates the whole thing because the second line rides in `large_text`,
 * which lives inside the `assets` object next to the artwork. Whether Discord
 * renders `assets` that carry only a caption is unmeasured - case J in
 * `src-tauri/examples/discord_probe.rs` exists to settle it - so until then a
 * coverless track keeps the old single-line behaviour rather than risking the
 * whole activity. The cover-ready send picks pairing back up.
 */
function pairFor(
  slice: LyricSlice,
  hasCover: boolean,
): { line: string | null; nextLine: string | null; paired: string | null } {
  const { text, nextText } = slice
  if (!text || !nextText || !hasCover || slice.gapSec >= LYRIC_PAIR_MAX_GAP_SEC) {
    return { line: text, nextLine: null, paired: null }
  }
  const key = lineKey(nextText)
  if (key === lineKey(text)) return { line: text, nextLine: null, paired: key }
  return { line: text, nextLine: nextText, paired: key }
}

/**
 * Frames sent inside the trailing window. Old timestamps are dropped here rather
 * than on a timer, so an idle player leaves nothing running.
 */
function recentSends(now: number): number {
  sendTimes = sendTimes.filter((t) => now - t < RATE_WINDOW_MS)
  return sendTimes.length
}

/**
 * How long a send must wait, in ms; 0 means it can go now.
 *
 * A critical send may use the whole window, an ordinary one has to leave
 * `RATE_CRITICAL_RESERVE` slots free. When the budget is spent, the wait is until
 * the oldest frame in the window ages out - which is the earliest moment a slot
 * genuinely exists, rather than a fixed guess.
 */
function waitFor(now: number, critical: boolean): number {
  const used = recentSends(now)
  const spacing = sendTimes.length > 0 ? Math.max(0, SEND_MIN_SPACING_MS - (now - sendTimes[sendTimes.length - 1])) : 0
  const budget = critical ? RATE_WINDOW_MAX : RATE_WINDOW_MAX - RATE_CRITICAL_RESERVE
  if (used < budget) return spacing
  const freesAt = sendTimes[used - budget] + RATE_WINDOW_MS - now
  return Math.max(spacing, freesAt)
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
      // that the real cover URL exists. Not critical: the reserved slot belongs
      // to track and play/pause, and a deferred send still carries the cover.
      const snap = playerController.getSnapshot()
      if (snap.currentTrack?.sourceId === sourceId) requestSend(snap, 'cover')
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
  const cover = coverImage(track)
  const pair = playing
    ? pairFor(activeSlice(track.sourceId, snap.position), cover !== null)
    : { line: null, nextLine: null, paired: null }
  if (playing) {
    lastLine = lineKey(pair.line)
    pairedAhead = pair.paired
  }
  sendTimes.push(Date.now())
  presenceActive = true
  void invoke('discord_set_presence', {
    clientId: settings.clientId,
    details: track.title,
    state: playing
      ? pair.line ?? (track.artists.join(', ') || null)
      : pausedLabel(settings.lang),
    // only ever the next lyric line: a constant caption here reads as one on
    // every song, and an empty string is rejected outright
    largeText: pair.nextLine,
    startMs: start,
    endMs: end,
    largeImage: cover,
    smallImage: null,
    reason,
  }).catch(() => {})
}

/**
 * Single entry point for every presence push. Sends are metered against Discord's
 * sliding window (about five per 20s): while slots are free an update goes out
 * immediately - which is what lets two fast lyric lines land back to back - and
 * once the budget is spent the send waits exactly until the oldest frame ages out.
 * Critical events (track switch, play/pause) may use a reserved slot, so a chorus
 * can never make a track change invisible.
 */
function requestSend(
  snap: ReturnType<typeof playerController.getSnapshot>,
  reason: string,
  critical = false,
): void {
  if (!snap.currentTrack || !readSettings()) return
  const now = Date.now()
  const wait = waitFor(now, critical)
  if (wait <= 0) {
    if (sendTimer !== null) {
      window.clearTimeout(sendTimer)
      sendTimer = null
    }
    doSend(snap, reason)
    return
  }
  const at = now + Math.max(SEND_COALESCE_MS, wait)
  // latest wins: a scheduled timer always picks up the freshest snapshot, so a
  // second trigger needs no timer of its own. It does get to pull the existing one
  // earlier - that is how a critical event jumps a queue of lyric updates instead
  // of inheriting their wait.
  if (sendTimer !== null) {
    if (at >= sendAt) return
    window.clearTimeout(sendTimer)
  }
  sendAt = at
  sendTimer = window.setTimeout(() => {
    sendTimer = null
    doSend(playerController.getSnapshot(), `${reason}+deferred`)
  }, at - now)
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
  pairedAhead = null
  lastObservedElapsed = -1
  if (sendTimer !== null) {
    window.clearTimeout(sendTimer)
    sendTimer = null
  }
  sendAt = 0
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
    pairedAhead = null
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

  const slice = activeSlice(track.sourceId, snap.position)
  const jumped = lastObservedElapsed >= 0 && Math.abs(snap.position - lastObservedElapsed) >= SEEK_DRIFT_SEC
  lastObservedElapsed = snap.position
  const key = lineKey(slice.text)
  if (key !== lastLine) {
    // already on screen as the second row of the previous update: moving it up a
    // row is not worth a request, and spending one here would cost the line after.
    // A seek is the exception - the progress bar has to be resynced regardless.
    if (key === pairedAhead && !jumped) {
      lastLine = key
      pairedAhead = null
      return
    }
    lastLine = key
    // a skipped line is fine, the deferred send picks up the current one
    requestSend(snap, jumped ? 'seek' : 'lyric')
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
