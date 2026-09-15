import { useEffect } from 'react'
import { usePlayer } from '../../player'
import { useSettings } from '../../state/settings'
import { analyzeTracks } from '../../audio/loudnessRunner'

/** How far ahead of the current track to measure. */
const LOOKAHEAD = 3

/**
 * Keeps the queue levelled without ever grinding the library.
 *
 * Whenever the track changes, the next few queue entries that still have no
 * measurement are measured in the background. A track lasts minutes and a
 * measurement takes a fraction of that, so the next track is normally levelled
 * before it starts - and nothing is spent on tracks the user never reaches.
 *
 * Renders `null`; mounted once inside the app shell.
 */
export default function LoudnessBridge(): null {
  const { settings } = useSettings()
  const { currentTrack, queue, queueIndex } = usePlayer()
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
