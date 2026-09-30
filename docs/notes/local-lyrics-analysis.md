# Local lyric timing analysis

Tempo combines explicit lyric endpoints, text estimates, optional BPM and conservative local word matching. Manual endings take priority. A failed or ambiguous recognition result retains the text/BPM fallback; silence or an empty transcript never proves that vocals ended.

## Runtime and storage

- Model: `onnx-community/whisper-tiny_timestamped`, revision `517244293732ee2d58139af5814231b7e6830a0d`, multilingual tiny q8. Seven native files total **43,596,876 bytes**; the complete size/SHA-256 allowlist is in `src-tauri/lyric_model_manifest.json`.
- Transformers.js `3.8.1` and ONNX Runtime Web `1.22.0-dev.20250409-89f8206ba4`. The checked local JSEP `.mjs`/`.wasm` pair totals **21,640,503 bytes**. `npm run prepare:asr` prepares the same files before dev/build. These disk sizes are not RAM limits.
- Model loading uses native asset URLs, disables remote model fallback and browser model caches, and requests `cache: no-store`. Worker inference uses WASM with `numThreads=1`; browser decoding, JIT, rendering and networking may use other OS threads.
- Only an existing registered local/cache file can supply audio. Uncached SoundCloud returns no analysis identity and does not start an analysis audio download or attach a Web Audio source to the stream.
- Decode preflight refuses unknown properties, encoded files over 64 MiB, durations over 600 seconds and conservative decoded estimates over 256 MiB. It retains one current mono 16 kHz PCM buffer; recognition windows are at most 12 seconds.
- Decode, BPM and inference share the analysis lane with loudness. Charged elapsed work creates at least nine times as much waiting debt; seek, provider changes and cancellation do not erase it. This is a scheduler wall-time budget, not a fixed Task Manager CPU percentage.
- Native compact checkpoints survive restarts and model deletion. Accepted source endpoints remember the offset used at matching; a later user offset projects those saved endpoints once. Completed empty windows also prevent repeated work.
- Disabling stops scheduling/Worker work before native cancellation and deletion of the exact dedicated model revision directory. Previously saved compact analysis remains usable.

## Measured behavior, 1 October 2026

Automatic checks used Windows WebView2 **154.0.4258.37**, an isolated hidden Tauri identifier, actual native IPC/assets and the real Worker. The normal user profile, library, playback and model directory were not used for destructive checks. Private song content was kept out of reports and source control.

### Recognition and matching

The first native dev Worker initialization took **2.672 s** after native verification of the prepared files (**1.105 s**). Same-Worker English speech took **2.782 s**, returning 22 timed words; Russian speech took **1.845 s**, returning 12 timed words. The Russian fixture was local Microsoft Irina synthesis, not singing, and two inflected words differed from its reference.

A fresh built app, with Vite stopped and the isolated built-origin preference already enabled, reused the verified model and three native checkpoints. Native ensure took **1.016 s**, embedded Worker initialization **2.532 s**, English **2.702 s** and Russian **1.941 s**. A new Worker in that same process then took **2.204 s / 1.858 s** for the same English/Russian samples. Both passes returned 22/12 words with valid ordered timestamps. The final pass observed zero external request attempts. These are distinct fresh-process and warm-process measurements; the two languages are not a controlled comparison of cold versus warm inference on identical audio in one Worker.

The actual native speech outputs were also passed through the production suffix matcher with manually aligned reference line starts: three English endings and one Russian ending were accepted. This validates matching of real inference results; it is not an independent measurement of word-boundary accuracy. The full runner's narrower speech windows saved three completed fragments with zero accepted endings, demonstrating continued fallback and checkpoint reuse.

