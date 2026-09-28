export type BackgroundImageProvider = 'wallhaven' | 'pinterest' | 'konachan'
export type BackgroundImageOrientation = 'landscape' | 'portrait' | 'square' | 'any'
export type BackgroundImageCategory = 'all' | 'anime' | 'general' | 'people'

export interface BackgroundProviderStatus {
  id: BackgroundImageProvider
  available: boolean
  supportsCategories: boolean
  supportsColor: boolean
  supportsNsfw: boolean
  notice: string | null
}

export interface BackgroundSearchFilters {
  minWidth: number
  minHeight: number
  orientation: BackgroundImageOrientation
  limit: number
  category: BackgroundImageCategory
  color: string | null
  includeNsfw: boolean
  page: number
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

export interface BackgroundSearchPage {
  images: BackgroundImageResult[]
  page: number
  hasMore: boolean
}
