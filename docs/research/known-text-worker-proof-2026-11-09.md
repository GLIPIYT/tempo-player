# Known-text alignment in the Tempo worker

This records a local proof of the bounded known-text request using Tempo's real browser Worker, pinned Transformers.js pipeline, quantized Whisper tiny ONNX files, and the ORT WebAssembly runtime. It uses the same privately retained English word-timing fixture described in [the alignment experiment](word-alignment-experiment-2026-11-09.md); this note includes no audio or lyric text.

## Result

| Measure | Tempo worker prototype | Existing comparison |
| --- | ---: | ---: |
| Manually annotated English word onsets | 24/24 returned | — |
| Mean absolute onset error | 184.3 ms | FireRed 406 ms; bounded `stable-ts` 155 ms |
| Median absolute onset error | 112.7 ms | FireRed 302 ms; bounded `stable-ts` 115 ms |
| Onsets within ±200 ms | 18/24 | FireRed 9/24; bounded `stable-ts` 18/24 |

The prototype was better than the existing FireRed result on this fixture, but had higher mean onset error than bounded `stable-ts`. The sample has only 24 words and does not establish performance across songs or languages.

The worker accepted all three known source-line windows (6, 11, and 7 words). It rejected both controls with no returned words and zero confidence: unrelated six-token text forced over the same speech window, and the correct source text forced over zero-valued PCM.

## Reproduction details

- Model: `onnx-community/whisper-tiny_timestamped`, revision `517244293732ee2d58139af5814231b7e6830a0d`.
- Runtime: `@huggingface/transformers` 3.8.1 and the repository's pinned ORT Web runtime 1.22.0 development build.
- Input: 16 kHz mono float PCM, three source-line windows, each under 12 seconds; inference used the actual `createAsrWorker` protocol and `align-known-text` request.
- The cached model was read through a local test server. This proof did not add Python to the application, call a remote inference service, or modify source lyrics.
- The reported confidence is a prototype token-likelihood gate, not a calibrated probability of correct timing. Wrong-text and silence controls are useful rejection checks, not comprehensive adversarial validation.

## Limits

This confirms that the pinned decoder can run teacher-forced known text and expose cross-attention in the actual browser WASM worker. It does not establish reliable timings on Russian singing, on ordinary LRC boundaries, or across a larger song set. Keep the option opt-in and retain source/manual timing priority until broader annotated evaluation is available.
