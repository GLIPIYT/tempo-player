import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioEngine } from './engine'

const hlsInstances = vi.hoisted(() => [] as {
  destroy: ReturnType<typeof vi.fn>
  error: ((event: string, data: { fatal: boolean; details: string }) => void) | null
}[])
vi.mock('hls.js', () => ({ default: class {
  static Events = { ERROR: 'hlsError' }
  static isSupported() { return true }
  destroy = vi.fn()
  error: ((event: string, data: { fatal: boolean; details: string }) => void) | null = null
  constructor() { hlsInstances.push(this) }
  on(_event: string, callback: NonNullable<typeof this.error>) { this.error = callback }
  loadSource() {}
  attachMedia(media: HTMLAudioElement) { media.src = 'blob:hls'; media.load() }
} }))

class TestAudio extends EventTarget {
  static instances: TestAudio[] = []
  src = ''
  currentTime = 0
  duration = 180
  paused = true
  ended = false
  seeking = false
  readyState = 0
  playbackRate = 1
  defaultPlaybackRate = 1
  volume = 1
  muted = false
  error = null
  buffered = { length: 0 }
  play = vi.fn(async () => {
    this.paused = false
    this.ended = false
    this.dispatchEvent(new Event('playing'))
  })
  pause(): void { this.paused = true; this.dispatchEvent(new Event('pause')) }
  load(): void {
    this.currentTime = 0
    this.ended = false
    this.readyState = this.src ? 4 : 0
    if (this.src) this.dispatchEvent(new Event('loadedmetadata'))
  }
  removeAttribute(name: string): void { if (name === 'src') this.src = '' }
  constructor() { super(); TestAudio.instances.push(this) }
}

