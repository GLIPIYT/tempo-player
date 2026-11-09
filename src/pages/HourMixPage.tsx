import { useCallback, useEffect, useRef, useState } from 'react'
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
import { presetFromMix } from '../features/mixes/presets'
import { useAsync } from '../hooks/useAsync'
import { bumpLibraryVersion } from '../utils/libraryVersion'
import type {
  CustomMixGenerationReason,
  CustomMixRule,
} from '../features/mixes/types'
import { mixMessage } from '../features/mixes/messages'

export default function HourMixPage({ mix: initialMix }: { mix: HourMix }) {
  const t = useT()
  const player = usePlayer()
  const { navigate } = useNav()
  const [exportBusy, setExportBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [resolvedMix, setResolvedMix] = useState<HourMix | null>(null)
  const mix = resolvedMix?.key === initialMix.key ? resolvedMix : initialMix
  const currentMix = useRef(mix)
  currentMix.current = mix
  const inputMix = useRef(initialMix)
  inputMix.current = initialMix
  const request = useRef(0)
  const generationActive = useRef(false)
  const invalidateGeneration = useCallback(() => { request.current++ }, [])
  const generatedAt = useRef<number | null>(null)
  const [generationEnded, setGenerationEnded] = useState(0)
  const generate = useCallback(
    async (rule: CustomMixRule, reason: CustomMixGenerationReason) => {
      const token = ++request.current
      generationActive.current = true
      setGenerating(true)
      try {
        const library = await customMixService.getCandidates()
        const result = await customMixService.generate(rule, library, {
          reason,
        })
        if (token !== request.current) return
        generatedAt.current = result.generatedAt
        setResolvedMix({
          key: `custom:${rule.id}`,
          kind: 'custom',
          title: rule.name,
          description: rule.description,
          tracks: result.tracks,
          warnings: result.warnings,
          generatedAt: result.generatedAt,
          rule,
        })
      } finally {
        if (token === request.current) {
          generationActive.current = false
          setGenerating(false)
          setGenerationEnded((value) => value + 1)
        }
      }
    },
    [],
  )
  useEffect(() => {
    generatedAt.current = null
    const rule = inputMix.current.rule
    if (rule)
      void generate(rule, 'open').catch((error) =>
        toast.show(String(error), 'error'),
      )
    return invalidateGeneration
  }, [initialMix.key, generate, invalidateGeneration])
  const refreshMinutes = mix.rule?.refreshIntervalMinutes ?? 0
  useEffect(() => {
    if (refreshMinutes <= 0) return
    const dueIn =
      generatedAt.current == null
        ? 0
        : (generatedAt.current + refreshMinutes * 60) * 1000 - Date.now()
    const timer = setTimeout(
      () => {
        if (generationActive.current) return
        const rule = currentMix.current.rule
        if (rule)
          void generate(rule, 'scheduled').catch((error) =>
            toast.show(String(error), 'error'),
          )
      },
      dueIn > 0 ? Math.max(1000, dueIn) : 60_000,
    )
    return () => clearTimeout(timer)
  }, [initialMix.key, refreshMinutes, generationEnded, generate])
  const rules = useAsync(
    () => (editing ? customMixService.list() : Promise.resolve([])),
    [editing],
  )
  const candidates = useAsync(
    () => (editing ? customMixService.getCandidates() : Promise.resolve([])),
    [editing],
  )
  const regenerate = async (rule: CustomMixRule, saveRule = false) => {
    const saved = saveRule ? await customMixService.save(rule) : rule
    await generate(saved, 'refresh')
    if (saveRule) bumpLibraryVersion()
  }

  const exportMix = async () => {
    setExportBusy(true)
    try {
      const filename =
        (mix.title.replace(/[<>:"/\\|?*]/g, '').trim() || 'Tempo mix') + '.m3u8'
      const path = await save({
        defaultPath: filename,
        filters: [{ name: 'M3U playlist', extensions: ['m3u8'] }],
      })
      if (typeof path !== 'string') return
      const count = await api.exportTracksM3u8(
        mix.tracks.map((track) => track.id),
        path,
      )
      toast.show(`${t('Exported')}: ${count}`)
    } catch (error: unknown) {
      toast.show(
        error instanceof Error ? error.message : String(error),
        'error',
      )
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <>
      {editing && mix.rule ? (
        <CustomMixEditor
          initial={mix.rule}
          genres={(candidates.data ?? []).flatMap(
            (c) =>
              c.track.genre
                ?.split(/[;,|]/u)
                .map((s) => s.trim())
                .filter(Boolean) ?? [],
          )}
          presets={[
            {
              name: mix.title,
              rule: presetFromMix(mix),
              cover: mix.tracks[0]?.coverPath,
            },
            ...(rules.data ?? [])
              .filter((rule) => rule.id !== mix.rule?.id)
              .map((rule) => ({ name: rule.name, rule })),
          ]}
          onSave={(rule) => regenerate(rule, true)}
          onDelete={async () => {
            await customMixService.delete(mix.rule!.id!)
            bumpLibraryVersion()
            navigate({ name: 'home' })
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <EditorialDetailLayout
        className="local-playlist-page hour-mix-page"
        onBack={() => navigate({ name: 'home' })}
        backLabel={t('Home')}
        art={
          mix.tracks.length > 1 ? (
            <div
              className="playlist-cover-mosaic"
              aria-label={t('Playlist cover')}
            >
              {mix.tracks.slice(0, 4).map((track) => (
                <Cover
                  key={track.id}
                  path={track.coverPath}
                  label={track.title}
                  size={112}
                />
              ))}
            </div>
          ) : (
            <Cover
              path={mix.tracks[0]?.coverPath ?? null}
              label={mix.title}
              size={232}
            />
          )
        }
        kind={t(
          mix.kind === 'custom'
            ? 'Custom mix'
            : mix.kind === 'hour'
              ? 'For this hour'
              : mix.kind === 'artist'
                ? 'Artist mix'
                : 'From your library',
        )}
        title={mix.title}
        description={
          mix.kind === 'custom' ? mix.description : t(mix.description)
        }
        meta={
          <span>
            {mix.tracks.length}{' '}
            {t(mix.tracks.length === 1 ? 'track' : 'tracks')}
            {mix.kind !== 'custom' ? ` · ${t('From your library')}` : ''}
          </span>
        }
        actions={
          <>
            <button
              className="btn btn-primary"
              disabled={!mix.tracks.length}
              onClick={() => player.playTracks(tracksToUnified(mix.tracks), 0)}
            >
              <Play size={14} fill="currentColor" />
              {t('Play mix')}
            </button>
            {mix.rule ? (
              <>
                <button className="btn" onClick={() => setEditing(true)}>
                  <Pencil size={14} />
                  {t('Edit rule')}
                </button>
                <button
                  className="btn"
                  disabled={generating}
                  onClick={() =>
                    void regenerate(mix.rule!).catch((e) =>
                      toast.show(String(e), 'error'),
                    )
                  }
                >
                  <RefreshCw
                    size={14}
                    className={generating ? 'spin' : undefined}
                  />
                  {t('Refresh')}
                </button>
              </>
            ) : null}
            <button
              className="btn"
              disabled={exportBusy}
              title={t('Export playlist (m3u8)')}
              onClick={() => void exportMix()}
            >
              <FileDown size={14} />
              m3u8
            </button>
          </>
        }
      >
        {mix.warnings?.map((warning) => (
          <p className="muted" key={warning}>
            {mixMessage(t, warning)}
          </p>
        ))}
        {!mix.tracks.length ? (
          <p className="muted">
            {t('No tracks match this rule. Try widening the filters.')}
          </p>
        ) : null}
        <TrackList tracks={mix.tracks} showHeader />
      </EditorialDetailLayout>
    </>
  )
}
