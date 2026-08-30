import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  ChevronDown,
  FolderOpen,
  FolderPlus,
  Globe,
  HardDrive,
  Info,
  LibraryBig,
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { api } from '../api/client'
import { useAsync } from '../hooks/useAsync'
import { useFolders } from '../hooks/useFolders'
import { useScanProgress } from '../hooks/useScanProgress'
import { useSettings } from '../state/settings'
import { resolveLang, useT } from '../i18n'
import ScanLine from '../components/common/ScanLine'
import ConfirmModal from '../components/common/ConfirmModal'
import type { CustomTheme, ThemeTokens } from '../types/theme'
import { TOKEN_VARS } from '../types/theme'
import { CUSTOM_DEFAULT_BASE, PRESETS, getPreset } from '../theme/presets'
import { parseHex, toHex } from '../theme/engine'
import { bumpLibraryVersion } from '../utils/libraryVersion'

type Category = 'general' | 'appearance' | 'library' | 'storage' | 'about'
type FontMode = 'default' | 'system' | 'file'
type GlyphScript = 'latin' | 'cyrillic'

type IconType = typeof Globe

const NAV: { id: Category; key: string; Icon: IconType }[] = [
  { id: 'general', key: 'General', Icon: Globe },
  { id: 'appearance', key: 'Appearance', Icon: Palette },
  { id: 'library', key: 'Library', Icon: LibraryBig },
  { id: 'storage', key: 'Storage', Icon: HardDrive },
  { id: 'about', key: 'About', Icon: Info },
]

const FALLBACK_FONTS = [
  'Segoe UI',
  'Arial',
  'Calibri',
  'Cascadia Code',
  'Consolas',
  'Georgia',
  'Verdana',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Courier New',
]

const FONT_PREVIEW_TEXT = 'The quick brown fox — Быстрая рыжая лиса'

const GLYPH_PROBES: Record<GlyphScript, string> = {
  latin: 'TheQuickBrownFox0123',
  cyrillic: 'ЖЙёФы',
}

const coverageCache = new Map<string, boolean>()
let glyphCtx: CanvasRenderingContext2D | null = null
let localFontsCache: string[] | null = null

function measureProbe(font: string, text: string): number {
  if (glyphCtx === null) {
    const c = document.createElement('canvas')
    glyphCtx = c.getContext('2d')
  }
  if (glyphCtx === null) return NaN
  glyphCtx.font = font
  return glyphCtx.measureText(text).width
}

