import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { getSettings } from '../state/settings'
import { useNav } from '../state/nav'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
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
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import { Copy, Download, ExternalLink, Play, Star } from 'lucide-react'
import { toast } from '../components/common/Toast'
import type { YtCollectionDetail } from '../types/models'

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
  const player = usePlayer()
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
  }, [id])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- name is derived from detail
  }, [detail, kind, saveFinished])

  const kindLabel =
    kind === 'album' ? t('Album') : kind === 'artist' ? t('Artist') : t('Playlist')
  const pageSave = saving?.id === id ? saving : null
  const anotherSaveRunning = saving?.state === 'running' && saving.id !== id

  // An album arrives as "Album - <name>", with the kind already spelled out.
  const name = detail
    ? kind === 'artist'
      ? (detail.uploader ?? detail.title ?? '')
      : kind === 'album'
        ? (detail.title ?? '').replace(/^Album - /i, '')
        : (detail.title ?? '')
    : ''

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

  const tracks = detail.tracks.map(ytHitToUnified)

  // The same things a track offers anywhere else, minus the ones that need a
  // library row: a search result has none until it has been saved, and
  // favourites are kept against those rows.
  const trackMenu = (e: React.MouseEvent, index: number): void => {
    e.preventDefault()
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
        onSelect: () => window.open(hit.url, '_blank'),
      },
    ]
    openContextMenu({ x: e.clientX, y: e.clientY, title: hit.title, items })
  }

  return (
    <EditorialDetailLayout
      className="yt-collection-page"
      onBack={() => navigate({ name: 'search' })}
      backLabel={t('Back to search')}
      round={kind === 'artist'}
      art={
        <ScArtwork
          url={detail.thumbnailUrl}
          fallbackUrls={detail.thumbnailUrls}
          title={name}
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
          {[detail.uploader && kind !== 'artist' ? detail.uploader : null, detail.count
            ? `${detail.count} ${t('tracks')}`
            : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      }
      actions={
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={tracks.length === 0}
            onClick={() => player.playTracks(tracks, 0)}
          >
            {t('Play')}
          </button>
          {kind !== 'playlist' ? (
            <button
              type="button"
              className="btn"
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
                })
              }}
            >
              <Star size={14} fill={isFav ? 'currentColor' : 'none'} />
            </button>
          ) : null}
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
      <div className="detail-tracklist-heading yt-tracklist-heading">
        <h2>{t('Tracklist')}</h2>
        <span>{tracks.length} {tracks.length === 1 ? t('track') : t('tracks')}</span>
      </div>
      <div className="sc-list">
        {tracks.map((track, index) => (
          <div
            key={track.sourceId}
            className="sc-row"
            onClick={() => player.playTracks(tracks, index)}
            onContextMenu={(e) => trackMenu(e, index)}
          >
            <div className="sc-meta">
              <span className="sc-title">{track.title}</span>
              <span className="sc-artist">{track.artists.join(', ')}</span>
            </div>
            <span className="sc-duration">
              {track.durationSec ? fmtTime(track.durationSec) : '—'}
            </span>
          </div>
        ))}
      </div>
    </EditorialDetailLayout>
  )
}
