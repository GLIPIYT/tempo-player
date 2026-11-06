import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedTrack } from '../types/models'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  isTauri: () => true,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('../components/common/Toast', () => ({ toast: { show: vi.fn() } }))
vi.mock('../features/lyrics/lyricsService', () => ({ lyricsService: { ensure: vi.fn(), invalidate: vi.fn() } }))
vi.mock('../features/recommendations/service', () => ({
  recommendationService: { takeForAutoplay: vi.fn(), prepareExit: vi.fn(async () => {}) },
}))
vi.mock('../state/settings', () => ({ getSettings: vi.fn(), loadSettings: vi.fn() }))
vi.mock('../utils/unified', () => ({ trackToUnified: vi.fn() }))

import { NativePlayerController } from './nativeController'
import type { PlayerSnapshot } from './controller'
import type { TrackChangeEvent } from './types'

type NativeSnapshot = PlayerSnapshot & {
  initialized: boolean
  trackChange?: TrackChangeEvent
}

type NativeClock = {
  position: number
  duration: number
  isPlaying: boolean
  buffering: boolean
  version: number
}

type NativeControllerTestAccess = {
  applySnapshot(payload: NativeSnapshot): void
  applyClock(payload: NativeClock): void
}

function track(sourceId: string): UnifiedTrack {
  return {
    source: 'local',
    sourceId,
    dbId: null,
    title: sourceId,
    artists: ['Artist'],
    album: null,
    durationSec: 180,
    coverPath: null,
    playable: true,
    localPath: `C:/music/${sourceId}.mp3`,
    externalUrl: null,
    gainDb: null,
  }
}

function snapshot(
  currentTrack: UnifiedTrack,
  version: number,
  options: Partial<NativeSnapshot> = {},
): NativeSnapshot {
  return {
    currentTrack,
    queue: [currentTrack],
    queueIndex: 0,
    isPlaying: true,
    position: 0,
    duration: 180,
    volume: 0.8,
    playbackRate: 1,
    preservePitch: true,
    repeat: 'off',
    shuffle: false,
    bufferPct: null,
    preparing: false,
    version,
    initialized: true,
    ...options,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('native player clock and track transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listen.mockResolvedValue(() => {})
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'native_audio_snapshot') {
        return snapshot(track('first'), 1, {
          trackChange: { trackKey: 'local:first', reason: 'natural-end', transitionId: 4 },
        })
      }
      return undefined
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not replay the initial transition, and publishes a preparing-to-ready track once', async () => {
    const controller = new NativePlayerController()
    await flush()
    const events: TrackChangeEvent[] = []
    controller.subscribeTrackChange(event => events.push(event))
    const access = controller as unknown as NativeControllerTestAccess

    access.applySnapshot(snapshot(track('second'), 2, { preparing: true }))
    access.applySnapshot(snapshot(track('second'), 3, {
      trackChange: { trackKey: 'local:second', reason: 'natural-end', transitionId: 5 },
    }))
    access.applySnapshot(snapshot(track('second'), 4, {
      trackChange: { trackKey: 'local:second', reason: 'natural-end', transitionId: 5 },
    }))
    access.applyClock({ position: 96, duration: 180, isPlaying: true, buffering: false, version: 2 })

    expect(events).toEqual([{ trackKey: 'local:second', reason: 'natural-end', transitionId: 5 }])
    expect(controller.getSnapshot()).toMatchObject({
      currentTrack: expect.objectContaining({ sourceId: 'second' }),
      position: 0,
    })
  })

  it('ignores an older clock after a newer sequential seek clock', async () => {
    const controller = new NativePlayerController()
    await flush()
    const access = controller as unknown as NativeControllerTestAccess

    access.applyClock({ position: 30, duration: 180, isPlaying: true, buffering: false, version: 3 })
    access.applyClock({ position: 72, duration: 180, isPlaying: true, buffering: false, version: 5 })
    access.applyClock({ position: 41, duration: 180, isPlaying: true, buffering: false, version: 4 })

    expect(controller.getSnapshot().position).toBe(72)
    expect(controller.getDisplayPosition()).toBeGreaterThanOrEqual(72)
  })

  it('keeps an optimistic seek visible until the native clock confirms it', async () => {
    const controller = new NativePlayerController()
    await flush()
    const access = controller as unknown as NativeControllerTestAccess

    controller.seek(52)
    expect(controller.getDisplayPosition()).toBeCloseTo(52, 0)
    await flush()

    access.applyClock({ position: 18, duration: 180, isPlaying: true, buffering: false, version: 2 })
    expect(controller.getSnapshot().position).toBe(52)
    expect(controller.getDisplayPosition()).toBeGreaterThanOrEqual(52)

    access.applySnapshot(snapshot(track('first'), 3, { position: 52 }))
    expect(controller.getSnapshot().position).toBe(52)
  })

  it('holds the latest pending seek steady and restores the original clock on rejection', async () => {
    const controller = new NativePlayerController()
    await flush()
    const access = controller as unknown as NativeControllerTestAccess
    access.applySnapshot(snapshot(track('first'), 2, { position: 12, isPlaying: false }))
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'native_audio_command') throw new Error('Seek unavailable')
      return snapshot(track('first'), 2, { position: 12, isPlaying: false })
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    controller.seek(30)
    controller.seek(70)
    expect(controller.getDisplayPosition()).toBe(70)
    access.applyClock({ position: 13, duration: 180, isPlaying: false, buffering: false, version: 3 })
    expect(controller.getDisplayPosition()).toBe(70)
    await flush()
    expect(controller.getDisplayPosition()).toBe(12)
  })

  it('coalesces queued seeks to the latest position', async () => {
    const controller = new NativePlayerController()
    await flush()
    const firstSeekGate: { release?: () => void } = {}
    mocks.invoke.mockImplementation(async (command: string, args?: { command?: { op?: string; position?: number } }) => {
      if (command === 'native_audio_snapshot') return snapshot(track('first'), 1)
      if (command === 'native_audio_command' && args?.command?.op === 'seek' && args.command.position === 20) {
        await new Promise<void>(resolve => { firstSeekGate.release = resolve })
      }
      return undefined
    })

    controller.seek(20)
    await flush()
    controller.seek(30)
    controller.seek(40)
    firstSeekGate.release?.()
    await flush()

    const seeks = mocks.invoke.mock.calls
      .filter(([name, args]) => name === 'native_audio_command' && (args as { command?: { op?: string } }).command?.op === 'seek')
      .map(([, args]) => (args as { command: { position: number } }).command.position)
    expect(seeks).toEqual([20, 40])
  })
})
