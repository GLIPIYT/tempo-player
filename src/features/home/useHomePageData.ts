import { useMemo } from 'react'
import { api } from '../../api/client'
import type { HomePageData, TopTrackItem, Track } from '../../types/models'
import { useHomeData } from './homeData'
import { useSoundCloudRecommendations } from '../../hooks/useSoundCloudRecommendations'
import { buildHourMixes } from '../../utils/hourMixes'
import { useT } from '../../i18n'

const NO_TRACKS: Track[] = []
const NO_TOP_TRACKS: TopTrackItem[] = []

/** Load and derive the library-backed data used by the Home page. */
export function useHomePageData(version: number, unknownArtist: string) {
  const t = useT()
  const now = new Date()
  const hourKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}:${now.getHours()}`
  const snapshot = useHomeData<HomePageData>('home.library-snapshot', api.getHomePageData, version)
  const hourPicks = useHomeData(`home.hour-picks:${hourKey}`, () => api.getHourPicks(30), version)
  const topTracks = snapshot.data?.topTracks ?? NO_TOP_TRACKS
  const likedTracks = snapshot.data?.likedTracks ?? NO_TRACKS
  const hourPicksList = hourPicks.data ?? NO_TRACKS
  const recentAdded = useMemo(() => snapshot.data?.mixLibrary.slice(0, 6) ?? NO_TRACKS, [snapshot.data])

  const hourMixes = useMemo(() => buildHourMixes(
    hourPicksList,
    unknownArtist,
    t('Music for this hour'),
    {
      tracks: [
        ...(snapshot.data?.mixLibrary ?? NO_TRACKS),
        ...topTracks.map((item) => item.track),
        ...(snapshot.data?.played ?? NO_TRACKS),
        ...(snapshot.data?.dormantTracks ?? NO_TRACKS),
        ...likedTracks,
        ...hourPicksList,
      ],
      likedTrackIds: new Set(likedTracks.map((track) => track.id)),
      titles: {
        onRepeat: t('On repeat'),
        newToYou: t('New to you'),
        forgottenFavorites: t('Forgotten favorites'),
        noSkips: t('No skips'),
      },
    },
  ), [hourPicksList, unknownArtist, t, snapshot.data, topTracks, likedTracks])

  const recommendations = useSoundCloudRecommendations(topTracks)

  return {
    data: snapshot.data,
    error: snapshot.error,
    recentAdded,
    hourPicksList,
    hourMixes,
    recommendations,
    foregroundReady: !snapshot.loading && !hourPicks.loading,
  }
}
