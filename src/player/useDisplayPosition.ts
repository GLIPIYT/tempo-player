import { useEffect, useState } from 'react'
import type { PlayerApi } from './types'
import { getNativePlayerController, isNativePlayback } from './nativeController'
import { startDisplayPositionLoop } from './displayPositionLoop'

/** Keep frame-rate updates local to the player bar, not the whole app. */
export function useDisplayPosition(player: Pick<PlayerApi, 'position' | 'isPlaying' | 'preparing' | 'currentTrack'>): number {
  const trackKey = player.currentTrack ? `${player.currentTrack.source}:${player.currentTrack.sourceId}` : null
  const [display, setDisplay] = useState<{ trackKey: string | null; position: number } | null>(null)
  const native = isNativePlayback()

  useEffect(() => {
    if (!native || !trackKey || !player.isPlaying || player.preparing) return
    const controller = getNativePlayerController()
    return startDisplayPositionLoop(
      () => controller.getDisplayPosition(),
      position => setDisplay(previous => previous?.trackKey === trackKey && previous.position === position
        ? previous : { trackKey, position }),
    )
  }, [native, trackKey, player.isPlaying, player.preparing])

  if (!native || !player.isPlaying || player.preparing || display?.trackKey !== trackKey) return player.position
  return display.position
}
