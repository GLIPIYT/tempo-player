import { expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke, convertFileSrc: (path: string) => path }))

import { analysisNativeClient } from './nativeClient'

it('resolves a registered local row with no external ID and retains remote external IDs', async () => {
  const registered = { id: 42, source: 'local', externalId: null }
  const identity = { fingerprint: 'local-audio', absolutePath: 'C:/music/a.wav', fileSize: 640044,
    durationSec: 20, sampleRate: 16000, channels: 1 }
  invoke.mockImplementation(async (command, args) => {
    if (command !== 'lyrics_analysis_audio_identity') throw new Error(`Unexpected command: ${command}`)
    if (args.trackId === registered.id && args.source === registered.source && args.sourceId === registered.externalId) return identity
    if (args.trackId === registered.id) throw new Error('registered track source does not match')
    return null
  })

  await expect(analysisNativeClient.identity({ dbId: 42, source: 'local', sourceId: '42' })).resolves.toEqual(identity)
  expect(invoke).toHaveBeenLastCalledWith('lyrics_analysis_audio_identity',
    { trackId: 42, source: 'local', sourceId: null })

  await analysisNativeClient.identity({ dbId: 7, source: 'soundcloud', sourceId: 'sc-actual' })
  expect(invoke).toHaveBeenLastCalledWith('lyrics_analysis_audio_identity',
    { trackId: 7, source: 'soundcloud', sourceId: 'sc-actual' })
  await analysisNativeClient.identity({ dbId: 8, source: 'youtube', sourceId: 'abcdefghijk' })
  expect(invoke).toHaveBeenLastCalledWith('lyrics_analysis_audio_identity',
    { trackId: 8, source: 'youtube', sourceId: 'abcdefghijk' })
})
