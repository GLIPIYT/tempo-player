import { useSyncExternalStore } from 'react'
import { libraryVersion } from '../utils/libraryVersion'

export function useLibraryVersion(): number {
  return useSyncExternalStore(libraryVersion.subscribe, libraryVersion.get)
}
