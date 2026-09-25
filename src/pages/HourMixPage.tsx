import { useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { FileDown, Play } from 'lucide-react'
import { api } from '../api/client'
import Cover from '../components/common/Cover'
import EditorialDetailLayout from '../components/common/EditorialDetailLayout'
import TrackList from '../components/common/TrackList'
import { toast } from '../components/common/Toast'
import { useT } from '../i18n'
import { usePlayer } from '../player'
import { useNav } from '../state/nav'
import { tracksToUnified } from '../utils/unified'
import type { HourMix } from '../utils/hourMixes'

export default function HourMixPage({ mix }: { mix: HourMix }) {
  const t = useT()
  const player = usePlayer()
  const { navigate } = useNav()
  const [exportBusy, setExportBusy] = useState(false)

  const exportMix = async () => {
    setExportBusy(true)
    try {
      const filename = (mix.title.replace(/[<>:"/\\|?*]/g, '').trim() || 'Tempo mix') + '.m3u8'
      const path = await save({ defaultPath: filename, filters: [{ name: 'M3U playlist', extensions: ['m3u8'] }] })
      if (typeof path !== 'string') return
      const count = await api.exportTracksM3u8(mix.tracks.map((track) => track.id), path)
      toast.show(`${t('Exported')}: ${count}`)
    } catch (error: unknown) {
      toast.show(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <EditorialDetailLayout
      onBack={() => navigate({ name: 'home' })}
      backLabel={t('Home')}
      art={<Cover path={mix.tracks.find((track) => track.coverPath)?.coverPath ?? null} label={mix.title} size={232} />}
      kind={t(mix.key === 'mix' ? 'For this hour' : 'Artist mix')}
      title={mix.title}
      meta={<span>{mix.tracks.length} {t(mix.tracks.length === 1 ? 'track' : 'tracks')} · {t('From your library')}</span>}
      actions={
        <>
          <button className="btn btn-primary" onClick={() => player.playTracks(tracksToUnified(mix.tracks), 0)}>
            <Play size={14} fill="currentColor" />
            {t('Play mix')}
          </button>
          <button className="btn" disabled={exportBusy} title={t('Export playlist (m3u8)')} onClick={() => void exportMix()}>
            <FileDown size={14} />
            m3u8
          </button>
        </>
      }
    >
      <TrackList tracks={mix.tracks} />
    </EditorialDetailLayout>
  )
}
