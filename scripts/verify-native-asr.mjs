// Automatic native WebView2 smoke test. See docs/notes/local-lyrics-analysis.md.
// Requires an isolated, already running Tempo and an external Playwright install.
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  cdp: { type: 'string', default: 'http://127.0.0.1:9222' },
  identifier: { type: 'string' }, fixtures: { type: 'string' },
  worker: { type: 'string' }, output: { type: 'string' },
} })
if (!values.identifier?.match(/\.(?:asrprobe|task6probe)$/) || !values.fixtures || !values.worker || !values.output) {
  throw new Error('Use --identifier <isolated .asrprobe ID> --fixtures <JSON> --worker </assets/asr.worker-HASH.js> --output <JSON>')
}
const endpoint = new URL(values.cdp)
if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('CDP must be loopback')
if (!/^\/assets\/asr\.worker-[\w-]+\.js$/.test(values.worker)) throw new Error('Use the actual built Worker asset')
const manifest = JSON.parse(await readFile(new URL('../src-tauri/lyric_model_manifest.json', import.meta.url), 'utf8'))
const fixtures = JSON.parse((await readFile(resolve(values.fixtures), 'utf8')).replace(/^\uFEFF/, ''))
if (!Array.isArray(fixtures) || !fixtures.length || fixtures.some(f => !isAbsolute(f.path) || !['en', 'ru'].includes(f.language))) {
  throw new Error('Fixtures must be an array of absolute path + en/ru language pairs')
}
// Require a verified, preseeded isolated model before calling native ensure.
const modelDirectory = join(process.env.LOCALAPPDATA, values.identifier, 'lyrics-analysis-model', manifest.revision)
for (const file of manifest.files) {
  const bytes = await readFile(join(modelDirectory, file.relativePath)).catch(() => {
    throw new Error('A required isolated model file is missing; prepare the pinned bundle first')
  })
  if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new Error('Preseeded isolated model failed manifest validation')
  }
}
const { chromium } = createRequire(import.meta.url)(process.env.TEMPO_PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.connectOverCDP(values.cdp)
let context, route, browserSession
const workerHeapSamples = []
try {
  const pages = browser.contexts().flatMap(c => c.pages())
  const matching = []
  for (const page of pages) {
    const id = await page.evaluate(() => window.__TAURI_INTERNALS__?.invoke('plugin:app|identifier')).catch(() => null)
    if (id === values.identifier) matching.push(page)
  }
  if (matching.length !== 1) throw new Error('Expected exactly one isolated native Tempo page')
  const page = matching[0]
  browserSession = await browser.newBrowserCDPSession()
  await page.exposeFunction('__tempoProbeHeap', async () => {
    let attached
    try {
      const { targetInfos } = await browserSession.send('Target.getTargets')
      const target = targetInfos.find(t => t.type === 'worker' && t.url.includes(values.worker))
      if (!target) return workerHeapSamples.push({ unavailable: 'Dedicated Worker target not exposed' })
      attached = (await browserSession.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })).sessionId
      const heap = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { browserSession.off('Target.receivedMessageFromTarget', receive); reject(new Error('Heap query timeout')) }, 3000)
        function receive(event) {
          if (event.sessionId !== attached) return
          const message = JSON.parse(event.message)
          if (message.id !== 1) return
          clearTimeout(timer)
          browserSession.off('Target.receivedMessageFromTarget', receive)
          if (message.error) reject(new Error('Heap query unsupported'))
          else resolve(message.result)
        }
        browserSession.on('Target.receivedMessageFromTarget', receive)
        browserSession.send('Target.sendMessageToTarget', { sessionId: attached,
          message: JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' }) }).catch(reject)
      })
      workerHeapSamples.push(heap)
    } catch { workerHeapSamples.push({ unavailable: 'WebView2 did not expose Worker heap accounting' }) }
    finally { if (attached) await browserSession.send('Target.detachFromTarget', { sessionId: attached }).catch(() => {}) }
  })
  context = page.context()
  let externalBlocked = 0
  const externalHosts = new Set()
  route = async request => {
    const url = new URL(request.request().url())
    if (['localhost', '127.0.0.1', 'tauri.localhost', 'asset.localhost', 'ipc.localhost'].includes(url.hostname)) return request.continue()
    externalBlocked++
    externalHosts.add(url.hostname)
    return request.abort()
  }
  await context.route('**/*', route)
  const result = await page.evaluate(async ({ fixtures, workerUrl, identifier }) => {
    const { invoke, convertFileSrc } = window.__TAURI_INTERNALS__
    if (await invoke('plugin:app|identifier') !== identifier) throw new Error('Isolation changed')
    if (location.origin !== 'http://tauri.localhost') throw new Error('This check requires embedded built assets')
    await invoke('lyrics_analysis_set_enabled', { enabled: true })
    const start = performance.now()
    const bundle = await invoke('lyrics_analysis_ensure_model')
    const ensureMs = performance.now() - start
    if (!bundle.files.every(f => f.absolutePath.includes(identifier))) throw new Error('Unexpected native model directory')
    const worker = new Worker(workerUrl, { type: 'module' })
    function request(message, transfer = []) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Native Worker timeout')) }, 120000)
        worker.onerror = () => { clearTimeout(timer); reject(new Error('Native Worker failed')) }
        worker.onmessage = ({ data }) => {
          clearTimeout(timer)
          if (data.type === 'error') reject(new Error('Native inference failed'))
          else resolve(data)
        }
        worker.postMessage(message, transfer)
      })
    }
    try {
      const initialized = performance.now()
      const ready = await request({ type: 'init', jobId: 1, bundle,
        artifactUrls: Object.fromEntries(bundle.files.map(f => [f.relativePath, convertFileSrc(f.absolutePath)])),
        wasmBaseUrl: new URL('/asr-runtime/', location.href).href })
      if (ready.type !== 'ready') throw new Error('Worker initialization failed')
      const initMs = performance.now() - initialized, samples = []
      await window.__tempoProbeHeap()
      for (const [index, fixture] of fixtures.entries()) {
        const bytes = await (await fetch(convertFileSrc(fixture.path), { cache: 'no-store' })).arrayBuffer()
        const audio = new AudioContext({ sampleRate: 16000 })
        let pcm
        try {
          const decoded = await audio.decodeAudioData(bytes)
          const length = Math.min(decoded.length, 12 * 16000)
          pcm = new Float32Array(length)
          for (let c = 0; c < decoded.numberOfChannels; c++) {
            const channel = decoded.getChannelData(c)
            for (let i = 0; i < length; i++) pcm[i] += channel[i] / decoded.numberOfChannels
          }
        } finally { await audio.close() }
        const duration = pcm.length / 16000, began = performance.now()
        const response = await request({ type: 'transcribe', jobId: 1, fragmentId: String(index),
          trackStartSec: 0, sampleRate: 16000, pcm, language: fixture.language }, [pcm.buffer])
        if (response.type !== 'result') throw new Error('Expected actual transcription')
        let previous = 0
        const validTimes = response.words.every(word => {
          const valid = Number.isFinite(word.startSec) && Number.isFinite(word.endSec)
            && word.startSec >= previous && word.endSec > word.startSec && word.endSec <= duration
          previous = word.endSec
          return valid
        })
        if (!validTimes || !response.words.length) throw new Error('No usable timed words for speech fixture')
        // Aggregate only: never emit paths, titles, PCM, keys or transcript text.
        samples.push({ language: fixture.language, duration, words: response.words.length,
          validTimes, wallMs: performance.now() - began, inferenceMs: response.elapsedMs })
        await window.__tempoProbeHeap()
      }
      const cachedFixture = fixtures.find(f => Number.isSafeInteger(f.trackId))
      const identity = cachedFixture ? await invoke('lyrics_analysis_audio_identity', { trackId: cachedFixture.trackId, source: 'local', sourceId: null }) : null
      const saved = identity ? await invoke('lyrics_analysis_get', { fingerprint: identity.fingerprint }) : null
      return { origin: location.origin, userAgent: navigator.userAgent, ensureMs, initMs, samples,
        persistedFixtureFragments: saved?.fragments.length ?? 0,
        cacheStorageKeys: await caches.keys(), indexedDbCount: (await indexedDB.databases()).length }
    } finally { worker.terminate() }
  }, { fixtures, workerUrl: values.worker, identifier: values.identifier })
  const report = { ...result, externalBlocked, externalHosts: [...externalHosts], workerHeapSamples, nativeManifestFilesVerified: manifest.files.length,
    limitations: ['Request routing is browser scoped; native offline assurance requires a separately verified process proxy.',
      'CacheStorage/IndexedDB inspection does not prove absence of all WebView HTTP cache entries.'] }
  await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (context && route) await context.unroute('**/*', route)
  await browserSession?.detach()
  // Disconnect the CDP client; do not close the user's default page/context.
  await browser.close()
}
