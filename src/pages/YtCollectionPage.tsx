import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { getSettings } from '../state/settings'
import { useNav } from '../state/nav'
import { useT } from '../i18n'
import { usePlayerActions } from '../player'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import CollectionFavoriteButton from '../components/common/CollectionFavoriteButton'
import CollectionPlayButton from '../components/common/CollectionPlayButton'
import CollectionShuffleButton from '../components/common/CollectionShuffleButton'
import OnlineCollectionTracks from '../components/common/OnlineCollectionTracks'
import BrandIcon from '../components/common/BrandIcon'
import ScArtwork from '../components/common/ScArtwork'
import LoadingLine from '../components/common/LoadingLine'
import { ytHitToUnified } from '../providers/youtubeProvider'
import {
  cancelSave,
  getSaveJob,
  saveCollection,
  subscribeSave,
  type SaveJob,
} from '../youtube/collectionSaver'
import { fmtTime } from '../utils/format'
import { openContextMenu, type ContextMenuItem, type ContextMenuRequest } from '../components/common/ContextMenu'
import { Copy, Disc3, Download, ExternalLink, ListMusic, MicVocal, Play } from 'lucide-react'
import { toast } from '../components/common/Toast'
import type { YtCollectionDetail } from '../types/models'
import { openExternalUrl } from '../utils/externalLinks'

type Kind = 'album' | 'artist' | 'playlist'

/**
 * An album, artist or playlist from YouTube Music, browsed live.
 *
 * One page for all three: they are the same thing to look at, they come from
 * the same call, and the only difference is where the name lives - an album and
 * a playlist keep it in the title, an artist in the uploader.
 *
 * Nothing here is written to the library. Keeping one is a separate step.
 */
