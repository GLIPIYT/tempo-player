import { useSyncExternalStore } from 'react'
import { likesStore } from '../utils/likesStore'

interface LikesApi {
  isLiked: (trackId: number) => boolean
  toggle: (trackId: number) => void
}

export function useLikes(): LikesApi {
  useSyncExternalStore(likesStore.subscribe, likesStore.get)
  likesStore.ensureLoaded()
  return { isLiked: likesStore.isLiked, toggle: likesStore.toggle }
}