function node() {
  return { connect: vi.fn(), disconnect: vi.fn() }
}
function parameter(value = 0) {
  return { value, setTargetAtTime: vi.fn() }
}
class TestContext extends EventTarget {
  static instances: TestContext[] = []
  static failAfterRouting = false
  state: AudioContextState = 'running'
  sampleRate = 48000
  currentTime = 0
  destination = node()
  sources: ReturnType<typeof node>[] = []
  gains: { gain: ReturnType<typeof parameter> }[] = []
  resume = vi.fn(async () => this.setState('running'))
  close = vi.fn(async () => this.setState('closed'))
  constructor() { super(); TestContext.instances.push(this) }
  setState(state: AudioContextState): void { this.state = state; this.dispatchEvent(new Event('statechange')) }
  createMediaElementSource() { const source = node(); this.sources.push(source); return source }
  createAnalyser() {
    if (TestContext.failAfterRouting) throw new Error('Audio allocation failed')
    return { ...node(), fftSize: 1024, frequencyBinCount: 512,
      getByteTimeDomainData: (data: Uint8Array) => data.fill(130), context: this }
  }
  createBiquadFilter() {
    return { ...node(), frequency: parameter(), gain: parameter(), Q: parameter(),
      getFrequencyResponse: (_frequencies: Float32Array, magnitudes: Float32Array) => magnitudes.fill(1) }
  }
  createGain() { const gain = { ...node(), gain: parameter(1) }; this.gains.push(gain); return gain }
  createDynamicsCompressor() {
    return { ...node(), context: this, threshold: parameter(), knee: parameter(), ratio: parameter(),
      attack: parameter(), release: parameter() }
  }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('playback output recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    TestAudio.instances = []
    TestContext.instances = []
    TestContext.failAfterRouting = false
    hlsInstances.length = 0
    const browser = Object.assign(new EventTarget(), {
      AudioContext: TestContext, setTimeout, clearTimeout, setInterval, clearInterval,
    })
    vi.stubGlobal('window', browser)
    vi.stubGlobal('Audio', TestAudio)
    vi.stubGlobal('HTMLMediaElement', { HAVE_METADATA: 1, HAVE_FUTURE_DATA: 3 })
    // A hidden or busy UI need not deliver animation frames for output recovery.
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

  async function playing() {
    const engine = new AudioEngine()
    await engine.loadWithFormat('asset://cached.mp3', null, 'local', 'session')
    engine.enableGraph()
    engine.setVolume(0.35)
    engine.setPlaybackRate(1.25)
    engine.play()
    await flush()
    const media = TestAudio.instances.at(-1)!
    media.currentTime = 28
    return { engine, media, context: TestContext.instances.at(-1)! }
  }

  it('resumes an interrupted audio context without a Play click or animation frame', async () => {
    const { context, engine } = await playing()
    context.setState('suspended')
    await flush()
    expect(context.resume).toHaveBeenCalledTimes(1)
    expect(context.state).toBe('running')
    expect(engine.getCurrentTime()).toBe(28)
    expect(TestAudio.instances.at(-1)!.paused).toBe(false)
  })

  it('does not resume media after the user paused while context recovery was pending', async () => {
    const { context, engine, media } = await playing()
    let finishResume!: () => void
    context.resume.mockImplementation(() => new Promise<void>(resolve => { finishResume = resolve }))
    context.setState('suspended')
    expect(context.resume).toHaveBeenCalledTimes(1)
    engine.pause()
    context.setState('running')
    finishResume()
    await flush()
    expect(media.paused).toBe(true)
  })

  it('replaces a closed output context and preserves position, speed and volume', async () => {
    const { context, engine, media } = await playing()
    context.setState('closed')
    await flush()
    expect(TestContext.instances.length).toBe(2)
    expect(TestAudio.instances.at(-1)).not.toBe(media)
    expect(engine.getCurrentTime()).toBe(28)
    expect(TestAudio.instances.at(-1)!.playbackRate).toBe(1.25)
    expect(TestContext.instances.at(-1)!.gains.at(-1)!.gain.value).toBe(0.35)
    expect(TestAudio.instances.at(-1)!.paused).toBe(false)
  })

  it('falls back to an unrouted element if graph allocation fails after routing', async () => {
    const engine = new AudioEngine()
    await engine.loadWithFormat('asset://cached.mp3', null, 'local', 'session')
    engine.play()
    await flush()
    const routed = TestAudio.instances.at(-1)!
    routed.currentTime = 19
    TestContext.failAfterRouting = true
    engine.enableGraph()
    await flush()
    const current = TestAudio.instances.at(-1)!
    expect(current).not.toBe(routed)
    expect(current.paused).toBe(false)
    expect(engine.getCurrentTime()).toBe(19)
    expect(TestContext.instances[0].close).toHaveBeenCalled()
  })

  it('recovers a stalled cached decoder even when no animation frames run', async () => {
    const { engine, media } = await playing()
    await vi.advanceTimersByTimeAsync(10000)
    expect(TestAudio.instances.at(-1)).not.toBe(media)
    expect(engine.getCurrentTime()).toBe(28)
    expect(TestAudio.instances.at(-1)!.paused).toBe(false)
  })

  it('rebuilds output if the browser never settles its resume promise', async () => {
    const { engine, context, media } = await playing()
    context.resume.mockImplementation(() => new Promise(() => {}))
    context.setState('suspended')
    await vi.advanceTimersByTimeAsync(3000)
    expect(TestAudio.instances.at(-1)).not.toBe(media)
    expect(engine.getCurrentTime()).toBe(28)
    expect(TestAudio.instances.at(-1)!.paused).toBe(false)
    expect(context.close).toHaveBeenCalled()
  })

  it('bypasses a repeatedly failing context while retaining the selected volume', async () => {
    const { engine, context } = await playing()
    context.setState('closed')
    await flush()
    TestContext.instances.at(-1)!.setState('closed')
    await flush()
    expect(TestContext.instances).toHaveLength(2)
    expect(engine.getAnalyser()).toBeNull()
    expect(engine.getCurrentTime()).toBe(28)
    expect(TestAudio.instances.at(-1)!.paused).toBe(false)
    expect(TestAudio.instances.at(-1)!.volume).toBe(0.35)
  })

  it('does not reload a user-paused decoder', async () => {
    const { engine, media } = await playing()
    engine.pause()
    await vi.advanceTimersByTimeAsync(15000)
    expect(TestAudio.instances.at(-1)).toBe(media)
    expect(media.paused).toBe(true)
  })

  it('can restore a different stalled file during the previous file recovery cooldown', async () => {
    const { engine } = await playing()
    await vi.advanceTimersByTimeAsync(10000)
    await engine.loadWithFormat('asset://other.mp3', null, 'local', 'other')
    engine.play()
    await flush()
    const other = TestAudio.instances.at(-1)!
    other.currentTime = 10
    await vi.advanceTimersByTimeAsync(10000)
    expect(TestAudio.instances.at(-1)).not.toBe(other)
    expect(engine.getCurrentTime()).toBe(10)
  })

  it('disconnects outgoing audio nodes when a crossfade finishes', async () => {
    const { engine, context, media } = await playing()
    await engine.crossfadeTo('asset://next.mp3', null, 'local', 0.2, 'next-session')
    await vi.advanceTimersByTimeAsync(300)
    expect(media.paused).toBe(true)
    expect(context.sources[0].disconnect).toHaveBeenCalled()
    expect(TestAudio.instances.at(-1)!.paused).toBe(false)
  })

  it('repeats ended HLS media without destroying its loaded stream', async () => {
    const engine = new AudioEngine()
    await engine.loadWithFormat('https://provider/stream.m3u8', 'hls', 'local', 'first')
    engine.play()
    await flush()
    const media = TestAudio.instances.at(-1)!
    media.currentTime = media.duration
    media.ended = true
    engine.onEnded = () => { expect(engine.replay('repeat-session')).toBe(true) }
    media.dispatchEvent(new Event('ended'))
    await flush()
    expect(hlsInstances[0].destroy).not.toHaveBeenCalled()
    expect(TestAudio.instances.at(-1)).toBe(media)
    expect(engine.getCurrentTime()).toBe(0)
    expect(media.paused).toBe(false)
  })

  it('lets the controller reload a source that refuses a repeat seek', async () => {
    const { engine, media } = await playing()
    Object.defineProperty(media, 'currentTime', {
      get: () => 180,
      set: () => { throw new DOMException('Not seekable', 'InvalidStateError') },
    })
    expect(engine.replay('repeat')).toBe(false)
  })

  it('reports fatal HLS failures so playback recovery can run', async () => {
    const engine = new AudioEngine()
    const error = vi.fn()
    engine.onError = error
    await engine.loadWithFormat('https://provider/stream.m3u8', 'hls', 'local', 'hls')
    const hls = hlsInstances[0]
    hls.error?.('hlsError', { fatal: false, details: 'bufferStalledError' })
    expect(error).not.toHaveBeenCalled()
    hls.error?.('hlsError', { fatal: true, details: 'bufferAppendError' })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('bufferAppendError'))
    expect(hls.destroy).toHaveBeenCalled()
  })
})
