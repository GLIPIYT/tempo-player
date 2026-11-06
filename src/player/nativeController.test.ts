import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UnifiedTrack } from '../types/models'
import WaveProgress from '../components/common/WaveProgress'
import { useDisplayPosition } from './useDisplayPosition'

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
vi.mock('../state/settings', () => ({ getSettings: vi.fn(), loadSettings: vi.fn(), useSettings: vi.fn() }))
vi.mock('../utils/unified', () => ({ trackToUnified: vi.fn() }))

import { NativePlayerController } from './nativeController'
import type { PlayerSnapshot } from './controller'
import type { TrackChangeEvent } from './types'

type NativeSnapshot = PlayerSnapshot & {
  initialized: boolean
  seekPending?: boolean
  error?: string | null
  trackChange?: TrackChangeEvent
}

type NativeClock = {
  position: number
  duration: number
  isPlaying: boolean
  buffering: boolean
  version: number
  seekPending?: boolean
}

type NativeControllerTestAccess = {
  applySnapshot(payload: NativeSnapshot): void
  applyClock(payload: NativeClock): void
}

type NativeControllerGlobal = typeof globalThis & { __tempoNativePlayerController?: NativePlayerController }

function VisibleNativeProgress({ player }: {
  player: { position: number; isPlaying: boolean; preparing: boolean; currentTrack: UnifiedTrack | null }
}) {
  const position = useDisplayPosition(player)
  return createElement(WaveProgress, {
    position,
    duration: 180,
    seed: 'visible-seek-regression',
    soundCloudTrackId: null,
    waveformEnabled: true,
    onSeek: () => {},
  })
}

function visibleProgressRightInset(controller: NativePlayerController, player: {
  position: number
  isPlaying: boolean
  preparing: boolean
  currentTrack: UnifiedTrack | null
}): number {
  ;(globalThis as NativeControllerGlobal).__tempoNativePlayerController = controller
  const markup = renderToStaticMarkup(createElement(VisibleNativeProgress, { player }))
  const inset = markup.match(/clip-path:inset\(0 ([\d.]+)% 0 0\)/)?.[1]
  if (inset === undefined) throw new Error(`WaveProgress did not render its progress clip: ${markup}`)
  return Number(inset)
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
    vi.unstubAllGlobals()
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

  it('does not render the old waveform position when a native optimistic clock is followed by the stale decoder clock', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, setInterval, clearInterval })
    const controller = new NativePlayerController()
    await flush()
    const access = controller as unknown as NativeControllerTestAccess
    const currentTrack = track('first')
    const player = { position: 12, isPlaying: true, preparing: false, currentTrack }
    access.applySnapshot(snapshot(currentTrack, 2, { position: 12 }))

    controller.seek(54)
    await flush()
    access.applyClock({ position: 54, duration: 180, isPlaying: true, buffering: false, version: 3, seekPending: true })
    expect(visibleProgressRightInset(controller, { ...player, position: controller.getSnapshot().position })).toBeCloseTo(70, 3)

    // The native clock can first echo the target optimistically, then report
    // the decoder's old time while a rejected seek is being recovered.
    access.applyClock({ position: 12, duration: 180, isPlaying: true, buffering: false, version: 4, seekPending: false })
    const insetDuringRecovery = visibleProgressRightInset(controller, {
      ...player,
      position: controller.getSnapshot().position,
      preparing: controller.getSnapshot().preparing,
    })
    expect(insetDuringRecovery).toBeCloseTo(70, 3)

    access.applySnapshot(snapshot(currentTrack, 5, { position: 54, preparing: true, seekPending: true }))
    access.applySnapshot(snapshot(currentTrack, 6, { position: 54, seekPending: false }))
    expect(visibleProgressRightInset(controller, { ...player, position: controller.getSnapshot().position })).toBeCloseTo(70, 3)
    delete (globalThis as NativeControllerGlobal).__tempoNativePlayerController
  })

  it('restores the prior waveform position after a terminal seek error', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, setInterval, clearInterval })
    const controller = new NativePlayerController()
    await flush()
    const access = controller as unknown as NativeControllerTestAccess
    const currentTrack = track('first')
    const player = { position: 12, isPlaying: false, preparing: false, currentTrack }
    access.applySnapshot(snapshot(currentTrack, 2, { position: 12, isPlaying: false }))

    controller.seek(54)
    await flush()
    expect(visibleProgressRightInset(controller, { ...player, position: controller.getSnapshot().position })).toBeCloseTo(70, 3)

    access.applySnapshot(snapshot(currentTrack, 3, {
      position: 12,
      isPlaying: false,
      error: 'The active audio source rejected a seek request',
      seekPending: false,
    }))
    expect(controller.getSnapshot().position).toBe(12)
    expect(visibleProgressRightInset(controller, { ...player, position: controller.getSnapshot().position })).toBeCloseTo(93.333, 2)
    delete (globalThis as NativeControllerGlobal).__tempoNativePlayerController
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
