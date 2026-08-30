import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { usePlayer } from '../../player'
import { useSettings } from '../../state/settings'
import { lyricLineAt, lyricsService } from '../../features/lyrics/lyricsService'

/**
 * Background lyrics prefetch + Discord Rich Presence bridge.
 * Presence details = track title; state = synced lyrics line while it plays,
 * otherwise the artist. Updates are rate-limited (Discord allows ~1 per 15s,
 * the Rust side coalesces as well).
 */
const LOGO_ASSET = 'tempo_logo'

/** Discord media-proxy reference for a remote image; local files can't be proxied. */
function coverAsset(coverPath: string | null): string | null {
  if (coverPath && /^https?:\/\//.test(coverPath)) {
    return `mp:external/${btoa(unescape(encodeURIComponent(coverPath))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
  }
  return null
}

export default function PresenceBridge() {
  const p = usePlayer()
  const { settings } = useSettings()
  const track = p.currentTrack
  const enabled = settings.discord.enabled && settings.discord.clientId.trim().length > 0
  const clientId = settings.discord.clientId.trim()

  const lastTrackKey = useRef('')
  const lastLine = useRef<string | null>(null)
  const lastSent = useRef(0)
  const startMs = useRef<number | null>(null)
  const [, bump] = useState(0)

  // prefetch lyrics for the current track
  useEffect(() => {
    if (!track) return
    lyricsService.ensure(track, settings.lyrics.cacheOnline)
    lastTrackKey.current = track.sourceId
    lastLine.current = null
    lastSent.current = 0
    startMs.current = Date.now() - Math.round(p.position * 1000)
    // track identity is the trigger; position is intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.sourceId])

  // resubscribe to lyrics arrival
  useEffect(() => {
    return lyricsService.subscribe(() => bump((v: number) => v + 1))
  }, [])

  // base presence on track change
  useEffect(() => {
    if (!enabled) return
    if (!track) {
      void api.discordClearPresence().catch(() => {})
      return
    }
    if (lastTrackKey.current !== track.sourceId) return
    const cover = coverAsset(track.coverPath)
    void api
      .discordSetPresence({
        clientId,
        details: track.title,
        state: track.artists.join(', ') || null,
        startMs: startMs.current,
        largeImage: cover ?? LOGO_ASSET,
        smallImage: cover ? LOGO_ASSET : null,
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, track?.sourceId, lyricsService.getVersion()])

  // synced lyrics line updates
  useEffect(() => {
    if (!enabled || !track) return
    const cur = lyricsService.getCurrent()
    if (!cur || cur.trackId !== track.sourceId || !cur.result) return
    const line = lyricLineAt(cur.result, p.position)
    if (line === null || line === lastLine.current) return
    const now = Date.now()
    if (now - lastSent.current < 5000) return
    lastSent.current = now
    lastLine.current = line
    const cover = coverAsset(track.coverPath)
    void api
      .discordSetPresence({
        clientId,
        details: track.title,
        state: line,
        startMs: startMs.current,
        largeImage: cover ?? LOGO_ASSET,
        smallImage: cover ? LOGO_ASSET : null,
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.position, enabled, track?.sourceId])

  // disabled -> clear once
  const wasEnabled = useRef(enabled)
  useEffect(() => {
    if (wasEnabled.current && !enabled) {
      void api.discordClearPresence().catch(() => {})
    }
    wasEnabled.current = enabled
  }, [enabled])

  return null
}
