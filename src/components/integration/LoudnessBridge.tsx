import { useEffect } from 'react'
import { usePlayerField } from '../../player'
import { isNativePlayback } from '../../player/controller'
import { useSettings } from '../../state/settings'
import { analyzeTracks } from '../../audio/loudnessRunner'

/** How far ahead of the current track to measure. */
const LOOKAHEAD = 3

function BrowserLoudnessBridge(): null {
  const { settings } = useSettings()
  const currentTrack = usePlayerField('currentTrack')
  const queue = usePlayerField('queue')
  const queueIndex = usePlayerField('queueIndex')
  const enabled = settings.audio.normalize

  useEffect(() => {
    if (!enabled) return
    const upcoming = queue
      .slice(queueIndex + 1, queueIndex + 1 + LOOKAHEAD)
      .filter(
        (track) =>
          track.source === 'local' &&
          track.dbId !== null &&
          track.localPath !== null &&
          // a value means ReplayGain tags or an earlier measurement
          track.gainDb === null,
      )
      .map((track) => ({ id: track.dbId as number, path: track.localPath as string }))
    if (upcoming.length === 0) return
    void analyzeTracks(upcoming).catch(() => {})
    // identity of the current track is the trigger; the queue is read fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, currentTrack?.sourceId])

  return null
}

/** Desktop playback measures decoded audio in the native player. */
export default function LoudnessBridge() {
  return isNativePlayback() ? null : <BrowserLoudnessBridge />
}
