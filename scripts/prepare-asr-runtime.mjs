import { createRequire } from 'node:module'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)
const root = resolve(dirname(require.resolve('onnxruntime-web')), '..')
const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (packageInfo.version !== '1.22.0-dev.20250409-89f8206ba4') throw new Error('Unexpected ORT version')
const target = new URL('../public/asr-runtime/', import.meta.url)
await mkdir(target, { recursive: true })
for (const [file, sha256] of [
  ['ort-wasm-simd-threaded.jsep.mjs', '08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9'],
  ['ort-wasm-simd-threaded.jsep.wasm', 'c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39'],
]) {
  const source = resolve(root, 'dist', file)
  if (createHash('sha256').update(await readFile(source)).digest('hex') !== sha256) throw new Error(`Runtime integrity mismatch: ${file}`)
  await copyFile(source, new URL(file, target))
}
console.log('Prepared exact local ORT JSEP runtime (21,640,503 bytes).')
