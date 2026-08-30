import { useState } from 'react'
import { ListMusic, Plus } from 'lucide-react'
import { useNav } from '../state/nav'
import { api } from '../api/client'
import type { Playlist } from '../types/models'
import { useAsync } from '../hooks/useAsync'
import { useLibraryVersion } from '../hooks/useLibraryVersion'
import { useT } from '../i18n'
import { playlistDisplayName } from '../utils/playlists'
import Cover from '../components/common/Cover'
import EmptyState from '../components/common/EmptyState'
import Modal from '../components/common/Modal'

export default function PlaylistsPage() {
  const { navigate } = useNav()
  const t = useT()
  const version = useLibraryVersion()
  const { data, loading, error, reload } = useAsync(() => api.listPlaylists(), [version])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setBusy(true)
    try {
      const pl: Playlist = await api.createPlaylist(trimmed)
      setCreating(false)
      setName('')
      reload()
      navigate({ name: 'playlist', id: pl.id })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('Playlists')}</h1>
          <div className="page-sub">{data ? `${data.length} ${t('playlists')}` : t('Loading…')}</div>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              setName('')
              setCreating(true)
            }}
          >
            <Plus size={15} />
            {t('New playlist')}
          </button>
        </div>
      </div>

      {error ? <div className="error-line">{error}</div> : null}
      {loading ? (
        <div className="muted">{t('Loading…')}</div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<ListMusic size={34} />}
          title={t('No playlists yet')}
          hint={t('Create a playlist and add tracks to it.')}
          action={
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} />
              {t('New playlist')}
            </button>
          }
        />
      ) : (
        <div className="cards-grid">
          {data.map((pl) => {
            const displayName = playlistDisplayName(pl, pl.name, t)
            return (
              <button
                key={pl.id}
                className="card"
                onClick={() => navigate({ name: 'playlist', id: pl.id })}
                title={displayName}
              >
                <div className="playlist-tile">
                  {pl.coverPath ? (
                    <Cover path={pl.coverPath} label={displayName} size={200} />
                  ) : (
                    <ListMusic size={28} />
                  )}
                </div>
                <span className="card-title">{displayName}</span>
                <span className="card-sub">{pl.trackCount ?? 0} {t('tracks')}</span>
              </button>
            )
          })}
        </div>
      )}

      <Modal open={creating} title={t('New playlist')} onClose={() => setCreating(false)}>
        <input
          className="text-input"
          autoFocus
          value={name}
          placeholder={t('Playlist name')}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={() => setCreating(false)}>
            {t('Cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || name.trim().length === 0}
            onClick={() => void create()}
          >
            {t('Create')}
          </button>
        </div>
      </Modal>
    </div>
  )
}
