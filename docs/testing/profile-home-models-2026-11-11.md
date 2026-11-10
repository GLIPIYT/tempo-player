# Profile, Home and lyrics models — 11 November 2026

No browser, screenshot or visual verification was performed by the implementation agents for this batch. The user reviewed the standalone profile/dialog preview and selected variant C. The production wiring uses real application APIs; the standalone preview uses sample data only.

## Automated evidence

- Frontend checks cover type safety, hook ordering, lint and unit regressions. The final results are recorded in the local task plan and completion message.
- All 45 native database tests passed, including migration idempotency, persistence of explicit playlist covers, priority over collages, and the unchanged automatic fallback.
- All 25 native lyrics-analysis tests passed. Local HTTP fixtures required `NO_PROXY/no_proxy=127.0.0.1,localhost` in this environment; the earlier proxy-related failures were rerun successfully. Cache reuse tests assert the HTTP hit count and distinguish `checking` from `downloading`.
- The model runner tests exercise actual mocked worker requests and retry of unavailable audio. Processing-card tests assert status wording; they do not establish model alignment accuracy on a real song.
- The three-variant preview compiled independently with Vite. Native PNG dimensions and all six ICO directory entries were checked as binary metadata; this is not visual icon QA.

## Manual follow-up

1. Return to Home several times from another page. Previously loaded local mixes, recent tracks and frequent tracks should remain visible while refreshing. An initial process cache miss still needs its first database response. Check both zero-interval and positive-interval custom rules.
2. On a local or fully cached track, enable word timing. A fresh native manager may check files once; later worker restarts should keep the model available. Missing or unreadable audio should show its specific reason and offer retry. Check the word-by-word requirement and paused status too.
3. Open Profile over a bright wallpaper. The dark panel should cover the header and content. Open a month/day report, close it with the pointer away from the original column, and verify that no hover highlight remains. Grid mode should be absent.
4. Right-click a profile track, artist, album link and playlist; check their corresponding playback, navigation, favorite and delete actions. Likes must not offer playlist deletion.
5. Create an empty playlist from the sidebar, catalog and profile. Check the recent cover choices, select one, restart the app and verify persistence. Create one from a track's menu: its cover should be automatic and the picker absent. Cancel deletion from each entry point, then confirm on a disposable playlist/rule.
6. Rename a short and a long playlist, including at 125% scale. The field should follow the text width and stay within the header with its save/cancel buttons.
7. In lyrics, check the lighter backdrop, background-derived spectrum color, 240 px maximum height and lower-edge transparency. Check Profile/Settings sidebar selection at 100% and 125% scale.
8. Check the running rebuilt window/tray icon. Start menu shortcuts in an already installed release only receive new embedded artwork when that installation is updated; no release was published for this batch.

History retains its existing attribution by listening start time. Word alignment remains approximate. No new real-audio accuracy or frame-rate guarantee is claimed by these checks.
