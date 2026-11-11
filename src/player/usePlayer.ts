import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { PlayerSnapshot } from './controller'
import { playerController } from './controller'
import type { PlayerApi } from './types'

type PlayerActions = Pick<
  PlayerApi,
  | 'playTracks'
  | 'updateTrackMetadata'
  | 'toggle'
  | 'next'
  | 'previous'
  | 'seek'
  | 'setVolume'
  | 'setPlaybackRate'
  | 'setPreservePitch'
  | 'setEqualizer'
  | 'setRepeat'
  | 'toggleShuffle'
  | 'addToQueue'
  | 'removeFromQueue'
  | 'moveInQueue'
  | 'clearQueue'
>

const actions: PlayerActions = {
  playTracks: (tracks, startIndex) => playerController.playTracks(tracks, startIndex),
  updateTrackMetadata: track => playerController.updateTrackMetadata(track),
  toggle: () => playerController.toggle(),
  next: () => playerController.next(),
  previous: () => playerController.previous(),
  seek: sec => playerController.seek(sec),
  setVolume: v => playerController.setVolume(v),
  setPlaybackRate: (rate, persist) => playerController.setPlaybackRate(rate, persist),
  setPreservePitch: preserve => playerController.setPreservePitch(preserve),
  setEqualizer: settings => playerController.setEqualizer(settings),
  setRepeat: m => playerController.setRepeat(m),
  toggleShuffle: () => playerController.toggleShuffle(),
  addToQueue: t => playerController.addToQueue(t),
  removeFromQueue: index => playerController.removeFromQueue(index),
  moveInQueue: (from, to) => playerController.moveInQueue(from, to),
  clearQueue: () => playerController.clearQueue(),
}

export function composePlayerApi(state: PlayerSnapshot): PlayerApi {
  return {
    currentTrack: state.currentTrack,
    queue: state.queue,
    queueIndex: state.queueIndex,
    isPlaying: state.isPlaying,
    position: state.position,
    duration: state.duration,
    volume: state.volume,
    playbackRate: state.playbackRate,
    preservePitch: state.preservePitch,
    repeat: state.repeat,
    shuffle: state.shuffle,
    bufferPct: state.bufferPct,
    preparing: state.preparing,
    ...actions,
  }
}

export const playerContext = createContext<PlayerApi | null>(null)

const subscribeNothing = () => () => {}

/** Commands stay stable and need no subscription to playback position. */
export function usePlayerActions(): PlayerActions {
  return useContext(playerContext) ?? actions
}

export function usePlayerField<K extends keyof PlayerSnapshot & keyof PlayerApi>(key: K) {
  const contextual = useContext(playerContext)
  const getField = useCallback(
    () => contextual ? contextual[key] : playerController.getSnapshot()[key],
    [contextual, key],
  )
  return useSyncExternalStore(contextual ? subscribeNothing : playerController.subscribe, getField)
}

export function usePlayer(): PlayerApi {
  const contextual = useContext(playerContext)
  const snapshot = useSyncExternalStore(
    contextual ? subscribeNothing : playerController.subscribe,
    playerController.getSnapshot,
  )
  return useMemo(() => contextual ?? composePlayerApi(snapshot), [contextual, snapshot])
}
