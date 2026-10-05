import {
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Eye, EyeOff, FolderPlus, Play, RefreshCw, UserRound } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from '../api/client'
import type { Playlist, PlaylistPlayStat, ScTrack, TopTrackItem, Track } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useFolders } from '../hooks/useFolders'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useScanProgress } from '../hooks/useScanProgress'
import { useSettings } from '../state/settings'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { useNav } from '../state/nav'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { toast } from '../components/common/Toast'
import { scTracksToUnified, trackToUnified } from '../utils/unified'
import HomeMixFeature from '../components/home/HomeMixFeature'
import HomeShelves from '../components/home/HomeShelves'
import RecommendationsShelf from '../components/home/RecommendationsShelf'
import EmptyState from '../components/common/EmptyState'
import ScanLine from '../components/common/ScanLine'
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import TrackContextMenu, { type TrackContextRequest } from '../components/common/TrackContextMenu'
import { buildHourMixes } from '../utils/hourMixes'
import { requestTrackCache } from '../soundcloud/cacheJobs'
import { useSoundCloudRecommendations } from '../hooks/useSoundCloudRecommendations'
import { recommendationService } from '../features/recommendations/service'
import {
  anySectionHidden,
  hideSectionUntilTomorrow,
  isSectionHidden,
  unhideAllSections,
  useHiddenSections,
} from '../utils/hiddenSections'

function greetingForHour(h: number): string {
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 18) return 'Good afternoon'
  if (h >= 18 && h < 23) return 'Good evening'
  return 'Good night'
}

function dedupeRecent(entries: { track: Track }[], limit: number): Track[] {
  const seen = new Set<number>()
  const out: Track[] = []
  for (const e of entries) {
    if (seen.has(e.track.id)) continue
    seen.add(e.track.id)
    out.push(e.track)
    if (out.length >= limit) break
  }
  return out
}

const NO_TRACKS: Track[] = []

