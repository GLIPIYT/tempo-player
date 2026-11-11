import { useEffect, useState } from 'react'
import type { PlayerApi } from './types'
import { getNativePlayerController, isNativePlayback } from './nativeController'
import { startDisplayPositionLoop } from './displayPositionLoop'

/** Keep frame-rate updates local to the player bar, not the whole app. */
export function useDisplayPosition(
  player: Pick<PlayerApi, 'position' | 'isPlaying' | 'preparing' | 'currentTrack'>,
  animate = true,
): number {
  const trackKey = player.currentTrack ? `${player.currentTrack.source}:${player.currentTrack.sourceId}` : null
  const [, setFramePosition] = useState(0)
  const native = isNativePlayback()
  const shouldAnimate = animate && native && Boolean(trackKey) && player.isPlaying && !player.preparing

  useEffect(() => {
    if (!shouldAnimate) return
    const controller = getNativePlayerController()
    return startDisplayPositionLoop(
      () => controller.getDisplayPosition(),
      setFramePosition,
    )
  }, [shouldAnimate, trackKey])

  if (!shouldAnimate) return player.position
  // The frame loop schedules local renders. Read the current clock here so a
  // same-track seek/repeat cannot render the sample from the previous frame.
  return getNativePlayerController().getDisplayPosition()
}