**Singing remains unreliable with this compact model.** Three deterministic 12-second windows at approximately 14%, 48% and 76% of one private song, selected around nonempty lyric starts, returned zero usable timed-word sequences and zero accepted endings. Their PCM RMS values were approximately 0.398, 0.388 and 0.388, so they were not silent windows. An additional diagnostic pass retained the actual pipeline and counted output metadata without retaining private text: the model produced 355, 222 and 14 chunks, including zero-duration, missing and out-of-window timestamps. The strict validator rejected the complete invalid sequences. Inference took approximately **11.774 s, 11.412 s and 1.612 s** in the uninstrumented run. No guard was relaxed to make these samples appear successful; there is no general singing-accuracy claim or automatic larger-model fallback.

### Scheduling and reuse

A separate real runner, driven automatically with its playing flag and a seek, performed one native decode, one BPM pass, one Worker initialization and three actual recognition calls. Over **65.059 s**, measured decode/BPM/Worker/checkpoint work occupied **6.350 s (9.761%)**. After a seek immediately following the first result, a **3.190 s** work segment still incurred **28.716 s** of rest; the next **1.759 s** segment incurred **15.831 s** of rest. A fresh runner restored the three native checkpoints without another decode, model ensure, Worker or inference. This controlled runner measurement does not substitute for a user's listening/UI check.

### Memory and CPU attribution

During the direct native speech/song run, WebView2 process working sets totaled about **397 MiB** before work, peaked at a sampled **1,205 MiB**, and were **606 MiB** 1.5 seconds after Worker disposal. Corresponding private-memory values were approximately **257 / 1,063 / 416 MiB**. These sums cover WebView2 browser, renderer and utility processes; shared pages may be counted more than once. The median sampling interval was 500 ms, so short peaks can be missed. They are not exact per-Worker memory measurements.

The private song's source PCM estimate was **50.3 MiB**, with **9.12 MiB** of retained mono PCM. Main-page JavaScript heap after the direct run was approximately **28 MiB**, which excludes important WASM/native backing allocations. Summed WebView2 CPU deltas were about 41 CPU-seconds over a 37-second direct back-to-back inference probe, including decoding/JIT and other browser work. The direct probe bypassed scheduler pauses. A one-thread ORT setting therefore must not be described as a one-OS-thread or total CPU cap.

Dedicated Worker `Runtime.getHeapUsage` was available in the built app. At ready / after English / after Russian it reported **23.95 / 31.56 / 37.70 MiB** of used JavaScript heap and **30.14 / 32.70 / 33.22 MiB** of backing storage, with approximately 2.9 MiB of embedder heap. These CDP categories are separate measurements, not a complete accounting of ONNX/WASM allocations or a sum that can replace process memory. The source PCM number is an estimate; an exact transient peak of the browser decoder's internal allocations was not available.

### Offline and lifecycle boundaries

- All seven prepared native model files passed exact SHA-256 and size checks. Native ensure returned the isolated native directory and real `http://asset.localhost` URLs.
- A process-only proxy pointed to a closed loopback port; empty-cache native ensure failed with zero downloaded bytes. A second probe temporarily held that loopback proxy's `CONNECT huggingface.co:443` request without opening an upstream socket, directly confirming that Rust used the proxy. Disabling during the native `downloading` state rejected the pending ensure in approximately **1.6 ms**.
- Native disable removed exactly the isolated model revision directory, preserved an adjacent marker and all three compact checkpoints, and did not recreate the directory during the two-second observation. Real Rust HTTP tests additionally cover stalled response bodies, partial-file cleanup, corrupt/oversized/truncated downloads, concurrent ensure and enable/disable races. The WebView probe held a CONNECT/header request; it did not download a fresh production model body.
- An in-flight actual Worker transcription was aborted and rejected. CacheStorage and IndexedDB were empty in the isolated inference profile, and observed page responses had no disk-cache flag. These observations do not prove that every internal WebView HTTP-cache entry is absent. Browser request interception alone cannot block Rust requests; no machine-wide firewall, proxy or adapter setting was changed.
- Restart verification used the actual built app at `http://tauri.localhost`, generated `asr.worker-20HGQEvq.js` and embedded runtime with Vite stopped. The verified closed proxy remained process scoped. The first attempt deliberately refused missing model files: a fresh built origin had no persisted opt-in and its frontend disabled/removed the prepared model. After saving an enabled choice only in the isolated built profile, closing it, re-seeding and restarting, cached inference passed. A dev-origin preference must not be assumed to apply to the built origin.

