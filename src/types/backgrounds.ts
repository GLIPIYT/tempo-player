export type BackgroundImageProvider = 'commons' | 'artic'
export type BackgroundImageOrientation = 'landscape' | 'portrait' | 'square' | 'any'

export interface BackgroundSearchFilters {
  minWidth: number
  minHeight: number
  orientation: BackgroundImageOrientation
  limit: number
}

export interface BackgroundImageResult {
  id: string
  provider: BackgroundImageProvider
  title: string
  previewUrl: string
  imageUrl: string
  sourceUrl: string
  author: string | null
  license: string | null
  licenseUrl: string | null
  width: number
  height: number
}
