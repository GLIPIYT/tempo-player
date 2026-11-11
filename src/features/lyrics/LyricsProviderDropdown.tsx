import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, Pin, RotateCcw, Search } from 'lucide-react'
import { normalizeSearchText } from '../../utils/searchText'
import { fmtTime } from '../../utils/format'
import { useT } from '../../i18n'
import type { LyricsCandidate } from './onlineProvider'

type OverlayCandidate = LyricsCandidate & { displayLabel?: string }
export function providerLabel(provider: string, t: (k: string) => string): string {
  if (provider === 'embedded') return t('Embedded')
  if (provider === 'online') return t('Online lyrics')
  if (provider === 'lrclib') return 'LRCLib'
  if (provider === 'textyl') return 'Textyl'
  if (provider === 'musixmatch') return 'Musixmatch'
  if (provider === 'lyrics.ovh' || provider === 'lyrics_ovh') return 'lyrics.ovh'
  if (provider === 'genius') return 'Genius'
  return provider
}

export default function LyricsProviderDropdown({
  candidates,
  selectedIndex,
  onSelect,
  onReset,
  pinnedIndex,
  canPin,
}: {
  candidates: LyricsCandidate[]
  selectedIndex: number
  onSelect: (idx: number) => void
  onReset: () => void
  /** index of the candidate that is pinned, or -1 */
  pinnedIndex: number
  canPin: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [versionQuery, setVersionQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const selected = candidates[selectedIndex] ?? (selectedIndex >= 0 ? candidates[0] : null)
  const isSyncedSelected = selected ? Boolean(selected.syncedLrc) || selected.result.kind === 'synced' : false
  const providerGroups = useMemo(() => {
    const groups = new Map<string, { key: string; provider: string; displayLabel?: string; indices: number[] }>()
    candidates.forEach((candidate, index) => {
      const displayLabel = (candidate as OverlayCandidate).displayLabel
      const key = displayLabel ? `display:${index}` : candidate.provider
      const group = groups.get(key) ?? { key, provider: candidate.provider, displayLabel, indices: [] }
      group.indices.push(index)
      groups.set(key, group)
    })
    return Array.from(groups.values())
  }, [candidates])
  const activeGroup = providerGroups.find((group) => group.key === activeProvider && group.indices.length > 1)
  const matchingVersionIndices = useMemo(() => {
    if (!activeGroup) return []
    const query = normalizeSearchText(versionQuery.trim())
    if (!query) return activeGroup.indices
    return activeGroup.indices.filter((index) => {
      const candidate = candidates[index]
      if (!candidate) return false
      return [candidate.trackName, candidate.artistName, candidate.albumName, candidate.duration, candidate.id]
        .some((value) => normalizeSearchText(String(value ?? '')).includes(query))
    })
  }, [activeGroup, candidates, versionQuery])

  const closeDropdown = useCallback(() => {
    setOpen(false)
    setActiveProvider(null)
    setVersionQuery('')
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closeDropdown()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeDropdown()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, closeDropdown])

  if (!selected && candidates.length === 0) return null

  const renderCandidate = (index: number) => {
    const candidate = candidates[index]
    if (!candidate) return null
    const displayLabel = (candidate as OverlayCandidate).displayLabel
    const isSelected = index === selectedIndex
    const isSynced = Boolean(candidate.syncedLrc) || candidate.result.kind === 'synced'
    const metadata = [
      candidate.artistName,
      candidate.albumName,
      candidate.duration != null ? fmtTime(candidate.duration) : null,
      candidate.instrumental ? t('Instrumental') : null,
    ]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(' · ')
    return (
      <button
        key={`${candidate.provider}-${index}`}
        role="menuitemradio"
        aria-checked={isSelected}
        className={'lyr-prov-item' + (isSelected ? ' is-selected' : '')}
        onClick={() => {
          onSelect(index)
          closeDropdown()
        }}
      >
        <span className="lyr-prov-item-main">
          <span className="lyr-prov-item-heading">
            <span className="lyr-prov-item-name" title={displayLabel ?? candidate.trackName?.trim()}>
              {(displayLabel ?? candidate.trackName?.trim()) || providerLabel(candidate.provider, t)}
            </span>
            <span className={'lyr-prov-badge' + (isSynced ? ' is-synced' : ' is-plain')}>
              {isSynced ? t('SYNCED') : t('TEXT')}
            </span>
            {index === pinnedIndex && <Pin size={12} className="lyr-prov-item-pin" />}
          </span>
          {metadata && <span className="lyr-prov-item-meta" title={metadata}>{metadata}</span>}
        </span>
        {isSelected && <Check size={14} className="lyr-prov-item-check" />}
      </button>
    )
  }

  return (
    <div className="lyr-prov-dropdown" ref={wrapRef}>
      <button
        className="lyr-prov-trigger"
        onClick={() => {
          if (open) closeDropdown()
          else setOpen(true)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="lyr-prov-trigger-name">
          {selected
            ? (selected as OverlayCandidate).displayLabel ?? providerLabel(selected.provider, t)
            : t('Auto (reset)')}
        </span>
        {selected && (
          <span className={'lyr-prov-badge' + (isSyncedSelected ? ' is-synced' : ' is-plain')}>
            {isSyncedSelected ? t('SYNCED') : t('TEXT')}
          </span>
        )}
        <ChevronDown size={14} className={'lyr-prov-chevron' + (open ? ' is-open' : '')} />
      </button>
      {open && (
        <div className="lyr-prov-panels">
          <div className="lyr-prov-menu" role="menu" aria-label={t('Lyrics sources')}>
            {/* Selecting a row pins it, so the way back to automatic lyrics has to be
                a row of its own. Shown only when pinning is possible at all. */}
            {canPin && (
              <button
                role="menuitemradio"
                aria-checked={pinnedIndex < 0}
                className={'lyr-prov-item lyr-prov-item-auto' + (pinnedIndex < 0 ? ' is-selected' : '')}
                onClick={() => {
                  onReset()
                  closeDropdown()
                }}
              >
                <span className="lyr-prov-item-main">
                  <RotateCcw size={13} className="lyr-prov-item-glyph" />
                  <span className="lyr-prov-item-name">{t('Auto (reset)')}</span>
                </span>
                {pinnedIndex < 0 && <Check size={14} className="lyr-prov-item-check" />}
              </button>
            )}
            {providerGroups.map((group) => {
              const hasVariants = group.indices.length > 1
              const isSelected = group.indices.includes(selectedIndex)
              const isActive = activeProvider === group.key
              const onlyCandidate = candidates[group.indices[0]]
              const isSynced = onlyCandidate
                ? Boolean(onlyCandidate.syncedLrc) || onlyCandidate.result.kind === 'synced'
                : false
              return (
                <button
                  key={group.key}
                  role={hasVariants ? 'menuitem' : 'menuitemradio'}
                  aria-checked={hasVariants ? undefined : isSelected}
                  aria-haspopup={hasVariants ? 'menu' : undefined}
                  aria-expanded={hasVariants ? isActive : undefined}
                  className={'lyr-prov-item lyr-prov-provider-row' + (isSelected ? ' is-selected' : '') + (isActive ? ' is-active' : '')}
                  onClick={() => {
                    if (hasVariants) {
                      setVersionQuery('')
                      setActiveProvider((current) => current === group.key ? null : group.key)
                    }
                    else {
                      onSelect(group.indices[0])
                      closeDropdown()
                    }
                  }}
                >
                  <span className="lyr-prov-item-main">
                    <span className="lyr-prov-item-heading">
                      <span className="lyr-prov-item-name">
                        {group.displayLabel ?? providerLabel(group.provider, t)}
                      </span>
                      {!hasVariants && (
                        <span className={'lyr-prov-badge' + (isSynced ? ' is-synced' : ' is-plain')}>
                          {isSynced ? t('SYNCED') : t('TEXT')}
                        </span>
                      )}
                    </span>
                  </span>
                  {hasVariants ? (
                    <>
                      <span className="lyr-prov-count">{group.indices.length}</span>
                      <ChevronLeft size={14} className="lyr-prov-submenu-chevron" aria-hidden="true" />
                    </>
                  ) : isSelected ? <Check size={14} className="lyr-prov-item-check" /> : null}
                </button>
              )
            })}
          </div>
          {activeGroup && (
            <div className="lyr-prov-versions" role="menu" aria-label={activeGroup.displayLabel ?? providerLabel(activeGroup.provider, t)}>
              <div className="lyr-prov-versions-heading">
                {activeGroup.displayLabel ?? providerLabel(activeGroup.provider, t)}
              </div>
              {activeGroup.indices.length > 5 ? (
                <label className="lyr-prov-version-search">
                  <Search size={13} aria-hidden="true" />
                  <input
                    autoFocus
                    value={versionQuery}
                    onChange={(event) => setVersionQuery(event.target.value)}
                    placeholder={t('Search')}
                    aria-label={t('Search')}
                  />
                </label>
              ) : null}
              {matchingVersionIndices.length > 0
                ? matchingVersionIndices.map(renderCandidate)
                : <span className="lyr-prov-empty">{t('No matches')}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
