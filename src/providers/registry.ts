import { localProvider } from './localProvider'
import { soundcloudProvider } from './soundcloudProvider'
import { youtubeProvider } from './youtubeProvider'
import type { MusicProvider } from './provider'

export function getProviders(): MusicProvider[] {
  return [localProvider, soundcloudProvider, youtubeProvider]
}

export function getProvider(id: string): MusicProvider | undefined {
  return getProviders().find(p => p.id === id)
}
