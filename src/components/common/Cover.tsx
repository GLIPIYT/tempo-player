import { useEffect, useState, type CSSProperties } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'

interface CoverProps {
  path?: string | null
  label: string
  size?: number
  rounded?: boolean
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

export default function Cover({ path, label, size = 48, rounded = false }: CoverProps) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [path])

  const radius = rounded ? '9999px' : 'var(--radius-sm)'
  const base: CSSProperties = { width: size, height: size, borderRadius: radius }

  if (path && !failed) {
    return (
      <img
        className="cover"
        src={srcFor(path)}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        style={base}
      />
    )
  }

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
