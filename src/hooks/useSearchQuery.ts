import { useSyncExternalStore } from 'react'
import { searchStore } from '../utils/searchStore'

export function useSearchQuery(): string {
  return useSyncExternalStore(searchStore.subscribe, searchStore.get, searchStore.get)
}