## Repeating the embedded-app smoke test

`scripts/verify-native-asr.mjs` connects to an already running, isolated **built** Tempo WebView2. It checks the embedded Worker and `/asr-runtime/` files at `http://tauri.localhost`, uses native IPC/model asset URLs, validates timed speech results and writes only aggregate evidence. It requires a separately installed Playwright module via `TEMPO_PLAYWRIGHT_MODULE` (absolute module path), or a resolvable `playwright` package. It does not install dependencies, launch/close the app or change the user's normal profile.

1. Create an ignored Tauri configuration override with a unique identifier ending in `.asrprobe` and a hidden main window. Build with `npm run tauri build -- --debug --no-bundle --config <override.json>`. Keep the user's normal app/profile separate.
2. Initialize this isolated built profile and save its deep-analysis preference as enabled; close it before preparing the bundle. Prepare the pinned seven-file bundle under that identifier's native cache and verify its manifest. The script refuses missing/corrupt prepared files. Relaunch only this temporary app with process-scoped `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`. For offline proof, use a separately verified process-only closed proxy; browser routing is insufficient.
3. Write an ignored fixture JSON array, for example `[{"path":"C:/private-test/english.wav","language":"en"},{"path":"C:/private-test/russian.wav","language":"ru"}]`. Keep samples short and known. Optional `trackId` identifies an already registered fixture whose compact checkpoint count should be inspected after restart.
4. Read the actual generated `dist/assets/asr.worker-*.js` name, then run:

   ```text
   node scripts/verify-native-asr.mjs --identifier com.tempo.player.asrprobe --fixtures <fixtures.json> --worker /assets/asr.worker-HASH.js --output <ignored-result.json>
   ```

5. Restore the normal dev command and confirm both Vite and `src-tauri/target/debug/tempo.exe` remain running. Never delete a normal profile to obtain a clean test cache.

The script's raw CDP Worker heap query is optional evidence: unsupported accounting is recorded explicitly. Its totals must be reported separately from process memory, PCM estimates and model disk sizes.

## Notices and automated gates

Runtime/model attribution is in `public/asr-runtime/THIRD_PARTY_NOTICES.md`, with shipped dependency license texts in `public/asr-runtime/licenses`. The model's base OpenAI card declares Apache 2.0; the selected ONNX export does not declare a separate license. Disk-size attribution does not imply a memory or accuracy guarantee. The pinned Transformers dependency also installs Node-only `sharp`; prior audit findings for that dependency are not a clean-audit claim. The shipped ASR Worker uses the browser Transformers export and does not invoke Node image processing.

The final baseline-repair checks passed `npm run check` (240 tests and strict full lint), `npm run build`, `cargo test --lib` (117 passed, one pre-existing ignored network test) and warning-free `cargo check --lib`. Vite still reports its existing large-chunk advisory for ASR/hls assets. No installer compatibility or manual UI result is inferred from these commands.

## Manual checks left to the user

- In main lyrics and overlay, check a short phrase followed by a long instrumental section, a dense six-second phrase, repeated/equal starts, explicit empty markers and the final line.
- Add/edit a manual end and confirm it outranks inferred ends; reset it and compare fallback behavior.
- Change lyric provider and positive/negative offset, seek forward/back, and use playback speeds 0.5–2×. Check that begun lines do not move their fill backward and both views agree.
- Toggle deep analysis in About during download and recognition; check status text, responsiveness and persisted preference after restart.
- Listen to an uncached SoundCloud stream, then let its normal local cache finish. Confirm audible playback continues and analysis becomes eligible without a separate analysis download.
- Check overlay layout, localization and any screenshots visually. No manual UI navigation, listening judgment or screenshots were performed by the automated probes.
