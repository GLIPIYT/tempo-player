import { createContext, useContext, useSyncExternalStore } from 'react'
import type { PlayerSnapshot } from './controller'
import { playerController } from './controller'
import type { PlayerApi } from './types'

type PlayerActions = Pick<
  PlayerApi,
  | 'playTracks'
  | 'toggle'
  | 'next'
  | 'previous'
  | 'seek'
  | 'setVolume'
  | 'setRepeat'
  | 'toggleShuffle'
  | 'addToQueue'
  | 'removeFromQueue'
  | 'moveInQueue'
  | 'clearQueue'
>

const actions: PlayerActions = {
  playTracks: (tracks, startIndex) => playerController.playTracks(tracks, startIndex),
  toggle: () => playerController.toggle(),
  next: () => playerController.next(),
  previous: () => playerController.previous(),
  seek: sec => playerController.seek(sec),
  setVolume: v => playerController.setVolume(v),
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
    repeat: state.repeat,
    shuffle: state.shuffle,
    bufferPct: state.bufferPct,
    ...actions,
  }
}

export const playerContext = createContext<PlayerApi | null>(null)

export function usePlayerValue(): PlayerApi {
  const snapshot = useSyncExternalStore(playerController.subscribe, playerController.getSnapshot)
  return composePlayerApi(snapshot)
}

export function usePlayer(): PlayerApi {
  const contextual = useContext(playerContext)
  const direct = usePlayerValue()
  return contextual ?? direct
}
