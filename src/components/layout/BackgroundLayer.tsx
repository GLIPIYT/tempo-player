import { convertFileSrc } from '@tauri-apps/api/core'
import { useSettings } from '../../state/settings'

export default function BackgroundLayer() {
  const { settings } = useSettings()
  const bg = settings.background
  if (bg.path === null) return null
  return (
    <div className="bg-layer" aria-hidden="true">
      <div
        className="bg-layer-img"
        style={{
          backgroundImage: `url("${convertFileSrc(bg.path)}")`,
          filter: bg.blurPx > 0 ? `blur(${bg.blurPx}px)` : undefined,
        }}
      />
      <div className="bg-layer-dim" style={{ opacity: bg.dimPct / 100 }} />
    </div>
  )
}