export default function YtCollectionPage({ kind, id }: { kind: Kind; id: string }) {
  const t = useT()
  const { navigate } = useNav()
  const player = usePlayerActions()
  const [detail, setDetail] = useState<YtCollectionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<SaveJob | null>(getSaveJob)
  /**
   * The library row this collection was filed under, and whether the library
   * has an opinion about it.
   *
   * Favourites are kept against those rows rather than against a YouTube id,
   * so this is null until the collection has been saved - and a playlist never
   * gets one, because a playlist does not become a row: its tracks are filed
   * under their own artists.
   */
  const [favRow, setFavRow] = useState<number | null>(null)
  const [isFav, setIsFav] = useState(false)

  // The save lives outside the page, so it keeps going when this one is left
  // behind - and the page has to follow it rather than own it.
  useEffect(() => subscribeSave(() => setSaving(getSaveJob())), [])

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    setFavRow(null)
    setIsFav(false)
    api
      .ytdlpOpenCollection(getSettings().ytdlp.path, `https://music.youtube.com/browse/${id}`)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [id, kind])

  const name = detail
    ? kind === 'artist'
      ? (detail.uploader ?? detail.title ?? '')
      : kind === 'album'
        ? (detail.title ?? '').replace(/^Album - /i, '')
        : (detail.title ?? '')
    : ''
  const tracks = useMemo(() => detail?.tracks.map(hit => {
    const track = ytHitToUnified(hit)
    return {
      ...track,
      coverPath: track.coverPath ?? `https://i.ytimg.com/vi/${encodeURIComponent(track.sourceId)}/mqdefault.jpg`,
    }
  }) ?? [], [detail])

  // Looked up again once a save finishes, because saving is what creates the
  // row in the first place.
  const saveFinished = saving !== null && saving.state !== 'running'
  useEffect(() => {
    if (!detail || kind === 'playlist') return
    let cancelled = false
    const artist = kind === 'artist' ? '' : (detail.uploader ?? '')
    api
      .findYtCollectionRow(kind, kind === 'artist' ? (detail.uploader ?? '') : name, artist)
      .then(async (row) => {
        if (cancelled) return
        setFavRow(row)
        if (row === null) return
        const fav = kind === 'artist' ? await api.isFavoriteArtist(row) : await api.isFavoriteAlbum(row)
        if (!cancelled) setIsFav(fav)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [detail, kind, name, saveFinished])

  const kindLabel =
    kind === 'album' ? t('Album') : kind === 'artist' ? t('Artist') : t('Playlist')
  const pageSave = saving?.id === id ? saving : null
  const anotherSaveRunning = saving?.state === 'running' && saving.id !== id

  if (error) {
    return (
      <div className="page">
        <div className="muted">{error}</div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="page">
        <LoadingLine
          lines={[t('Asking YouTube Music…'), t('Opening it…'), t('Reading the names…')]}
        />
      </div>
    )
  }

  // The same things a track offers anywhere else, minus the ones that need a
  // library row: a search result has none until it has been saved, and
  // favourites are kept against those rows.
  const trackMenu = (point: Pick<ContextMenuRequest, 'x' | 'y' | 'trigger'>, index: number): void => {
    const hit = detail.tracks[index]
    if (!hit) return
    const items: ContextMenuItem[] = [
      {
        id: 'play',
        label: t('Play'),
        icon: <Play size={13} />,
        onSelect: () => player.playTracks(tracks, index),
      },
      {
        id: 'cache',
        label: t('Cache track'),
        icon: <Download size={13} />,
        disabled: saving?.state === 'running',
        onSelect: () => void saveCollection(id, hit.title, [hit]),
      },
      {
        id: 'artist',
        label: t('Copy artist'),
        icon: <Copy size={13} />,
        onSelect: () => void navigator.clipboard.writeText(hit.artist),
      },
      {
        id: 'title',
        label: t('Copy title'),
        icon: <Copy size={13} />,
        onSelect: () => void navigator.clipboard.writeText(hit.title),
      },
      {
        id: 'open',
        label: t('Open on YouTube Music'),
        icon: <ExternalLink size={13} />,
        onSelect: () => void openExternalUrl(hit.url).catch(() => toast.show(t('Could not open external link'), 'error')),
      },
    ]
    openContextMenu({ ...point, title: hit.title, items })
  }

  const hasArtwork = Boolean(detail.thumbnailUrl || detail.thumbnailUrls?.length)
  const duration = tracks.reduce((total, track) => total + (track.durationSec ?? 0), 0)
  const playAll = () => player.playTracks(tracks, 0)
  return (
    <EditorialDetailLayout
      className="yt-collection-page"
      variant="panorama"
      kindIcon={kind === 'artist' ? <MicVocal size={13} /> : kind === 'album' ? <Disc3 size={13} /> : <ListMusic size={13} />}
      artworkPath={detail.thumbnailUrl}
      artworkLabel={hasArtwork ? name : undefined}
      artworkPreview={<ScArtwork url={detail.thumbnailUrl} fallbackUrls={detail.thumbnailUrls} title={name} />}
      artworkGlow={hasArtwork && <ScArtwork url={detail.thumbnailUrl} fallbackUrls={detail.thumbnailUrls} title="" loading="lazy" fetchPriority="low" />}
      onBack={() => navigate({ name: 'search' })}
      backLabel={t('Back to search')}
      round={kind === 'artist'}
      art={
        <ScArtwork
          url={detail.thumbnailUrl}
          fallbackUrls={detail.thumbnailUrls}
          title={name}
          loading="eager"
          fetchPriority="high"
        />
      }
      kind={
        <>
          <span>{kindLabel}</span>
          <span className="meta-dot">·</span>
          <BrandIcon mark="youtubemusic" size={12} brand />
          <span>{t('YouTube Music')}</span>
        </>
      }
      title={name}
      meta={
        <span>
          {[detail.uploader && kind !== 'artist' ? detail.uploader : null,
            `${detail.count ?? tracks.length} ${t('tracks')}`, duration > 0 ? fmtTime(duration) : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      }
      actions={
        <>
          <CollectionPlayButton disabled={tracks.length === 0} onClick={playAll} />
          {kind !== 'playlist' ? (
            <CollectionFavoriteButton
              active={isFav}
              disabled={favRow === null}
              title={favRow === null ? t('Save it first to add it to favorites.') : undefined}
              onClick={() => {
                if (favRow === null) return
                const next =
                  kind === 'artist'
                    ? api.toggleFavoriteArtist(favRow)
                    : api.toggleFavoriteAlbum(favRow)
                void next.then((now) => {
                  setIsFav(now)
                  toast.show(now ? t('Added to favorites') : t('Remove from favorites'))
                }).catch(error => toast.show(error instanceof Error ? error.message : String(error), 'error'))
              }}
            />
          ) : null}
          <CollectionShuffleButton disabled={tracks.length === 0} onPlay={playAll} />
          {pageSave?.state === 'running' ? (
            <button type="button" className="btn" onClick={cancelSave}>
              {t('Cancel')} · {pageSave.done}/{pageSave.total}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={tracks.length === 0 || anotherSaveRunning}
              title={anotherSaveRunning ? t('Another collection is being saved.') : undefined}
              onClick={() => void saveCollection(id, name, detail.tracks)}
            >
              <Download size={14} />
              {anotherSaveRunning ? t('Another collection is being saved.') : t('Save to library')}
            </button>
          )}
        </>
      }
    >
      {pageSave?.state === 'running' ? (
        <div className="collection-save-progress" role="status" aria-live="polite">
          <div className="collection-save-heading">
            <span><Download size={14} />{t('Saving')}</span>
            <strong>{pageSave.done} / {pageSave.total}</strong>
          </div>
          <div
            className="collection-save-track"
            role="progressbar"
            aria-label={t('Saving')}
            aria-valuemin={0}
            aria-valuemax={pageSave.total}
            aria-valuenow={pageSave.done}
          >
            <span style={{ width: `${pageSave.total === 0 ? 0 : (pageSave.done / pageSave.total) * 100}%` }} />
          </div>
          {pageSave.failed > 0 ? (
            <div className="collection-save-meta">{pageSave.failed} {t('unavailable')}</div>
          ) : null}
        </div>
      ) : pageSave ? (
        <div className="collection-save-result" role="status">
          {pageSave.state === 'cancelled' ? `${t('Saving stopped')} · ` : ''}
          {pageSave.failed > 0
            ? `${t('Saved')} ${pageSave.done - pageSave.failed} ${t('of')} ${pageSave.total} · ${pageSave.failed} ${t('unavailable')}`
            : `${t('Saved')} ${pageSave.done} ${t('tracks')}`}
        </div>
      ) : null}
      <OnlineCollectionTracks key={id} tracks={tracks} onPlay={index => player.playTracks(tracks, index)} onMenu={trackMenu} />
    </EditorialDetailLayout>
  )
}
