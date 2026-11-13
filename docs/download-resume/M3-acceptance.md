# M3 acceptance — 2026-11-12

M3 passes its independent acceptance gate. M0–M3 are accepted; M4 is next. The full objective remains active.

## Behavior and integrity

HLS/DASH VOD files use durable atomic part and initialization checkpoints. Each part is identified by its manifest/track fingerprint and index, committed only after flush and full local SHA-256 checksums. Video and audio keep independent files/ledgers; completed video is reused while only missing audio parts are fetched. Sequential track reports carry the previous track byte offset and processing reports preserve the fetched byte high water mark.

A persisted segmented-source snapshot owns the complete selected playlist/track identity and verified media descriptor. HLS recovery does not refetch a completed initialization segment merely to determine codecs after restart. Before appending remote bytes, the current playlist fingerprint is compared with the retained source. Changed manifests, track identity or sequence numbering delete old input families and report an explicit full restart. Worker source/index/hash checks remain mandatory; an existing filename alone never marks a part complete.

HLS without ENDLIST and dynamic DASH are finite snapshots of the currently advertised window. Partial live transport has Stop semantics: cancel/stop clears files/records, transient failure does not schedule stream resume, and interrupted live transport restores as a restartable failure. Completed live snapshots retain the original manifests, media descriptor and immutable inputs if processing fails. Their processing Retry validates the cached bytes and reruns mux without reading a changed/expired live playlist; this works after browser restart. Re-detection with explicit source revalidation does not use this frozen processing shortcut.

## Verification

Dedicated real-browser HLS/DASH acceptance: ten passed. Combined with five existing M0 mux-retry cases: 15 passed, no failures/skips. New unit coverage validates VOD/live classification, manifest restart diagnostics, progress preservation through processing, malformed/negative/unsafe HLS sequence numbers, live stop/restart rules and frozen completed-snapshot processing. Final core unit/worker integration: 171 passed. Workspace units: 48 passed. All 17 type-check packages, production build, eight orchestration/cancel cases, relevant lint and patch checks pass. Full browser regression including HEVC: 66 passed, no failures; four existing opt-in external-site cases skipped. Final cache qualification and processing-label corrections were then verified on the final build with the TTL and two completed-live-snapshot cases (three passed, 14 other cases filtered out), plus final unit/type/build/lint checks.

Commands:

- `pnpm --filter chrome-extension test`
- `pnpm type-check`
- `pnpm build`
- `node --import tsx --experimental-test-module-mocks --test chrome-extension/src/offscreen/lib/hls-download.test.mjs chrome-extension/src/offscreen/download_worker/mux-cancel.test.mjs`
- `VIDSY_E2E_AI=off pnpm --filter @extension/e2e exec vitest run --config vitest.config.ts specs/resume-m3.test.ts specs/resume-m0.test.ts`: 15 passed.
- `VIDSY_E2E_AI=off VIDSY_MEDIA_REMUX_E2E=true pnpm --filter @extension/e2e exec vitest run --config vitest.config.ts`: 66 passed, no failures; four opt-in external-site cases skipped.

Final source hashes and logs are in [evidence/m3-2026-11-12](evidence/m3-2026-11-12). The full-suite log precedes the small final cache-qualification and processing-label corrections; final-cache.log and the final core/type/build/lint checks validate those corrections.

## Recorded browser steps and human reproduction

Run the dedicated command with `VIDSY_E2E_HEADED=true` to observe the isolated persistent profile. Local fixtures cover both protocols; ffprobe checks video and audio presence, duration between 1.9 and 2.5 seconds and output size above 1000 bytes.

1. Pause VOD after the first of two video segments, restart the browser/profile and resume. Completed video media/init requests do not repeat; missing audio and video inputs remain allowed.
2. Complete video, pause audio after its first part, restart and resume. The only media requests are unfinished audio parts; no video or initialization is downloaded again.
3. Change HLS media sequence or DASH start numbering while paused, then resume. The task explains source identity change and full restart; it fetches the new first part, never splices old parts, and delivers validated media.
4. Pause the fixture server after one live part. Popup exposes Stop and no Pause/Resume promise. Stop removes all related physical families and ledger records.
5. Download a full live snapshot and inject a real mux failure through the worker channel. Change the live manifest endpoint to return 403, restart the browser, and Retry. No playlist/media request occurs; cached original snapshot inputs produce valid output. A separate actual host-sleep session is not claimed.

## Changed files

- Background runtime/queue/download and entrypoint: segmented-source snapshot RPC, failure-kind persistence, live transport/frozen processing lifecycle, explicit source restart and progress projection.
- `chrome-extension/src/background/lib/segmented-recovery.test.ts`.
- Offscreen `segment-policy.ts`, `segmented-resume.ts`, `hls-download.ts`, `dash-download.ts`, `hls-request.ts`, `download-failure.ts`, `download-failure.test.ts`, `execution-registry.ts`, `worker-client.ts`, `m3u8-parser.ts`, `m3u8-parser.test.ts`, `hls-download.test.mjs`.
- Shared/storage progress types and background progress adapter: resume capability and cumulative byte preservation.
- `packages/ui/lib/components/media/DownloadRow.tsx` and `pages/popup/src/views/DownloadDetailsView.tsx`: live Stop and snapshot-processing capability labels.
- `tests/e2e/helpers/mux-failure.ts`, `tests/e2e/specs/resume-m3.test.ts`; existing `resume-m0.test.ts` reuses the same real mux injection helper.
- README, CHANGELOG, STATUS and milestone evidence/report.

## Remaining limits

Partial HTTP still requires a strong ETag, non-Range byte-offset transport must restart with a reason, signed-source refresh and <=1 MiB internal checkpoints remain M4. Final native-delivery artifacts are still session-scoped. User-facing cache/metered/batch/capability governance remains M5. DASH multi-period or unbounded layouts fail explicitly; incomplete live transport has no resume capability.
