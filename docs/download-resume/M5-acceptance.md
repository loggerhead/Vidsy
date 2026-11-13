# M5 acceptance — 2026-11-12

M5 passes its independent acceptance gate. M0–M5 are accepted, and the full objective passes [global acceptance](GLOBAL-acceptance.md). Final full browser regression: 97 passed, no failures; four existing external live-account opt-ins were skipped.

## Behavior

HTTP probes and both merged-track probes publish capability before payload dispatch. HLS/DASH establish VOD/live and manifest/track identity before transferring parts. Unknown/non-Range transport exposes Stop; a stopped non-Range task explicitly says that Resume downloads again. Incomplete live snapshots expose Stop and no resume promise. Processing Retry and saved-artifact Deliver again have separate capabilities. Completed live outputs can pause, restart the browser and deliver locally after full hash/metadata validation.

Paused rows and details distinguish verified cached bytes from the monotonic visible counter. HTTP details include the next missing payload byte offset; remaining payload is shown when total input size is known. Segmented totals can remain unknown until the server provides sufficient metadata, so the UI does not invent an exact estimate. Retained progress is checked before reuse, followed by a verified resumed-byte notice. Integrity/source/Range/cache cleanup reasons remain visible.

Popup and side panel provide Pause all and Resume all. Batch pause includes queued undispatched jobs and stops incomplete live snapshots with an explicit new-snapshot restart reason. Completed live inputs/outputs retain their resumable processing/delivery path. Scheduling is suppressed during each batch and then run once; configured queue and connection budgets still apply. Manual pause, cancellation and metered pauses clear automatic recovery. A cellular/data-saver report pauses valid regular jobs and stops incomplete live snapshots. New work is held before network dispatch. Explicit Resume/Retry allows that task on the current connection. Changing unrelated retention settings does not revoke that allowance.

Settings expose Partial download cache: retained file usage, per-task state and expiration, persistence outcome, input retention from 1 to 365 days (default 7), per-task discard and discard all paused/failed work. Discard cancels before removing owned files and records; active jobs stay protected. Retention updates preserve original timestamps and the separate 24-hour artifact lease. Startup explicitly calls navigator.storage.persisted()/persist(); refusal is reported and does not block download execution. Interrupted jobs without their previous execution ID still cancel through request ownership and leave no files or ledger records.

Expired-source lookup accepts the original tab only if its page matches, or the single tab whose URL exactly matches the stored original page. Missing/ambiguous/different pages preserve progress with re-detection guidance. The fallback persists the new tab ID and refreshes DNR before retry. Media candidates still require a unique original origin/path, and alias cache adoption still verifies validators, total length, local hashes and remote boundary samples. Audio/video headers are passed and scoped independently through preflight, metadata and media requests. Source authorization rejects ended tasks and rechecks execution identity/state after asynchronous rule changes; a stopped execution cannot regain source rules.

## Final verification

- Core units and actual worker integration: 202 passed.
- Package/page units: 48 passed.
- Processing/cancel orchestration: nine passed, including distinct authenticated HLS track credentials for manifests, metadata and segment transfer.
- Dedicated M5 browser suite: nine passed. It covers paused details; popup/side-panel batch controls with queue limits; cache/persistence/TTL/discard; interrupted-execution cancellation; original-page browser restart; exact-page expired URL renewal after restart; reported cellular policy; manual metered fallback; and no-Range Stop/download-again semantics.
- HLS/DASH live-artifact pause/restart/delivery and individual/batch live Stop checks are in the expanded 18-case M3 suite.
- Latest targeted pipeline/UI correction checks: five passed, 21 filtered out. Source authorization/credential/history checks: three passed, 35 filtered out. Latest live batch Stop checks: two passed, 16 filtered out, covering popup HLS and side-panel DASH. The corrected complete 24-case download-pipeline suite also passed.
- All 17 type-check packages and production build pass. Relevant lint passes. Final full regression: 97 passed, no failures, four external-site opt-ins skipped; 19 test files passed and one opt-in file was skipped. This run includes both live batch Stop cases and the complete 18-case HLS/DASH suite. The preceding full regression before the last live refinement also passed 95 cases without failures.
- Initial whole-browser sweep: 93 passed, two failed, four existing external-site opt-ins skipped. The terminal-clear fixture collided with a retained failed delivery from an earlier test because both used the same resource URL. It now uses a unique resource while testing repeat submission of that exact resource after clearing. The popup fixture omitted resumeCapability and therefore correctly showed Stop; it now declares Range capability for the mocked Range download. Both corrected cases pass. A second full sweep also had 93 passed, two failed and four skipped: a credential-cleanup assertion saw one remaining rule from prior retained fixture state, and the history fixture also matched a previous failed delivery. Fixture teardown now cancels retained failures; history uses an independent URL. The entire corrected 24-case pipeline passes. The background additionally refuses late source authorization for terminal jobs and rechecks state/execution after asynchronous grants, with a negative browser assertion. Before the live batch refinement, the full sweep passed 95 cases with no failures and four external opt-ins skipped. The added live batch cases initially found the popup/side-panel hiding the batch action for live-only work (25 passed, two failed); their visibility and tooltip now match the batch Stop behavior. The final updated sweep passed all 97 enabled cases, with no failures and four external opt-ins skipped.

