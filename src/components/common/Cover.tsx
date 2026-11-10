import { useEffect, useState, type CSSProperties } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { buildCoverSources, coverSourceRetryDelay, nextCoverSourceRetry, type CoverSourceRetry } from './coverSources'
import { firstAvailableArtwork } from './artworkFallback'

interface CoverProps {
  path?: string | null
  label: string
  size?: number
  rounded?: boolean
  loading?: 'eager' | 'lazy'
  /** Try the provider's original image first when the URL can be safely upgraded. */
  preferOriginal?: boolean
}

function srcFor(path: string): string {
  return /^https?:\/\//.test(path) ? path : convertFileSrc(path)
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).slice(0, 2)
  const chars = parts.map((p) => p.charAt(0).toUpperCase()).join('')
  return chars.length > 0 ? chars : '?'
}

function hueFor(label: string): number {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 360
  return h
}

export default function Cover({ path, label, size = 48, rounded = false, loading = 'lazy', preferOriginal = false }: CoverProps) {
  const sources = buildCoverSources(path, preferOriginal)
  const radius = rounded ? '9999px' : 'var(--radius-sm)'
  const base: CSSProperties = { width: size, height: size, borderRadius: radius }

  if (sources.length > 0) {
    return (
      <CoverImage
        key={JSON.stringify(sources)}
        sources={sources}
        label={label}
        size={size}
        loading={loading}
        base={base}
      />
    )
  }

  return <CoverFallback label={label} size={size} base={base} />
}

function CoverImage({ sources, label, size, loading, base }: {
  sources: string[]
  label: string
  size: number
  loading: 'eager' | 'lazy'
  base: CSSProperties
}) {
  const [failedSources, setFailedSources] = useState<string[]>([])
  const [retry, setRetry] = useState<(CoverSourceRetry & { pending: boolean }) | null>(null)
  const source = firstAvailableArtwork(sources, failedSources)
  const retryAttempt = source && retry?.source === source
    ? retry.attempt - Number(retry.pending)
    : 0

  useEffect(() => {
    if (!retry?.pending || retry.source !== source) return
    const timeout = window.setTimeout(() => {
      setRetry(current => current?.source === retry.source && current.attempt === retry.attempt
        ? { ...current, pending: false }
        : current)
    }, coverSourceRetryDelay(retry.attempt))
    return () => window.clearTimeout(timeout)
  }, [retry, source])

  if (source) {
    return (
      <img
        className="cover"
        key={`${source}:${retryAttempt}`}
        src={srcFor(source)}
        alt=""
        loading={loading}
        decoding="async"
        draggable={false}
        onError={() => {
          const nextRetry = nextCoverSourceRetry(source, retry)
          if (nextRetry) setRetry({ ...nextRetry, pending: true })
          else setFailedSources(failed => [...new Set([...failed, source])])
        }}
        style={base}
      />
    )
  }

  return <CoverFallback label={label} size={size} base={base} />
}

function CoverFallback({ label, size, base }: { label: string; size: number; base: CSSProperties }) {
  const h = hueFor(label)
  return (
    <div
      className="cover cover-fallback"
      style={{
        ...base,
        fontSize: Math.max(11, Math.round(size * 0.34)),
        background: `linear-gradient(135deg, hsl(${h} 32% 24%), hsl(${(h + 46) % 360} 30% 16%))`,
      }}
    >
      {initialsOf(label)}
    </div>
  )
}