export default function HomePage() {
  const t = useT()
  const { settings } = useSettings()
  const player = usePlayer()
  const { navigate } = useNav()
  const foldersApi = useFolders()
  const scan = useScanProgress()
  const version = useLibraryVersion()
  const total = useAsync(() => api.countTracks(), [version])
  const recent = useAsync(() => api.listTracks('', 10, 0), [version])
  const mixLibrary = useAsync(() => api.listTracks('', 300, 0, 'added'), [version])
  const hourPicks = useAsync(() => api.getHourPicks(30), [version])
  const top = useAsync(() => api.getTopTracks(40), [version])
  const recommendations = useSoundCloudRecommendations(top.data)
  const played = useAsync(async () => {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400
    return dedupeRecent((await api.getHistory(100, 0)).filter((entry) => entry.playedAt >= since), 16)
  }, [version])
  const dormant = useAsync(() => api.getDormantTracks(Math.floor(Date.now() / 1000) - 30 * 86400, 24), [version])
  const playlistData = useAsync(async () => {
    const [playlists, stats] = await Promise.all([api.listPlaylists(), api.listPlaylistPlayStats()])
    const likes = playlists.find((playlist) => playlist.isLikes)
    const likedTracks = likes ? (await api.getPlaylist(likes.id)).map((row) => row.track).reverse().slice(0, 24) : []
    return { playlists, stats, likes, likedTracks }
  }, [version])
  const unknownArtist = t('Unknown artist')
  // Keep the fallback identity stable while the first result is loading.
  const hourPicksList = useMemo(() => hourPicks.data ?? [], [hourPicks.data])
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), [])
  const nickname = settings.profile.nickname
  const likedTracks = playlistData.data?.likedTracks ?? NO_TRACKS
  const hourMixes = useMemo(() => buildHourMixes(
    hourPicksList,
    unknownArtist,
    t('Music for this hour'),
    {
      tracks: [
        ...(mixLibrary.data ?? NO_TRACKS),
        ...(top.data ?? []).map((item) => item.track),
        ...(played.data ?? NO_TRACKS),
        ...(dormant.data ?? NO_TRACKS),
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
  ), [hourPicksList, unknownArtist, t, mixLibrary.data, top.data, played.data, dormant.data, likedTracks])
  // Reuse one track menu for cards across the home shelves.
  const [ctx, setCtx] = useState<TrackContextRequest | null>(null)
  useHiddenSections()

  if (recent.loading && recent.data === null) {
    return (
      <div className="page">
        <div className="muted">{t('Loading…')}</div>
      </div>
    )
  }

  const error = recent.error ?? foldersApi.error
  if (error && recent.data === null) {
    return (
      <div className="page">
        <div className="error-line">{error}</div>
      </div>
    )
  }

  const totalTracks = total.data ?? 0
  const topTracks: TopTrackItem[] = top.data ?? []
  const recentPlays = played.data ?? []
  const recentAdded = recent.data ?? []

  const playSection = (tracks: Track[], index: number) => {
    player.playTracks(tracks.map((tr) => trackToUnified(tr)), index)
  }

  const playRecommendations = (index: number) => {
    player.playTracks(recommendations.tracks.map(track => recommendationService.toUnified(track)), index)
  }
  const playFavoriteGenre = (tracks: ScTrack[], index: number) => {
    player.playTracks(scTracksToUnified(tracks), index)
  }

  const cacheRecommendation = (track: ScTrack) => {
    void requestTrackCache(track)
      .then((outcome) => {
        if (outcome === 'started') toast.show(t('Caching started'))
        else toast.show(t('This track cannot be cached'), 'info')
      })
      .catch((cause: unknown) => toast.show(cause instanceof Error ? cause.message : String(cause), 'error'))
  }

  /**
   * Right-click menu for a section header or a generated mix: play the lot, or
   * hide it for the rest of the day.
   */
  const sectionMenu = (e: ReactMouseEvent, opts: { title: string; id: string; tracks?: Track[] }) => {
    e.preventDefault()
    e.stopPropagation()
    const items: ContextMenuItem[] = []
    const sectionTracks = opts.tracks
    if (sectionTracks) items.push({
        id: 'play',
        label: t('Play all'),
        icon: <Play size={13} />,
        disabled: sectionTracks.length === 0,
        onSelect: () => playSection(sectionTracks, 0),
      })
    items.push({
        id: 'hide',
        label: t('Hide until tomorrow'),
        icon: <EyeOff size={13} />,
        onSelect: () => hideSectionUntilTomorrow(opts.id),
      })
    if (anySectionHidden()) {
      items.push({
        id: 'unhide',
        label: t('Show hidden sections'),
        icon: <Eye size={13} />,
        onSelect: () => unhideAllSections(),
      })
    }
    openContextMenu({ x: e.clientX, y: e.clientY, title: opts.title, items })
  }

  const trackContext = (e: ReactMouseEvent, track: Track, tracks: Track[], index: number) => {
    e.preventDefault()
    setCtx({ x: e.clientX, y: e.clientY, track, tracks, index })
  }

  const hidden = (id: string) => isSectionHidden(id)
  const visibleMixes = hourMixes.filter((mix) => !hidden(`home.mix:${mix.key}`))
  const playlistStats = new Map((playlistData.data?.stats ?? []).map((stat: PlaylistPlayStat) => [stat.playlistId, stat]))
  const candidatePlaylists = (playlistData.data?.playlists ?? []).filter((playlist) => !playlist.isLikes && (playlist.trackCount ?? 0) > 0)
  const hasPlaylistHistory = candidatePlaylists.some((playlist) => playlistStats.has(playlist.id))
  const featuredPlaylists = candidatePlaylists
    .sort((a, b) => hasPlaylistHistory
      ? (playlistStats.get(b.id)?.playCount ?? 0) - (playlistStats.get(a.id)?.playCount ?? 0)
        || (playlistStats.get(b.id)?.lastPlayedAt ?? 0) - (playlistStats.get(a.id)?.lastPlayedAt ?? 0)
        || b.updatedAt - a.updatedAt
      : Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
    .slice(0, 6)

  const playPlaylist = async (playlist: Playlist) => {
    try {
      const tracks = (await api.getPlaylist(playlist.id)).map((row) => row.track)
      if (tracks.length === 0) return
      player.playTracks(tracks.map(trackToUnified), 0)
      await api.recordPlaylistStart(playlist.id)
      bumpLibraryVersion()
    } catch (cause) {
      toast.show(String(cause), 'error')
    }
  }

  const addRecommendationToPlaylist = (playlistId: number, track: ScTrack) => {
    const playlist = featuredPlaylists.find((item) => item.id === playlistId)
    void api.addScTrackToPlaylist(playlistId, track)
      .then(() => {
        bumpLibraryVersion()
        toast.show(`${t('Added to')} ${playlist?.name ?? t('playlist')}`)
      })
      .catch((cause: unknown) => toast.show(cause instanceof Error ? cause.message : String(cause), 'error'))
  }

  return (
    <div className="page tempo-home">
      {error ? <div className="error-line">{error}</div> : null}
      <div className="hero">
        <div className="hero-main">
          <div className="home-greeting">
            <span className="home-avatar" aria-hidden="true">
              {settings.profile.avatarPath
                ? <img src={convertFileSrc(settings.profile.avatarPath)} alt="" draggable={false} />
                : <UserRound size={24} strokeWidth={1.7} />}
            </span>
            <h1 className="hero-title">
              {t(greeting)}
              {nickname ? `, ${nickname}` : ''}
            </h1>
          </div>
          <div className="hero-sub">{t('Your music is here. Start with what fits this hour.')}</div>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-ghost"
            onClick={() => void foldersApi.addFolder()}
            disabled={foldersApi.busy}
          >
            <FolderPlus size={15} />
            {t('Add folder')}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void api.rescanLibrary()}
            disabled={foldersApi.busy || scan.active}
          >
            <RefreshCw size={15} className={scan.active ? 'spin' : undefined} />
            {t('Rescan')}
          </button>
        </div>
      </div>

      <ScanLine />

      {totalTracks === 0 ? (
        <EmptyState
          icon={<FolderPlus size={34} />}
          title={t('Your library is empty')}
          hint={t('Add a folder containing music files. Tempo scans it locally and builds your collection.')}
          action={
            <button
              className="btn btn-primary"
              onClick={() => void foldersApi.addFolder()}
              disabled={foldersApi.busy}
            >
              <FolderPlus size={15} />
              {t('Add folder')}
            </button>
          }
        />
      ) : (
        <>
          {visibleMixes.length > 0 && !hidden('home.hour') ? (
            <HomeMixFeature
              mixes={visibleMixes}
              onPlay={playSection}
              onOpen={(mix) => navigate({ name: 'hour-mix', mix })}
              onMixMenu={(event, mix) =>
                sectionMenu(event, { title: mix.title, id: 'home.mix:' + mix.key, tracks: mix.tracks })
              }
              onSectionMenu={(event) =>
                sectionMenu(event, { title: t('For this hour'), id: 'home.hour', tracks: hourPicksList })
              }
            />
          ) : null}

          <HomeShelves
            topTracks={topTracks}
            recentAdded={recentAdded}
            recentPlays={recentPlays}
            dormantTracks={dormant.data ?? []}
            likedTracks={playlistData.data?.likedTracks ?? []}
            likesPlaylist={playlistData.data?.likes ?? null}
            featuredPlaylists={featuredPlaylists}
            recommendations={!hidden('home.recommendations') ? (
              <RecommendationsShelf
                tracks={recommendations.tracks}
                favoriteGenre={recommendations.favoriteGenre}
                loading={recommendations.loading}
                error={recommendations.error}
                persistenceError={recommendations.persistenceError}
                hasLoaded={recommendations.hasLoaded}
                hasMore={recommendations.hasMore}
                cachedTrackIds={recommendations.cachedTrackIds}
                exhausted={recommendations.exhausted}
                retryAt={recommendations.retryAt}
                onPlay={playRecommendations}
                onPlayFavoriteGenre={playFavoriteGenre}
                onCache={cacheRecommendation}
                onDropToPlaylist={addRecommendationToPlaylist}
                onRetry={recommendations.retry}
                onLoadMore={recommendations.loadMore}
                onNearViewport={recommendations.activate}
                onImpression={recommendations.recordImpression}
                onVisibleIds={recommendations.reportVisibleIds}
                onTrimPassed={recommendations.trimPassed}
                onSectionMenu={(event) => sectionMenu(event, { title: t('Recommended for you'), id: 'home.recommendations' })}
              />
            ) : null}
            hasPlaylistHistory={hasPlaylistHistory}
            unknownArtist={unknownArtist}
            onPlay={playSection}
            onPlayPlaylist={(playlist) => void playPlaylist(playlist)}
            onOpenPlaylist={(playlist) => navigate({ name: 'playlist', id: playlist.id })}
            onTrackMenu={trackContext}
            onSectionMenu={sectionMenu}
          />

          {/* without this, hiding every section would leave nothing to
              right-click and no way back */}
          {anySectionHidden() ? (
            <div className="home-restore">
              <button className="btn btn-ghost" onClick={() => unhideAllSections()}>
                <Eye size={15} />
                {t('Show hidden sections')}
              </button>
            </div>
          ) : null}
        </>
      )}
      <TrackContextMenu req={ctx} onClose={() => setCtx(null)} />
    </div>
  )
}
