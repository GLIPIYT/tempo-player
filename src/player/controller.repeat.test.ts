import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  api: {
    scGetPlayback: vi.fn(),
    upsertScTrack: vi.fn(),
    bumpPlayCount: vi.fn(),
    getRecommendationContext: vi.fn(),
    recordListeningSession: vi.fn(),
    completeListeningExit: vi.fn(),
    scPrecache: vi.fn(),
  },
  engines: [] as unknown[],
  cacheReadyHandler: null as ((sourceId: string) => void) | null,
}))

vi.mock('./engine', () => ({
  AudioEngine: class MockAudioEngine {
    activeChannel: 'local' | 'stream' = 'local'
    onEnded: () => void | Promise<void> = () => {}
    onFadeComplete: () => void = () => {}
    onPlaybackSample: () => void = () => {}
    onMediaFinished: () => void = () => {}
    onTime: () => void = () => {}
    onLoaded: () => void = () => {}
    onProgress: () => void = () => {}
    replay = vi.fn((_sessionId: string) => false)
    loadWithFormat = vi.fn(async (_url: string, _format: string | null, channel: 'local' | 'stream') => {
      this.activeChannel = channel
    })
    replaceStreamWithCachedFile = vi.fn(async (_url: string) => {
      this.activeChannel = 'local'
      return true
    })
    stop = vi.fn()
    samplePlayback = vi.fn()
    play = vi.fn()
    pause = vi.fn()
    setPlaybackRate = vi.fn()
    setPreservePitch = vi.fn()
    setEqualizer = vi.fn()
    setVolume = vi.fn()
    setTrackGain = vi.fn()
    resetBuffer = vi.fn()
    getCurrentTime = vi.fn(() => 0)
    getActiveChannel = () => this.activeChannel

    constructor() {
      mocks.engines.push(this)
    }
  },
}))

vi.mock('../api/client', () => ({ api: mocks.api }))
vi.mock('../api/events', () => ({
  onSoundcloudCacheReady: (handler: (sourceId: string) => void) => {
    mocks.cacheReadyHandler = handler
    return Promise.resolve(() => {})
  },
}))
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset://${path}` }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('../state/settings', () => ({
  getSettings: () => ({ audio: { equalizer: {} }, ytdlp: { path: '' }, lang: 'en', lyrics: { cacheOnline: false } }),
}))
vi.mock('../components/common/Toast', () => ({ toast: { show: vi.fn() } }))
vi.mock('../utils/libraryVersion', () => ({ bumpLibraryVersion: vi.fn() }))
vi.mock('../features/lyrics/lyricsService', () => ({ lyricsService: { ensure: vi.fn(), invalidate: vi.fn() } }))
vi.mock('../features/recommendations/service', () => ({
  recommendationService: {
    takeForAutoplay: vi.fn(async () => null),
    getPlayableAlternates: vi.fn(() => []),
    prepareExit: vi.fn(async () => {}),
  },
}))

type TestEngine = {
  activeChannel: 'local' | 'stream'
  onEnded: () => void | Promise<void>
  replay: ReturnType<typeof vi.fn>
  loadWithFormat: ReturnType<typeof vi.fn>
  replaceStreamWithCachedFile: ReturnType<typeof vi.fn>
}

type ControllerClass = typeof import('./controller').PlayerController

const localStorageStub = (() => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
})()