## Commands

Run from repository root:

```sh
pnpm --filter chrome-extension test
pnpm type-check
pnpm build
node --import tsx --test 'packages/**/*.test.ts' 'pages/**/*.test.ts'
node --import tsx --experimental-test-module-mocks --test chrome-extension/src/offscreen/lib/hls-download.test.mjs chrome-extension/src/offscreen/download_worker/mux-cancel.test.mjs
VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/resume-m5.test.ts
VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/download-pipeline.test.ts specs/page-popup.test.ts -t 'clears terminal task|shows current-page|separate audio/video|resumes separate|cross-origin'
VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/download-pipeline.test.ts
VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/resume-m4-http.test.ts specs/download-pipeline.test.ts -t '410 without|isolates captured credentials|clear history'
VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/resume-m3.test.ts -t 'live snapshot Pause all'
VIDSY_E2E_AI=off VIDSY_MEDIA_REMUX_E2E=true pnpm -F @extension/e2e e2e
git diff --check
```

ESLint covers download background/worker/offscreen code, shared/storage progress definitions, download row/details, popup/side-panel/settings, acceptance browser fixtures and helpers. The unchanged background logger has a preexisting exports-last lint violation and is outside the modified-file check; no all-repository lint pass is claimed.

## Changed files

Background: `index.ts`; `lib/download-cache.ts` and its test; `lib/download-queue.ts`; `lib/download-runtime.ts` and its test; `lib/download.ts`; `lib/progress.ts`; `lib/source-renewal.ts` and its test.

Offscreen/worker: `index.ts`; `lib/cache-protocol.ts`; `lib/http-download.ts`; `lib/merged-download.ts`; `lib/hls-download.ts` and orchestration test; `lib/dash-download.ts`; `lib/range-probe.ts`; `lib/network-request.ts` and its test; `lib/output-delivery.ts` and new cancellation tests; `lib/opfs-gc.ts`; `download_worker/persistent-artifact.test.ts`; new `lib/storage-persistence.ts` and its test; new `lib/network-cost.ts` and its test.

UI/shared/storage: `packages/storage/lib/impl/media-storage.ts`; `packages/shared/lib/utils/media.ts`; `packages/ui/lib/components/media/DownloadRow.tsx`; `pages/popup/src/Popup.tsx`; `pages/popup/src/views/DownloadDetailsView.tsx`; `pages/side-panel/src/SidePanel.tsx`; `pages/options/src/components/SettingsPanel.tsx`; new `pages/options/src/components/DownloadCachePanel.tsx`.

Browser/documentation: new `tests/e2e/specs/resume-m5.test.ts`; expanded `resume-m3.test.ts`; `resume-m4-http.test.ts` type annotations; adjusted `download-pipeline.test.ts` and `page-popup.test.ts`; README; CHANGELOG; STATUS; archived M4 progress; this acceptance document; global audit and saved evidence. Earlier milestone documents contain their own file lists. Preexisting unrelated dirty work is preserved.

## Manual reproduction and boundaries

Use an isolated unpacked-extension profile and the local fixtures. Pause a half-complete Range download: inspect cached bytes/next offset/remaining payload, restart and Resume, and check that retained payload is not requested again. Queue a second task with concurrency one, Pause all, confirm it never dispatched, then Resume all and confirm one active task at a time. For an active incomplete live snapshot, Pause all must stop its transfer, remove its partial family and keep a visible explanation; it must not silently continue fetching. In settings, inspect usage/persistence, change retention to two days, discard a paused task and check both OPFS and storage.local ownership records are gone. Mark the connection metered: active work pauses and new work is held; explicit Resume completes it, and reconnect alone does not resume it. Stop a no-Range stream and confirm its action explicitly says downloads again. Repeat Stop and completed-input/output recovery for HLS/DASH live snapshots.

On this host Chrome does not expose a reliable connection.type. Cellular reporting is tested through the network-cost event contract, and the real options checkbox verifies the manual fallback. effectiveType=4g is never treated as cellular. No physical Wi-Fi-to-cellular transition or actual host sleep is claimed. Wake/overdue-deadline tests and real suspended-service-worker alarms are recorded in M2. Four external-site tests remain opt-in and are not a live-account acceptance claim. No-Range byte-offset resume and its 1 MiB retransmission bound are objectively unavailable; incomplete direct streams retry in full and segmented sources retry only incomplete parts. Unsupported DASH layouts and AES-128 parts over the existing 32 MiB decryption bound fail explicitly. Native Chrome download semantics are unchanged; re-delivery validates saved output and starts a new native copy.

## Archived evidence

Logs, environment metadata, the exact lint file list, source/bundle fingerprints and a SHA-256 evidence manifest are saved under [m5-2026-11-12](evidence/m5-2026-11-12). Initial failed sweeps and their correction runs remain archived alongside the final passing run. The production source and bundle were unchanged during the final full run.
