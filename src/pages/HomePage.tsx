import {
  lazy,
  Suspense,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Eye, EyeOff, FolderPlus, Play, RefreshCw, UserRound, Pencil, Trash2 } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from '../api/client'
import type { Playlist, ScTrack, TopTrackItem, Track } from '../types/models'
import { useHomePageData } from '../features/home/useHomePageData'
import { useFolders } from '../hooks/useFolders'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useScanProgress } from '../hooks/useScanProgress'
import { useSettings } from '../state/settings'
import { useT } from '../i18n'
import { playerController } from '../player/controller'
import { useNav } from '../state/nav'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import { toast } from '../components/common/Toast'
import { scTracksToUnified, trackToUnified } from '../utils/unified'
import HomeMixFeature from '../components/home/HomeMixFeature'
import DeleteRuleDialog from '../components/common/DeleteRuleDialog'
import { useCustomMixes } from '../features/mixes/useCustomMixes'
import { presetFromMix } from '../features/mixes/presets'
import type { CustomMixRule } from '../features/mixes/types'
import { applyMixOrder, hideMixUntilNextGeneration, isMixGenerationHidden, mergeMixOrder, saveMixOrder, useMixPresentation } from '../features/mixes/presentation'
import HomeShelves from '../components/home/HomeShelves'
import RecommendationsShelf from '../components/home/RecommendationsShelf'
import EmptyState from '../components/common/EmptyState'
import ScanLine from '../components/common/ScanLine'
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import TrackContextMenu, { type TrackContextRequest } from '../components/common/TrackContextMenu'
import { requestTrackCache } from '../soundcloud/cacheJobs'
import { recommendationService } from '../features/recommendations/service'
import {
  anySectionHidden,
  hideSectionUntilTomorrow,
  isSectionHidden,
  unhideAllSections,
  useHiddenSections,
} from '../utils/hiddenSections'

const CustomMixEditor = lazy(() => import('../components/home/CustomMixEditor'))

function greetingForHour(h: number): string {
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 18) return 'Good afternoon'
  if (h >= 18 && h < 23) return 'Good evening'
  return 'Good night'
}

const NO_TRACKS: Track[] = []
const NO_TOP_TRACKS: TopTrackItem[] = []
const NO_PLAYLISTS: Playlist[] = []