function searchTrack(id: string) {
  return {
    source: 'soundcloud' as const,
    sourceId: id,
    dbId: null,
    title: `Search result ${id}`,
    artists: ['Artist'],
    album: null,
    durationSec: 180,
    coverPath: null,
    playable: true,
    localPath: null,
    externalUrl: `https://soundcloud.com/artist/${id}`,
    gainDb: null,
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

describe('SoundCloud Search repeat-one', () => {
  let PlayerController: ControllerClass

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.engines.length = 0
    mocks.cacheReadyHandler = null
    localStorageStub.clear()
    mocks.api.getRecommendationContext.mockResolvedValue({ generation: 1 })
    mocks.api.scGetPlayback.mockReset()
    mocks.api.upsertScTrack.mockResolvedValue(7)
    mocks.api.bumpPlayCount.mockResolvedValue(undefined)
    mocks.api.recordListeningSession.mockResolvedValue(undefined)
    mocks.api.completeListeningExit.mockResolvedValue(undefined)
    mocks.api.scPrecache.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      localStorage: localStorageStub,
      addEventListener: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    })
    vi.stubGlobal('localStorage', localStorageStub)
    vi.stubGlobal('navigator', { language: 'en' })
    ;({ PlayerController } = await import('./controller'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('repeats a loaded search source when SoundCloud cannot resolve it again', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    mocks.api.scGetPlayback
      .mockResolvedValueOnce({ url: 'https://media.example/temporary.m3u8', cachedPath: null, format: 'hls' })
      .mockResolvedValueOnce({ url: null, cachedPath: null, format: null })
    const controller = new PlayerController()
    const engine = (mocks.engines.at(-1) as TestEngine)
    engine.replay.mockReturnValue(true)
    controller.setRepeat('one')
    controller.playTracks([searchTrack('offline-repeat-1'), searchTrack('offline-repeat-2')], 1)
    await flushMicrotasks()

    expect(engine.loadWithFormat).toHaveBeenCalledTimes(1)
    expect(mocks.api.scGetPlayback).toHaveBeenCalledTimes(1)
    now.mockReturnValue(131_001)
    await engine.onEnded()
    await flushMicrotasks()

    const activeSessionId = (controller as unknown as { activeSessionId: string | null }).activeSessionId
    expect(engine.replay).toHaveBeenCalledTimes(1)
    expect(engine.replay).toHaveBeenCalledWith(activeSessionId)
    expect(activeSessionId).toEqual(expect.any(String))
    expect(mocks.api.scGetPlayback).toHaveBeenCalledTimes(1)
    expect(engine.loadWithFormat).toHaveBeenCalledTimes(1)
    expect(mocks.api.bumpPlayCount).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({
      currentTrack: expect.objectContaining({ sourceId: 'offline-repeat-2' }),
      isPlaying: true,
      position: 0,
      repeat: 'one',
    })
  })

  it('reissues an HLS SoundCloud search result after the controller receives ended', async () => {
    mocks.api.scGetPlayback.mockResolvedValue({
      url: 'https://media.example/track.m3u8',
      cachedPath: null,
      format: 'hls',
    })
    const controller = new PlayerController()
    const engine = (mocks.engines.at(-1) as TestEngine)
    controller.setRepeat('one')
    controller.playTracks([searchTrack('hls-repeat-1'), searchTrack('hls-repeat-2')], 1)
    await flushMicrotasks()

    expect(engine.loadWithFormat).toHaveBeenCalledTimes(1)
    await engine.onEnded()
    await flushMicrotasks()

    expect(engine.loadWithFormat).toHaveBeenCalledTimes(2)
    expect(engine.loadWithFormat).toHaveBeenLastCalledWith(
      'https://media.example/track.m3u8',
      'hls',
      'local',
      expect.any(String),
    )
    expect(controller.getSnapshot().currentTrack?.sourceId).toBe('hls-repeat-2')
  })

  it('does not leave a preparation indicator when a repeat resolution is superseded', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(200_000)
    let resolveRepeat!: (value: { url: null; cachedPath: null; format: null }) => void
    mocks.api.scGetPlayback
      .mockResolvedValueOnce({ url: 'https://media.example/old.m3u8', cachedPath: null, format: 'hls' })
      .mockImplementationOnce(() => new Promise(resolve => { resolveRepeat = resolve }))
    const controller = new PlayerController()
    const engine = mocks.engines.at(-1) as TestEngine
    controller.setRepeat('one')
    controller.playTracks([searchTrack('cancel-repeat')])
    await flushMicrotasks()
    now.mockReturnValue(231_001)
    const ended = engine.onEnded()
    await flushMicrotasks()
    await controller.previous()
    resolveRepeat({ url: null, cachedPath: null, format: null })
    await ended
    expect(controller.getSnapshot().preparing).toBe(false)
    expect(engine.loadWithFormat).toHaveBeenCalledTimes(1)
  })

  it('replays a progressive search result after a late cache handoff', async () => {
    mocks.api.scGetPlayback
      .mockResolvedValueOnce({ url: 'https://media.example/track.mp3', cachedPath: null, format: 'mp3' })
      .mockResolvedValueOnce({ url: null, cachedPath: 'C:/cache/search-track.mp3', format: 'mp3' })
    const controller = new PlayerController()
    const engine = (mocks.engines.at(-1) as TestEngine)
    controller.setRepeat('one')
    controller.playTracks([searchTrack('cache-repeat-1'), searchTrack('cache-repeat-2')], 1)
    await flushMicrotasks()

    expect(engine.loadWithFormat).toHaveBeenCalledWith(
      'https://media.example/track.mp3',
      'mp3',
      'stream',
      expect.any(String),
    )
    expect(mocks.cacheReadyHandler).toBeTypeOf('function')
    mocks.cacheReadyHandler?.('cache-repeat-2')
    await flushMicrotasks()
    expect(engine.replaceStreamWithCachedFile).toHaveBeenCalledWith('asset://C:/cache/search-track.mp3')

    await engine.onEnded()
    await flushMicrotasks()

    expect(engine.loadWithFormat).toHaveBeenCalledTimes(2)
    expect(engine.loadWithFormat).toHaveBeenLastCalledWith(
      'asset://C:/cache/search-track.mp3',
      'mp3',
      'local',
      expect.any(String),
    )
    expect(controller.getSnapshot().currentTrack?.sourceId).toBe('cache-repeat-2')
  })
})
