import { localProvider } from './localProvider'
import { soundcloudProvider } from './soundcloudProvider'
import type { MusicProvider } from './provider'

export function getProviders(): MusicProvider[] {
  return [localProvider, soundcloudProvider]
}

export function getProvider(id: string): MusicProvider | undefined {
  return getProviders().find(p => p.id === id)
}
