import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { ChevronDown, FolderOpen } from 'lucide-react'
import { api } from '../../api/client'
import { resolveLang, useT } from '../../i18n'
import { useSettings } from '../../state/settings'
import { CommitSlider, Segmented } from './SettingsControls'

type FontMode = 'default' | 'system' | 'file'
type GlyphScript = 'latin' | 'cyrillic'

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
const fallbackWidths = new Map<GlyphScript, number>()
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
    let fallbackOnly = fallbackWidths.get(script)
    if (fallbackOnly === undefined) {
      fallbackOnly = measureProbe('16px monospace', probe)
      fallbackWidths.set(script, fallbackOnly)
    }
    if (Number.isFinite(withFamily) && Number.isFinite(fallbackOnly) && fallbackOnly > 0) {
      ok = Math.abs(withFamily - fallbackOnly) > 0.5
    }
  }
  coverageCache.set(key, ok)
  return ok
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
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

export default function FontSettings() {
  const { settings, update } = useSettings()
  const t = useT()
  const [sysFonts, setSysFonts] = useState<string[] | null>(() => localFontsCache)
  const [fontBusy, setFontBusy] = useState(false)

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
    if (fontMode !== 'system' || sysFonts === null) return { fonts: null, hidden: 0 }
    const script: GlyphScript = needCyrillic ? 'cyrillic' : 'latin'
    const kept = sysFonts.filter((f) => supportsGlyphs(f, script))
    const hidden = sysFonts.length - kept.length
    const current = settings.font.family
    const list = current !== null && !kept.includes(current) ? [current, ...kept] : kept
    return { fonts: list.length > 0 ? list : FALLBACK_FONTS, hidden }
  }, [fontMode, sysFonts, needCyrillic, settings.font.family])

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

  return (
    <>
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
      <div className="font-preview" style={{ fontSize: settings.font.sizePx }}>
        Аа Бб Вв Aa Bb Cc 0123456789
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
    </>
  )
}
