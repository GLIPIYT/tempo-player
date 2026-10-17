# SoundCloud browser integration implementation plan

**Goal:** integrate the verified official browser playback path, segmented Opus cache and the requested session/settings controls.

**Architecture:** the existing native actor owns transport state and queue behavior. Hidden browser hosts provide authorized media playback and dry normal-speed recording. The existing cache store owns deduplication, metadata and final file promotion.

**Spec:** `docs/superpowers/specs/2026-10-17-soundcloud-drm-playback-cache-design.md`, including the updated segmented-cache requirements.

## Constraints

- Main checkout only; coordinated Luna max agents; no credentials or diagnostic profile copied into the product.
- Automatic blocks 1–8; manual blocks 1–12; Opus 192 kbit/s VBR.
- Preserve offline cache hits, clear streams, native DSP and queue ownership.
- Use compile/type checks and the runtime experiments already requested; do not add or run test suites.

## Work

- [x] Session/settings: validated status, personal logout, current CPU/RAM block policy, General controls and About warning. Agent owns session/policy/frontend; root wires commands.
- [x] Browser playback: generation-scoped official Widget, frame-local DSP, bounded sanitized clock/spectrum bridge, hidden lifecycle. Agent owns browser module/assets.
- [x] Local assembly: bounded neighboring-overlap alignment, 8 ms blend, one Opus encode, duration validation and cancellation. Agent owns local joining module.
- [x] Recording: bounded acknowledged PCM blocks, start gate, verified segment coverage and normal-rate playback. Root owns recording host and cache-store integration.
- [x] Native actor: prepared transport variant, browser clocks/control/end events, queue/repeat/shuffle/history and no mid-track cache switch. Root owns resolver/actor.
- [x] Review integration and run Rust/TypeScript/JavaScript checks; record measured results and remaining limits below.

Delivery follows verification: commit/push main, inspect CI and confirm that the normal development player remains open. Record the resulting commit and CI status in the ignored daily task plan after delivery.

## Verification evidence

`cargo check --manifest-path src-tauri/Cargo.toml --lib`, `npm run typecheck`, `npm run check:hooks`, scoped ESLint and JavaScript syntax checks passed. No test suites were added or run. A final Luna max review found a stale-entry retry case and a browser/API-session distinction; both were corrected.

Temporary runtime probes used the same production transport/recorder/join modules with an isolated, already authenticated diagnostic profile and a fixed public 139.186485-second track. The profile, audio, reports and probe binaries remain ignored local artifacts; no credentials were migrated into the application.

| Blocks | Capture through final local validation | Opus size | Decoded duration |
| --- | --- | --- | --- |
| 3 | 60.193 s | 3,148,018 bytes | 139.186479 s |
| 8 | 32.071 s | 3,147,354 bytes | 139.186479 s |
| 12 | 26.933 s | 3,146,211 bytes | 139.186479 s |

Foreground playback continued during each capture. After the settings-schema correction, the 8- and 12-block runs also reported active processing, nonzero foreground spectrum and exactly one matching end event. Independent local decoding and comparison at seven reference positions found no accumulating drift; the minimum correlation per file was 0.9943, 0.9916 and 0.9940 respectively. This is lossy Opus, not a bit-identical copy. The successful 8-block run peaked at about 709 MiB private resident memory including foreground playback. A separate low-memory attempt stopped at the guard instead of publishing an incomplete cache file.

These are single-track Windows measurements with a warm authenticated profile, not universal timings or concurrency guarantees. The complete production-profile login/logout flow, every player control and other platforms were not runtime-verified in this integration pass. Native repeat/shuffle/history/SMTC ownership was preserved and reviewed, without claiming an exhaustive runtime regression pass.

## Review focus

- Cached files remain usable without network or active account.
- Stale browser events and upstream FINISH rewind cannot advance a new track.
- Cancellation/logout closes owned browser hosts and removes only incomplete output.
- Manual settings survive UI reload; automatic mode samples current load before jobs.
- Failed/short recordings never produce a completed cache marker.