export default function HomePage() {
  const [deletingRule, setDeletingRule] = useState<CustomMixRule | null>(null)
  const t = useT()
  const { settings } = useSettings()
  const { navigate } = useNav()
  const foldersApi = useFolders()
  const scan = useScanProgress()
  const version = useLibraryVersion()
  const [editingRule, setEditingRule] = useState<CustomMixRule | 'new' | null>(null)
  const mixPresentation = useMixPresentation()
  const unknownArtist = t('Unknown artist')
  const home = useHomePageData(version, unknownArtist)
  const { recommendations } = home
  const custom = useCustomMixes(version, editingRule !== null, home.foregroundReady)
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), [])
  const nickname = settings.profile.nickname
  const hourPicksList = home.hourPicksList
  const hourMixes = home.hourMixes
  // Reuse one track menu for cards across the home shelves.
  const [ctx, setCtx] = useState<TrackContextRequest | null>(null)
  useHiddenSections()

  const error = home.error ?? foldersApi.error
  const topTracks: TopTrackItem[] = home.data?.topTracks ?? NO_TOP_TRACKS
  const recentPlays = home.data?.played ?? NO_TRACKS
  const recentAdded = home.recentAdded
  const likedTracks = home.data?.likedTracks ?? NO_TRACKS

  const playSection = (tracks: Track[], index: number) => {
    playerController.playTracks(tracks.map((tr) => trackToUnified(tr)), index)
  }

  const playRecommendations = (index: number) => {
    playerController.playTracks(recommendations.tracks.map(track => recommendationService.toUnified(track)), index)
  }
  const playFavoriteGenre = (tracks: ScTrack[], index: number) => {
    playerController.playTracks(scTracksToUnified(tracks), index)
  }

  const cacheRecommendation = (track: ScTrack) => {
    void requestTrackCache(track)
      .then((outcome) => {
        if (outcome === 'cached') toast.show(t('Cached'))
        else if (outcome === 'empty') toast.show(t('This track cannot be cached'), 'info')
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
  const allMixes = applyMixOrder([...hourMixes, ...custom.mixes], mixPresentation.order)
  const visibleMixes = allMixes.filter((mix) => !hidden(`home.mix:${mix.key}`)
    && !isMixGenerationHidden(mix, mixPresentation.hiddenGenerations))
  const featuredPlaylists = home.data?.featuredPlaylists ?? NO_PLAYLISTS
  const hasPlaylistHistory = home.data?.hasPlaylistHistory ?? false

  const playPlaylist = async (playlist: Playlist) => {
    try {
      const tracks = (await api.getPlaylist(playlist.id)).map((row) => row.track)
      if (tracks.length === 0) return
      playerController.playTracks(tracks.map(trackToUnified), 0)
      await api.recordPlaylistStart(playlist.id)
      bumpLibraryVersion()
    } catch (cause) {
      toast.show(String(cause), 'error')
    }
  }

  const addRecommendationToPlaylist = (playlistId: number, track: ScTrack) => {
    const playlist = featuredPlaylists.find((item) => item.id === playlistId)
    void api.addScTrackToPlaylist(playlistId, track, settings.ytdlp.path)
      .then(() => {
        bumpLibraryVersion()
        toast.show(`${t('Added to')} ${playlist?.name ?? t('playlist')}`)
      })
      .catch((cause: unknown) => toast.show(cause instanceof Error ? cause.message : String(cause), 'error'))
  }

  return (
    <div className="page tempo-home">
      {deletingRule?.id != null ? <DeleteRuleDialog name={deletingRule.name} onDelete={() => custom.remove(deletingRule.id!)} onClose={() => setDeletingRule(null)} /> : null}
      {editingRule ? <Suspense fallback={null}><CustomMixEditor initial={editingRule === 'new' ? undefined : editingRule}
        genres={custom.genres}
        presets={allMixes.map(mix => ({ name: mix.title, rule: presetFromMix(mix), cover: mix.tracks.find(tr => tr.coverPath)?.coverPath }))}
        onSave={custom.save} onDelete={editingRule !== 'new' && editingRule.id != null ? () => custom.remove(editingRule.id!) : undefined} onClose={() => setEditingRule(null)} /></Suspense> : null}
      {error ? <div className="error-line">{error}</div> : null}
      {custom.error ? <div className="error-line">{custom.error}</div> : null}
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

      {!hidden('home.hour') ? (
        <HomeMixFeature
          mixes={visibleMixes}
          onReorder={keys => saveMixOrder(mergeMixOrder(allMixes.map(mix => mix.key), keys))}
          onCreateRule={() => setEditingRule('new')}
          onPlay={playSection}
          onOpen={(mix) => navigate({ name: 'hour-mix', mix })}
          onMixMenu={(event, mix) => {
            if (!mix.rule) return sectionMenu(event, { title: mix.title, id: 'home.mix:' + mix.key, tracks: mix.tracks })
            event.preventDefault(); event.stopPropagation()
            const items: ContextMenuItem[] = [
              { id: 'play', label: t('Play all'), icon: <Play size={13} />, disabled: !mix.tracks.length, onSelect: () => playSection(mix.tracks, 0) },
              { id: 'edit', label: t('Edit rule'), icon: <Pencil size={13} />, onSelect: () => setEditingRule(mix.rule!) },
            ]
            if (mix.rule.refreshIntervalMinutes > 0 && mix.generatedAt != null) items.push({
              id: 'hide', label: t('Hide until next generation'), icon: <EyeOff size={13} />,
              onSelect: () => hideMixUntilNextGeneration(mix),
            })
            items.push({ id: 'delete', label: t('Delete rule'), icon: <Trash2 size={13} />, danger: true, onSelect: () => setDeletingRule(mix.rule!) })
            openContextMenu({ x: event.clientX, y: event.clientY, title: mix.title, items })
          }}
          onSectionMenu={(event) =>
            sectionMenu(event, { title: t('For this hour'), id: 'home.hour', tracks: hourPicksList })
          }
        />
      ) : null}
      {home.data?.total === 0 && custom.mixes.length === 0 ? (
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
          <HomeShelves
            topTracks={topTracks}
            recentAdded={recentAdded}
            recentPlays={recentPlays}
            likedTracks={likedTracks}
            likesPlaylist={home.data?.likesPlaylist ?? null}
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
