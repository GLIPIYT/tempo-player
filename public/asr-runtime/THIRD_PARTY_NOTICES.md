# Local lyrics recognition runtime

The JavaScript and WebAssembly runtime is bundled with Tempo. Model artifacts
are downloaded only through Tempo's verified native model cache when enabled.

- **Transformers.js 3.8.1**, Hugging Face — Apache-2.0.
  Source: https://github.com/huggingface/transformers.js/tree/3.8.1
  Full license: `licenses/transformers-LICENSE.txt`.
- **ONNX Runtime Web and Common 1.22.0-dev.20250409-89f8206ba4**, Microsoft — MIT.
  Exact source commit: `89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0`.
  Source: https://github.com/microsoft/onnxruntime/tree/89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0
  Full license and upstream third-party notices: `licenses/onnxruntime-LICENSE.txt`
  and `licenses/onnxruntime-ThirdPartyNotices.txt`. These upstream notices cover
  the wider ONNX Runtime project; they do not assert that every listed library
  executes in this WASM build.
- **Hugging Face Jinja 0.5.10** — MIT; `licenses/jinja-LICENSE.txt`.
- Resolved ONNX Runtime Web dependencies: **FlatBuffers 25.9.23** and
  **long 5.3.2** (Apache-2.0), **platform 1.3.6** (MIT),
  **protobufjs 7.6.6** (BSD-3-Clause). Their supplied license texts are retained
  in `licenses/`. **guid-typescript 1.0.9** declares ISC in its npm metadata;
  its published archive does not supply a separate license text.

## Model attribution

Multilingual Whisper tiny is based on **OpenAI Whisper tiny**. The base model
card at revision `169d4a4341b33bc18d8881c4b69c2e104e1cc0af` declares Apache-2.0.
Base model: https://huggingface.co/openai/whisper-tiny

The q8 ONNX export is **onnx-community/whisper-tiny_timestamped**, pinned to
`517244293732ee2d58139af5814231b7e6830a0d`:
https://huggingface.co/onnx-community/whisper-tiny_timestamped/tree/517244293732ee2d58139af5814231b7e6830a0d

The export card names OpenAI's base model but does not contain a separate
exporter license declaration. The Apache-2.0 license text is included in
`licenses/transformers-LICENSE.txt`. Tempo verifies the sizes and SHA-256
hashes of all seven model artifacts before they can be used.

## Runtime files

`npm run prepare:asr` copies and verifies the exact matching ORT JSEP pair from
the locked npm package before both `npm run dev` and `npm run build`:

- `ort-wasm-simd-threaded.jsep.mjs` — 44,484 bytes.
- `ort-wasm-simd-threaded.jsep.wasm` — 21,596,019 bytes.

Inference uses WASM with one thread and no proxy/GPU. Browser model caching
and remote model loading are disabled. The Node-only image library `sharp`
and `onnxruntime-node` are npm dependencies of Transformers.js but are not
part of Tempo's browser ASR entry point.