function supportsGlyphs(family: string, script: GlyphScript): boolean {
  const key = `${script}:${family}`
  const cached = coverageCache.get(key)
  if (cached !== undefined) return cached
  const safe = family.replace(/["\\]/g, '').trim()
  let ok = true
  if (safe.length > 0) {
    const probe = GLYPH_PROBES[script]
    const withFamily = measureProbe(`16px "${safe}", monospace`, probe)
    const fallbackOnly = measureProbe('16px monospace', probe)
    if (Number.isFinite(withFamily) && Number.isFinite(fallbackOnly) && fallbackOnly > 0) {
      ok = Math.abs(withFamily - fallbackOnly) > 0.5
    }
  }
  coverageCache.set(key, ok)
  return ok
}

const TOKEN_LABELS: Record<keyof ThemeTokens, string> = {
  bg: 'Background',
  bgElevated: 'Background elevated',
  surface: 'Surface',
  surfaceHover: 'Surface hover',
  border: 'Border',
  text: 'Text',
  textMuted: 'Text muted',
  accent: 'Accent',
  accentStrong: 'Accent strong',
  accentSoft: 'Accent soft',
  playButton: 'Play button',
  danger: 'Danger',
}

const TOKEN_KEYS = Object.keys(TOKEN_LABELS) as (keyof ThemeTokens)[]

function fileName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

function asColorInput(value: string | undefined): string {
  const rgb = typeof value === 'string' ? parseHex(value) : null
  return rgb === null ? '#000000' : toHex(rgb)
}

function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="seg" role="group">
      {props.options.map((o) => (
        <button
          key={o.value}
          className={o.value === props.value ? 'seg-btn is-active' : 'seg-btn'}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function fillPct(min: number, max: number, v: number): string {
  return `${((v - min) / (max - min)) * 100}%`
}

function SliderRow(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  display: string
  onChange: (v: number) => void
}) {
  return (
    <div className="set-row">
      <span className="set-row-label">{props.label}</span>
      <div className="slider-row">
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))}
          style={{ '--fill': fillPct(props.min, props.max, props.value) } as CSSProperties}
        />
        <span className="slider-value">{props.display}</span>
      </div>
    </div>
  )
}

function CommitSlider(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  format: (v: number) => string
  onCommit: (v: number) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState<number | null>(null)
  const draftRef = useRef<number | null>(null)
  const kbRef = useRef(false)

  const commit = () => {
    const d = draftRef.current
    if (d === null) return
    draftRef.current = null
    setDraft(null)
    props.onCommit(d)
  }

  useEffect(() => {
    if (draft === null) return
    const onUp = () => commit()
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [draft])

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    if (kbRef.current) {
      kbRef.current = false
      draftRef.current = null
      setDraft(null)
      props.onCommit(v)
      return
    }
    draftRef.current = v
    setDraft(v)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (
      e.key.startsWith('Arrow') ||
      e.key === 'Home' ||
      e.key === 'End' ||
      e.key === 'PageUp' ||
      e.key === 'PageDown'
    ) {
      kbRef.current = true
    }
  }

  const shown = draft ?? props.value
  return (
    <div className="set-row">
      <span className="set-row-label">{props.label}</span>
      <div className={draft === null ? 'slider-row' : 'slider-row is-drafting'}>
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={shown}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={commit}
          style={{ '--fill': fillPct(props.min, props.max, shown) } as CSSProperties}
        />
        <span
          className={draft === null ? 'slider-value' : 'slider-value is-draft'}
          title={draft === null ? undefined : t('Release to apply')}
        >
          {props.format(shown)}
          {draft === null ? '' : ' ·'}
        </span>
      </div>
    </div>
  )
}

function FontListBox(props: { fonts: string[]; value: string; onSelect: (f: string) => void }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children[active]
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const openList = () => {
    setActive(Math.max(0, props.fonts.indexOf(props.value)))
    setOpen(true)
  }

  const choose = (f: string) => {
    props.onSelect(f)
    setOpen(false)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openList()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, props.fonts.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const f = props.fonts[active]
      if (f !== undefined) choose(f)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="font-select" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="font-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <span>{props.value}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="font-list" role="listbox" ref={listRef}>
          {props.fonts.map((f, i) => (
            <button
              type="button"
              key={f}
              role="option"
              aria-selected={f === props.value}
              className={
                'font-opt' + (i === active ? ' is-active' : '') + (f === props.value ? ' is-selected' : '')
              }
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(f)}
            >
              <span className="font-opt-name">{f}</span>
              <span
                className="font-opt-preview"
                style={{ fontFamily: `"${f.replace(/"/g, '')}", sans-serif` }}
              >
                {FONT_PREVIEW_TEXT}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ColorField(props: { value: string | undefined; onChange: (v: string) => void }) {
  const t = useT()
  return (
    <div className="color-field">
      <input
        type="color"
        className="swatch"
        value={asColorInput(props.value)}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <span className="color-hex">{props.value ? props.value : t('auto')}</span>
    </div>
  )
}

function Card(props: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="set-card">
      <div className="set-card-title">{props.title}</div>
      {props.desc ? <div className="set-card-desc">{props.desc}</div> : null}
      {props.children}
    </section>
  )
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

function StorageCard() {
  const t = useT()
  const info = useAsync(() => api.getCoversCacheInfo(), [])
  const scInfo = useAsync(() => api.scCacheInfo(), [])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [scConfirmOpen, setScConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scBusy, setScBusy] = useState(false)

  const limitMb = scInfo.data ? Math.round(scInfo.data.limitBytes / 1048576) : 0

  const formatLimit = (v: number): string => {
    if (v <= 0) return t('Unlimited')
    if (v >= 1024) {
      const gb = v / 1024
      return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
    }
    return `${v} MB`
  }

  const applyLimit = async (v: number) => {
    try {
      await api.setScCacheLimit(Math.round(v * 1048576))
      scInfo.reload()
    } catch {}
  }

  const clearCovers = async () => {
    setConfirmOpen(false)
    setBusy(true)
    try {
      await api.clearCoversCache()
      await api.rescanLibrary(true)
      info.reload()
    } catch {} finally {
      setBusy(false)
    }
  }

  const changeScCacheDir = async () => {
    setScBusy(true)
    try {
      const sel = await open({ directory: true, multiple: false })
      if (typeof sel === 'string') {
        await api.setScCacheDir(sel)
        scInfo.reload()
      }
    } catch {} finally {
      setScBusy(false)
    }
  }

  const clearScCache = async () => {
    setScConfirmOpen(false)
    setScBusy(true)
    try {
      await api.clearScCache()
      scInfo.reload()
      bumpLibraryVersion()
    } catch {} finally {
      setScBusy(false)
    }
  }

  return (
    <Card title={t('Storage')} desc={t('Where Tempo keeps its data.')}>
      {info.error ? <div className="error-line">{info.error}</div> : null}
      {!info.data && info.loading ? (
        <div className="muted settings-line">{t('Loading…')}</div>
      ) : null}
      {info.data ? (
        <>
          <div className="storage-path" title={info.data.path}>
            {info.data.path}
          </div>
          <div className="muted settings-line" style={{ marginTop: 6 }}>
            {fmtBytes(info.data.totalBytes)} · {info.data.fileCount} {t('covers')}
          </div>
        </>
      ) : null}
      <div className="muted settings-line" style={{ marginTop: 8 }}>
        {t('The music database lives in the application data directory as tempo.db. Removing a folder also removes its cached references.')}
      </div>
      <div className="set-actions">
        <button className="btn btn-danger" disabled={busy} onClick={() => setConfirmOpen(true)}>
          <Trash2 size={14} />
          {t('Clear covers')}
        </button>
        <button
          className="icon-btn"
          aria-label={t('Refresh')}
          disabled={busy}
          style={{ width: 30, height: 30 }}
          onClick={() => info.reload()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="set-note">{t('Covers will be restored on rescan')}</div>
      <ConfirmModal
        open={confirmOpen}
        danger
        title={t('Clear covers')}
        message={`${t('Cached album art will be deleted from the covers directory.')} ${t('Covers will be restored on rescan')}`}
        confirmLabel={t('Clear')}
        onConfirm={() => void clearCovers()}
        onClose={() => setConfirmOpen(false)}
      />
      <div className="set-sc-section">
        <div className="section-label">{t('SoundCloud cache')}</div>
        {scInfo.error ? <div className="error-line">{scInfo.error}</div> : null}
        {!scInfo.data && scInfo.loading ? (
          <div className="muted settings-line">{t('Loading…')}</div>
        ) : null}
        {scInfo.data ? (
          <>
            <div className="storage-path" title={scInfo.data.path}>
              {scInfo.data.path}
            </div>
            <div className="muted settings-line" style={{ marginTop: 6 }}>
              {fmtBytes(scInfo.data.totalBytes)} ·{' '}
              {scInfo.data.fileCount === 1 ? `1 ${t('file')}` : `${scInfo.data.fileCount} ${t('files')}`}
            </div>
          </>
        ) : null}
        <CommitSlider
          label={t('Cache limit')}
          min={0}
          max={20480}
          step={256}
          value={limitMb}
          format={formatLimit}
          onCommit={(v) => void applyLimit(v)}
        />
        <div className="set-note">
          {t('When the cache exceeds the limit, the least recently played tracks are removed first.')}
        </div>
        <div className="set-actions">
          <button className="btn" disabled={scBusy} onClick={() => void changeScCacheDir()}>
            <FolderOpen size={14} />
            {t('Change folder')}
          </button>
          <button
            className="btn btn-danger"
            disabled={scBusy || scInfo.data === null}
            onClick={() => setScConfirmOpen(true)}
          >
            <Trash2 size={14} />
            {t('Clear cache')}
          </button>
          <button
            className="icon-btn"
            aria-label={t('Refresh')}
            disabled={scBusy}
            style={{ width: 30, height: 30 }}
            onClick={() => scInfo.reload()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <ConfirmModal
          open={scConfirmOpen}
          danger
          title={t('Clear cache')}
          message={`${t('This deletes all cached SoundCloud tracks and removes them from your playlists')} ${t('This cannot be undone.')}`}
          confirmLabel={t('Clear')}
          onConfirm={() => void clearScCache()}
          onClose={() => setScConfirmOpen(false)}
        />
      </div>
    </Card>
  )
}

function ThemePreview({ tokens }: { tokens: ThemeTokens }) {
  return (
    <div
      className="theme-preview"
      style={{ background: tokens.bg, color: tokens.textMuted, flexDirection: 'row' }}
    >
      <div className="theme-preview-side" style={{ background: tokens.bgElevated }}>
        <span className="theme-preview-line" />
        <span className="theme-preview-line" />
        <span className="theme-preview-line" />
      </div>
      <div className="theme-preview-main">
        <span className="theme-preview-dot" style={{ background: tokens.playButton }} />
        <span className="theme-preview-pill" style={{ background: tokens.accent }} />
        <span className="theme-preview-pill" style={{ background: tokens.border }} />
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const { settings, update, resetAppearance } = useSettings()
  const t = useT()
  const foldersApi = useFolders()
  const scan = useScanProgress()

  const [cat, setCat] = useState<Category>('general')
  const [advOpen, setAdvOpen] = useState(false)
  const [sysFonts, setSysFonts] = useState<string[] | null>(null)
  const [fontBusy, setFontBusy] = useState(false)
  const [bgBusy, setBgBusy] = useState(false)

  const fontMode: FontMode =
    settings.font.importedPath !== null ? 'file' : settings.font.family !== null ? 'system' : 'default'

  useEffect(() => {
    if (fontMode !== 'system' || sysFonts !== null) return
    if (localFontsCache !== null) {
      setSysFonts(localFontsCache)
      return
    }
    let cancelled = false
    const q = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ fullName: string; family: string }>> })
      .queryLocalFonts
    if (typeof q === 'function') {
      q()
        .then((list) => {
          const fams = Array.from(new Set(list.map((f) => f.family)))
            .filter((f) => f.length > 0)
            .sort((a, b) => a.localeCompare(b))
          const res = fams.length > 0 ? fams : FALLBACK_FONTS
          localFontsCache = res
          if (!cancelled) setSysFonts(res)
        })
        .catch(() => {
          localFontsCache = FALLBACK_FONTS
          if (!cancelled) setSysFonts(FALLBACK_FONTS)
        })
    } else {
      localFontsCache = FALLBACK_FONTS
      setSysFonts(FALLBACK_FONTS)
    }
    return () => {
      cancelled = true
    }
  }, [fontMode, sysFonts])

  const needCyrillic = resolveLang(settings.lang) === 'ru'

  const fontData = useMemo<{ fonts: string[] | null; hidden: number }>(() => {
    if (sysFonts === null) return { fonts: null, hidden: 0 }
    const script: GlyphScript = needCyrillic ? 'cyrillic' : 'latin'
    const kept = sysFonts.filter((f) => supportsGlyphs(f, script))
    const hidden = sysFonts.length - kept.length
    const current = settings.font.family
    const list = current !== null && !kept.includes(current) ? [current, ...kept] : kept
    return { fonts: list.length > 0 ? list : FALLBACK_FONTS, hidden }
  }, [sysFonts, needCyrillic, settings.font.family])

  const custom: CustomTheme =
    settings.theme.kind === 'custom'
      ? { base: { ...settings.theme.custom.base }, overrides: { ...settings.theme.custom.overrides } }
      : { base: { ...CUSTOM_DEFAULT_BASE }, overrides: {} }

  const setPreset = (id: string) => update({ theme: { kind: 'preset', presetId: id } })

  const activateCustom = () => {
    if (settings.theme.kind !== 'custom') {
      const seed =
        settings.theme.kind === 'preset' ? getPreset(settings.theme.presetId)?.tokens : undefined
      update({
        theme: {
          kind: 'custom',
          custom: {
            base: seed
              ? { accent: seed.accent, background: seed.bg, surface: seed.surface, playButton: seed.playButton }
              : { ...CUSTOM_DEFAULT_BASE },
            overrides: {},
          },
        },
      })
    }
    setCat('appearance')
  }

  const updateCustom = (next: CustomTheme) => update({ theme: { kind: 'custom', custom: next } })

  const setFontMode = (mode: FontMode) => {
    if (mode === 'default') update({ font: { family: null, importedPath: null } })
    else if (mode === 'system') update({ font: { family: settings.font.family ?? 'Segoe UI', importedPath: null } })
  }

  const importFont = async () => {
    setFontBusy(true)
    try {
      const sel = await open({
        multiple: false,
        filters: [{ name: 'Font', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
      })
      if (typeof sel === 'string') {
        const stored = await api.importFont(sel)
        update({ font: { importedPath: stored, family: 'TempoCustom' } })
      }
    } catch {
    } finally {
      setFontBusy(false)
    }
  }

  const importBackground = async () => {
    setBgBusy(true)
    try {
      const sel = await open({
        multiple: false,
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      })
      if (typeof sel === 'string') {
        const stored = await api.importBackground(sel)
        update({ background: { path: stored } })
      }
    } catch {
    } finally {
      setBgBusy(false)
    }
  }

  const removeFolder = async (id: number, path: string) => {
    const ok = window.confirm(`${t('Remove folder from library?')}\n${path}\n${t('Its tracks will be removed too.')}`)
    if (!ok) return
    await foldersApi.removeFolder(id)
  }

  const resolvedTokens = (): Record<keyof ThemeTokens, string> => {
    const cs = getComputedStyle(document.documentElement)
    const out = {} as Record<keyof ThemeTokens, string>
    for (const k of TOKEN_KEYS) out[k] = cs.getPropertyValue(TOKEN_VARS[k]).trim()
    return out
  }

  const activeId = settings.theme.kind === 'preset' ? settings.theme.presetId : null

  const advancedOpen = settings.theme.kind === 'custom' && advOpen
  const resolved = useMemo<Record<keyof ThemeTokens, string> | null>(
    () => (advancedOpen ? resolvedTokens() : null),
    [advancedOpen, settings.theme],
  )

  return (
    <div className="page set-page">
      <div className="set-layout">
        <div className="set-side">
          <div className="set-head">
            <h1 className="page-title">{t('Settings')}</h1>
            <div className="page-sub">{t('Personalize Tempo')}</div>
          </div>
          <nav className="set-nav">
            {NAV.map(({ id, key, Icon }) => (
              <button
                key={id}
                className={cat === id ? 'set-nav-item is-active' : 'set-nav-item'}
                onClick={() => setCat(id)}
              >
                <Icon size={16} />
                {t(key)}
              </button>
            ))}
          </nav>
        </div>

        <div className="set-content">
          {cat === 'general' ? (
            <>
              <Card title={t('Language')} desc={t('Interface language. System follows your OS setting.')}>
                <div className="set-row">
                  <span className="set-row-label">{t('Language')}</span>
                  <Segmented<'ru' | 'en' | 'system'>
                    value={settings.lang}
                    options={[
                      { value: 'system', label: t('System') },
                      { value: 'ru', label: 'Русский' },
                      { value: 'en', label: 'English' },
                    ]}
                    onChange={(lang) => update({ lang })}
                  />
                </div>
              </Card>
              <Card title={t('Startup')} desc={t('Choose what Tempo shows when it launches.')}>
                <div className="set-row">
                  <span className="set-row-label">{t('Startup page')}</span>
                  <select className="select" disabled value="home">
                    <option value="home">{t('Home')}</option>
                  </select>
                </div>
                <div className="set-note">{t('Tempo is offline-first: your library never leaves this machine.')}</div>
              </Card>
            </>
          ) : null}

          {cat === 'appearance' ? (
            <>
              <Card title={t('Theme')} desc={t('Pick a preset or build your own palette.')}>
                <div className="theme-grid">
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className={activeId === p.id ? 'theme-card is-active' : 'theme-card'}
                      onClick={() => setPreset(p.id)}
                    >
                      <ThemePreview tokens={p.tokens} />
                      <span className="theme-card-name">{p.name}</span>
                    </button>
                  ))}
                  <button
                    key="custom"
                    className={
                      settings.theme.kind === 'custom' ? 'theme-card theme-card-custom is-active' : 'theme-card theme-card-custom'
                    }
                    onClick={() => activateCustom()}
                  >
                    <div className="theme-preview">
                      <Plus size={20} />
                    </div>
                    <span className="theme-card-name">{t('Custom')}</span>
                  </button>
                </div>
              </Card>

              {settings.theme.kind === 'custom' ? (
                <Card title={t('Custom theme')} desc={t('Three colors drive the whole palette. Changes apply live.')}>
                  <div className="set-row">
                    <span className="set-row-label">{t('Accent')}</span>
                    <ColorField value={custom.base.accent} onChange={(accent) => updateCustom({ ...custom, base: { ...custom.base, accent } })} />
                  </div>
                  <div className="set-row">
                    <span className="set-row-label">{t('Background')}</span>
                    <ColorField value={custom.base.background} onChange={(background) => updateCustom({ ...custom, base: { ...custom.base, background } })} />
                  </div>
                  <div className="set-row">
                    <span className="set-row-label">{t('Surface')}</span>
                    <ColorField value={custom.base.surface} onChange={(surface) => updateCustom({ ...custom, base: { ...custom.base, surface } })} />
                  </div>
                  <div className="set-row">
                    <span className="set-row-label">{t('Play button')}</span>
                    <ColorField
                      value={custom.base.playButton}
                      onChange={(playButton) => updateCustom({ ...custom, base: { ...custom.base, playButton } })}
                    />
                  </div>

                  <button
                    className={advOpen ? 'adv-toggle is-open' : 'adv-toggle'}
                    onClick={() => setAdvOpen(!advOpen)}
                  >
                    <ChevronDown size={14} />
                    {t('Advanced')}
                  </button>

                  {advancedOpen ? (
                    <div className="tok-list">
                      {resolved === null
                        ? null
                        : TOKEN_KEYS.map((k) => {
                            const override = custom.overrides[k]
                            return (
                              <div key={k} className="tok-row">
                                <span className="tok-name">{t(TOKEN_LABELS[k])}</span>
                                <span className="tok-value">{override ?? (resolved[k] || '—')}</span>
                                <input
                                  type="color"
                                  className="swatch"
                                  value={asColorInput(override)}
                                  onChange={(e) =>
                                    updateCustom({
                                      ...custom,
                                      overrides: { ...custom.overrides, [k]: e.target.value },
                                    })
                                  }
                                />
                              </div>
                            )
                          })}
                      <div className="set-actions">
                        <button
                          className="btn"
                          disabled={Object.keys(custom.overrides).length === 0}
                          onClick={() => updateCustom({ ...custom, overrides: {} })}
                        >
                          <RotateCcw size={14} />
                          {t('Reset overrides')}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="set-actions">
                    <button className="btn btn-danger" onClick={() => resetAppearance()}>
                      <RotateCcw size={14} />
                      {t('Reset theme')}
                    </button>
                  </div>
                </Card>
              ) : null}

              <Card title={t('Font')} desc={t('Typeface, size and interface scale.')}>
                <div className="set-row">
                  <span className="set-row-label">{t('Source')}</span>
                  <Segmented<FontMode>
                    value={fontMode}
                    options={[
                      { value: 'default', label: t('Default') },
                      { value: 'system', label: t('System') },
                      { value: 'file', label: t('File') },
                    ]}
                    onChange={setFontMode}
                  />
                </div>

                {fontMode === 'system' ? (
                  <>
                    <div className="set-row">
                      <span className="set-row-label">{t('Installed fonts')}</span>
                      {fontData.fonts === null ? (
                        <span className="muted" style={{ fontSize: 12 }}>{t('Loading…')}</span>
                      ) : (
                        <FontListBox
                          fonts={fontData.fonts}
                          value={settings.font.family ?? FALLBACK_FONTS[0]}
                          onSelect={(f) => update({ font: { family: f } })}
                        />
                      )}
                    </div>
                    {fontData.fonts !== null && fontData.hidden > 0 ? (
                      <div className="muted font-hint">
                        {fontData.hidden} {t('fonts hidden — missing glyphs for the interface language')}
                      </div>
                    ) : null}
                    <div className="set-row">
                      <span className="set-row-label">{t('Custom CSS stack')}</span>
                      <input
                        className="text-input stack-input"
                        value={settings.font.family ?? ''}
                        placeholder="'JetBrains Mono', monospace"
                        onChange={(e) => update({ font: { family: e.target.value } })}
                      />
                    </div>
                  </>
                ) : null}

                {fontMode === 'file' ? (
                  <div className="set-row">
                    <span className="set-row-stack">
                      <span className="set-row-label">
                        {settings.font.importedPath
                          ? fileName(settings.font.importedPath)
                          : t('No font file imported')}
                      </span>
                    </span>
                    <button className="btn" disabled={fontBusy} onClick={() => void importFont()}>
                      <FolderOpen size={15} />
                      {t('Import font file')}
                    </button>
                  </div>
                ) : null}

                <div className="font-preview">
                  {t('The quick brown fox — Быстрая рыжая лиса 0123456789')}
                </div>

                <CommitSlider
                  label={t('Size')}
                  min={12}
                  max={18}
                  step={1}
                  value={settings.font.sizePx}
                  format={(v) => `${v}px`}
                  onCommit={(sizePx) => update({ font: { sizePx } })}
                />
                <CommitSlider
                  label={t('UI scale')}
                  min={80}
                  max={130}
                  step={5}
                  value={settings.font.uiScalePct}
                  format={(v) => `${v}%`}
                  onCommit={(uiScalePct) => update({ font: { uiScalePct } })}
                />
              </Card>

              <Card title={t('Background image')} desc={t('A picture behind the library view. Dim and blur it to taste.')}>
                <div className="set-row">
                  <span className="set-row-label">
                    {settings.background.path ? fileName(settings.background.path) : t('No image selected')}
                  </span>
                  <div className="btn-group">
                    <button className="btn" disabled={bgBusy} onClick={() => void importBackground()}>
                      <FolderOpen size={15} />
                      {t('Import image')}
                    </button>
                    <button
                      className="btn"
                      disabled={settings.background.path === null}
                      onClick={() => update({ background: { path: null } })}
                    >
                      {t('None')}
                    </button>
                  </div>
                </div>
                {settings.background.path ? (
                  <div
                    className="bg-thumb"
                    style={{ backgroundImage: `url("${convertFileSrc(settings.background.path)}")` }}
                  />
                ) : null}
                <SliderRow
                  label={t('Dim')}
                  min={0}
                  max={80}
                  step={1}
                  value={settings.background.dimPct}
                  display={`${settings.background.dimPct}%`}
                  onChange={(dimPct) => update({ background: { dimPct } })}
                />
                <SliderRow
                  label={t('Blur')}
                  min={0}
                  max={40}
                  step={1}
                  value={settings.background.blurPx}
                  display={`${settings.background.blurPx}px`}
                  onChange={(blurPx) => update({ background: { blurPx } })}
                />
              </Card>

              <Card title={t('Player')} desc={t('Playback visuals.')}>
                <div className="set-row">
                  <span className="set-row-label">{t('Waveform progress bar')}</span>
                  <button
                    className={settings.player.waveform ? 'switch is-on' : 'switch'}
                    role="switch"
                    aria-checked={settings.player.waveform}
                    aria-label={t('Waveform progress bar')}
                    onClick={() => update({ player: { waveform: !settings.player.waveform } })}
                  />
                </div>
              </Card>
            </>
          ) : null}

          {cat === 'library' ? (
            <>
              <Card title={t('Music folders')} desc={t('Folders scanned for audio files. Everything stays local.')}>
                {foldersApi.error ? <div className="error-line">{foldersApi.error}</div> : null}
                {foldersApi.loading ? (
                  <div className="muted" style={{ marginTop: 14, fontSize: 12.5 }}>{t('Loading…')}</div>
                ) : foldersApi.folders.length === 0 ? (
                  <div className="muted" style={{ marginTop: 14, fontSize: 12.5 }}>{t('No folders added yet.')}</div>
                ) : (
                  <div className="folder-list">
                    {foldersApi.folders.map((f) => (
                      <div key={f.id} className="folder-row">
                        <FolderOpen size={16} className="muted" />
                        <div className="folder-info">
                          <span className="folder-path" title={f.path}>
                            {f.path}
                          </span>
                          <span className="folder-count">
                            {f.trackCount ?? 0} {t('tracks')}
                          </span>
                        </div>
                        <button
                          className="icon-btn"
                          aria-label={t('Rescan') + ' ' + f.path}
                          disabled={scan.active}
                          onClick={() => void api.rescanFolder(f.id)}
                        >
                          <RefreshCw size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          aria-label={t('Remove') + ' ' + f.path}
                          onClick={() => void removeFolder(f.id, f.path)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="set-actions">
                  <button className="btn" onClick={() => void foldersApi.addFolder()} disabled={foldersApi.busy}>
                    <FolderPlus size={15} />
                    {t('Add folder')}
                  </button>
                </div>
              </Card>

              <Card title={t('Scanning')} desc={t('Runs in the background and updates tracks, albums and covers automatically.')}>
                <ScanLine />
                <div className="muted settings-line">
                  {foldersApi.folders.length}{' '}
                  {foldersApi.folders.length === 1 ? t('folder registered') : t('folders registered')}
                </div>
                <div className="set-actions">
                  <button className="btn" onClick={() => void api.rescanLibrary()} disabled={scan.active}>
                    <RefreshCw size={15} className={scan.active ? 'spin' : undefined} />
                    {t('Rescan library')}
                  </button>
                </div>
              </Card>
            </>
          ) : null}

          {cat === 'storage' ? <StorageCard /> : null}

          {cat === 'about' ? (
            <Card title={t('About')}>
              <div className="about-name">Tempo</div>
              <div className="muted settings-line">
                {t('Version 0.2.0 — a local-first desktop music player. Your library is scanned and stored entirely on this machine; Tempo works fully offline with no account required.')}
              </div>
              <div className="muted settings-line" style={{ marginTop: 8 }}>Tauri 2 · React 18 · TypeScript · SQLite</div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
