import { useEffect, useState } from 'react'
import type { PlayerApi } from './types'
import { getNativePlayerController, isNativePlayback } from './nativeController'
import { startDisplayPositionLoop } from './displayPositionLoop'

/** Keep frame-rate updates local to the player bar, not the whole app. */
export function useDisplayPosition(player: Pick<PlayerApi, 'position' | 'isPlaying' | 'preparing' | 'currentTrack'>): number {
  const trackKey = player.currentTrack ? `${player.currentTrack.source}:${player.currentTrack.sourceId}` : null
  const [, setFramePosition] = useState(0)
  const native = isNativePlayback()

  useEffect(() => {
    if (!native || !trackKey || !player.isPlaying || player.preparing) return
    const controller = getNativePlayerController()
    return startDisplayPositionLoop(
      () => controller.getDisplayPosition(),
      setFramePosition,
    )
  }, [native, trackKey, player.isPlaying, player.preparing])

  if (!native || !trackKey || !player.isPlaying || player.preparing) return player.position
  // The frame loop schedules local renders. Read the current clock here so a
  // same-track seek/repeat cannot render the sample from the previous frame.
  return getNativePlayerController().getDisplayPosition()
}
