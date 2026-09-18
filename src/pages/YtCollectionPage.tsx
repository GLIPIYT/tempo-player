import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { getSettings } from '../state/settings'
import { useNav } from '../state/nav'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import DetailLayout from '../components/common/DetailLayout'
import BrandIcon from '../components/common/BrandIcon'
import ScArtwork from '../components/common/ScArtwork'
import LoadingLine from '../components/common/LoadingLine'
import { ytHitToUnified } from '../providers/youtubeProvider'
import {
  cancelSave,
  getSaveProgress,
  saveCollection,
  subscribeSave,
  type SaveProgress,
} from '../youtube/collectionSaver'
import { fmtTime } from '../utils/format'
import { openContextMenu, type ContextMenuItem } from '../components/common/ContextMenu'
import { Copy, ExternalLink, Play } from 'lucide-react'
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
  const [saving, setSaving] = useState<SaveProgress | null>(getSaveProgress)

  // The save lives outside the page, so it keeps going when this one is left
  // behind - and the page has to follow it rather than own it.
  useEffect(() => subscribeSave(() => setSaving(getSaveProgress())), [])

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

  const kindLabel =
    kind === 'album' ? t('Album') : kind === 'artist' ? t('Artist') : t('Playlist')

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
    <DetailLayout
      onBack={() => navigate({ name: 'search' })}
      backLabel={t('Back to search')}
      round={kind === 'artist'}
      art={<ScArtwork url={detail.thumbnailUrl} title={name} />}
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
          {saving?.running ? (
            <button type="button" className="btn" onClick={cancelSave}>
              {t('Cancel')} · {saving.done}/{saving.total}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={tracks.length === 0}
              onClick={() => void saveCollection(id, name, detail.tracks)}
            >
              {t('Save to library')}
            </button>
          )}
        </>
      }
    >
      {saving && !saving.running ? (
        <div className="muted settings-line">
          {saving.failed > 0
            ? `${t('Saved')} ${saving.done - saving.failed} ${t('of')} ${saving.total} · ${saving.failed} ${t('unavailable')}`
            : `${t('Saved')} ${saving.done} ${t('tracks')}`}
        </div>
      ) : null}
      {saving?.running ? (
        <div className="muted settings-line">
          {`${t('Saving')} ${saving.done}/${saving.total}…`}
        </div>
      ) : null}
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
    </DetailLayout>
  )
}
