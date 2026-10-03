import { useEffect, useSyncExternalStore } from 'react'
import { recommendationService } from '../features/recommendations/service'
import type { TopTrackItem } from '../types/models'

/** Home and radio share the app store; library updates never reset the rail. */
export function useSoundCloudRecommendations(topTracks: TopTrackItem[] | null) {
  const snapshot = useSyncExternalStore(recommendationService.subscribe, recommendationService.getSnapshot)
  useEffect(() => { if (topTracks !== null) void recommendationService.refreshContext() }, [topTracks])
  return {
    ...snapshot,
    activate: recommendationService.activate,
    retry: recommendationService.retry,
    loadMore: recommendationService.loadMore,
    recordImpression: recommendationService.recordImpression,
    reportVisibleIds: recommendationService.reportVisibleIds,
    trimPassed: recommendationService.trimPassed,
  }
}
