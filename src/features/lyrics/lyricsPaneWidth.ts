const STORAGE_KEY = 'tempo.lyrics-pane-width.v1'
const DEFAULT_WIDTH = 40
const MIN_WIDTH = 25
const MAX_WIDTH = 65

function normalizeWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
}

export function readLyricsPaneWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === null || stored.trim() === '' ? DEFAULT_WIDTH : normalizeWidth(Number(stored))
  } catch {
    return DEFAULT_WIDTH
  }
}

export function writeLyricsPaneWidth(value: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, String(normalizeWidth(value)))
  } catch {
    // Keep resizing usable when storage is unavailable.
  }
}

export function lyricsPaneWidthAtPointer(clientX: number, left: number, screenWidth: number, layoutWidth: number): number {
  if (layoutWidth <= 24 || screenWidth <= 0) return DEFAULT_WIDTH
  const dividerWidth = 24 * screenWidth / layoutWidth
  return normalizeWidth((clientX - left - dividerWidth / 2) / (screenWidth - dividerWidth) * 100)
}
