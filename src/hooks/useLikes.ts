import { useSyncExternalStore } from 'react'
import { likesStore } from '../utils/likesStore'
import type { Track, UnifiedTrack } from '../types/models'

interface LikesApi {
  isLiked: (trackId: number) => boolean
  toggle: (trackId: number, sourceTrack?: Track | UnifiedTrack) => void
}

export function useLikes(): LikesApi {
  useSyncExternalStore(likesStore.subscribe, likesStore.get)
  likesStore.ensureLoaded()
  return { isLiked: likesStore.isLiked, toggle: likesStore.toggle }
}
