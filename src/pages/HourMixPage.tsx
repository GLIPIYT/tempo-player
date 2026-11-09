import { useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { FileDown, Play, Pencil, RefreshCw } from 'lucide-react'
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
import CustomMixEditor from '../components/home/CustomMixEditor'
import { customMixService } from '../features/mixes/service'
import { generateCustomMix } from '../features/mixes/rules'
import { presetFromMix } from '../features/mixes/presets'
import { useAsync } from '../hooks/useAsync'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import type { CustomMixRule } from '../features/mixes/types'
import { mixMessage } from '../features/mixes/messages'

export default function HourMixPage({ mix }: { mix: HourMix }) {
  const t = useT()
  const player = usePlayer()
  const { navigate } = useNav()
  const [exportBusy, setExportBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const rules = useAsync(() => editing ? customMixService.list() : Promise.resolve([]), [editing])
  const candidates = useAsync(() => editing ? customMixService.getCandidates() : Promise.resolve([]), [editing])
  const regenerate = async (rule: CustomMixRule, saveRule = false) => {
    setGenerating(true)
    try {
      const saved = saveRule ? await customMixService.save(rule) : rule
      const library = await customMixService.getCandidates()
      const extra = await customMixService.augmentOnlineGenre(saved, library)
      const result = generateCustomMix(saved, [...library, ...extra.candidates], { limit: 24 })
      navigate({ name: 'hour-mix', mix: { key: `custom:${saved.id}`, kind: 'custom', title: saved.name, description: '', tracks: result.tracks, warnings: [...result.warnings, ...extra.warnings], rule: saved } })
      bumpLibraryVersion()
    } finally { setGenerating(false) }
  }

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

  return (<>
    {editing && mix.rule ? <CustomMixEditor initial={mix.rule}
      genres={(candidates.data ?? []).flatMap(c => c.track.genre?.split(/[;,|]/u).map(s => s.trim()).filter(Boolean) ?? [])}
      presets={[{ name: mix.title, rule: presetFromMix(mix), cover: mix.tracks[0]?.coverPath }, ...(rules.data ?? []).filter(rule => rule.id !== mix.rule?.id).map(rule => ({ name: rule.name, rule }))]}
      onSave={rule => regenerate(rule, true)} onDelete={async () => { await customMixService.delete(mix.rule!.id!); bumpLibraryVersion(); navigate({ name: 'home' }) }} onClose={() => setEditing(false)} /> : null}
    <EditorialDetailLayout
      className="local-playlist-page hour-mix-page"
      onBack={() => navigate({ name: 'home' })}
      backLabel={t('Home')}
      art={
        mix.tracks.length > 1 ? (
          <div className="playlist-cover-mosaic" aria-label={t('Playlist cover')}>
            {mix.tracks.slice(0, 4).map((track) => (
              <Cover key={track.id} path={track.coverPath} label={track.title} size={112} />
            ))}
          </div>
        ) : (
          <Cover path={mix.tracks[0]?.coverPath ?? null} label={mix.title} size={232} />
        )
      }
      kind={t(mix.kind === 'custom' ? 'Custom mix' : mix.kind === 'hour' ? 'For this hour' : mix.kind === 'artist' ? 'Artist mix' : 'From your library')}
      title={mix.title}
      description={t(mix.description)}
      meta={<span>{mix.tracks.length} {t(mix.tracks.length === 1 ? 'track' : 'tracks')}{mix.kind !== 'custom' ? ` · ${t('From your library')}` : ''}</span>}
      actions={
        <>
          <button className="btn btn-primary" disabled={!mix.tracks.length} onClick={() => player.playTracks(tracksToUnified(mix.tracks), 0)}>
            <Play size={14} fill="currentColor" />
            {t('Play mix')}
          </button>
          {mix.rule ? <><button className="btn" onClick={() => setEditing(true)}><Pencil size={14} />{t('Edit rule')}</button><button className="btn" disabled={generating} onClick={() => void regenerate(mix.rule!).catch(e => toast.show(String(e), 'error'))}><RefreshCw size={14} className={generating ? 'spin' : undefined} />{t('Refresh')}</button></> : null}
          <button className="btn" disabled={exportBusy} title={t('Export playlist (m3u8)')} onClick={() => void exportMix()}>
            <FileDown size={14} />
            m3u8
          </button>
        </>
      }
    >
      {mix.warnings?.map(warning => <p className="muted" key={warning}>{mixMessage(t, warning)}</p>)}
      {!mix.tracks.length ? <p className="muted">{t('No tracks match this rule. Try widening the filters.')}</p> : null}
      <TrackList tracks={mix.tracks} showHeader />
    </EditorialDetailLayout>
  </>)
}
