# M2 acceptance — 2026-11-12

M2 passes its independent acceptance gate. M0–M2 are accepted; M3 is next. The overall goal remains active.

## Behavior

Transient fetch/connection resets, request/header/body timeouts and HTTP 408/429/500/502/503/504 failures keep valid OPFS/checkpoints, enter paused state and persist a recovery deadline. Five automatic attempts use delays of 30, 60, 120, 240 and 480 seconds, checked by a 30-second alarm while work exists; a due attempt may run up to one check interval later. Alarms consult the durable deadline and attempt budget. Offline checks consume the bounded budget without starting an executor. Reconnection advances only automatically paused jobs; manual pause and cancel clear the recovery plan. Processing/integrity/permission/not-found/signed-expiry failures do not become automatic retry loops.

Background owns policy and task state. Worker errors carry an explicit retryability flag through offscreen reports. Network online/offline signals reach background through offscreen runtime messages; transfer pause keeps its cache. A Chrome alarm is registered while queued/running/recovery work exists, removed when idle, and uses persisted deadlines after background suspension or machine wake. The transfer worker's local backoff is abortable so cancellation does not wait for its timer.

## Initial evidence

Core unit/worker integration: 162 passed. All 17 type-check packages passed, production build passed, relevant ESLint passed, orchestration/cancel: eight passed. Real browser dedicated initial run: three passed (30 seconds offline and automatic resume with only missing intervals, cancel during automatic pause with no subsequent source requests and physical/ledger deletion, permanent 403 remains failed). The suspension case also passes: ServiceWorker.stopWorker stops the background, storage reads from the already-open page await a successful result without sending a wakeup message; the saved Chrome alarm resumes and output equals the source fixture. Full browser regression including HEVC: 55 passed, no failures; four existing opt-in external-site cases skipped. The final exhaustion-edge correction was then built and validated independently in a real browser (one passed, four filtered-out cases), with updated core tests, types and lint. No subsequent production changes were made for this gate.

Unit checks recreate the runtime after advancing the clock past a sleep/wake deadline, preserve byte high water marks, enforce all five increasing delays, stop offline checks after exhaustion, reset the budget only on manual Retry, reject stale automatic recovery after user pause/cancel and prevent a late failure from reviving a cancelled task. Classification checks exclude permanent HTTP, storage/permission, processing and integrity errors. Cancellation interrupts a pending worker backoff before its timer fires.

## Commands and manual reproduction

- `pnpm --filter chrome-extension test`
- `pnpm type-check`
- `pnpm build`
- `node --import tsx --experimental-test-module-mocks --test chrome-extension/src/offscreen/lib/hls-download.test.mjs chrome-extension/src/offscreen/download_worker/mux-cancel.test.mjs`
- `VIDSY_E2E_AI=off pnpm --filter @extension/e2e exec vitest run --config vitest.config.ts specs/resume-m2.test.ts`
- `VIDSY_E2E_AI=off VIDSY_MEDIA_REMUX_E2E=true pnpm --filter @extension/e2e exec vitest run --config vitest.config.ts`: 55 passed, no failures, four opt-in external-site cases skipped.
- `VIDSY_E2E_AI=off pnpm --filter @extension/e2e exec vitest run --config vitest.config.ts specs/resume-m2.test.ts -t "final retry"`: one passed on the final build; four other cases filtered out.

Use the dedicated command with `VIDSY_E2E_HEADED=true` to observe the temporary test browser. The first case writes one complete Range interval, makes the browser offline for 30 seconds, waits for automatic paused state and reconnects. The fixture then validates that the saved output exactly equals the original and that completed intervals were requested once. The cancellation case cancels during automatic paused state, reconnects and waits longer than the first deadline to verify no new source request and no retained files/records. The 403 case verifies no automatic recovery plan.

For physical sleep/wake reproduction, start a fixture Range transfer, disconnect network until automatic paused state appears, sleep the machine past its next deadline, reconnect and wake. It must resume automatically from valid cached blocks; manual pause must remain paused. Automated fake-clock and suspended-background evidence does not claim that this host machine was actually put to sleep.

## Changed files and remaining scope

M2 adds background download-recovery policy and state-machine tests plus network-request tests and browser resume-m2 acceptance. It modifies download-runtime/queue, background entrypoint/report forwarding, offscreen network signals/execution reports, worker error protocol/client/main, and timeout test expectations. STATUS, README, CHANGELOG and this acceptance report record behavior. Final logs and source snapshot are in [evidence/m2-2026-11-12](evidence/m2-2026-11-12). The full browser suite precedes the small exhaustion-edge correction, which has separate real-browser, unit/type/build/lint validation; the source hashes identify the final gate state.

M3 segment/live acceptance, M4 enhanced validators/checkpoints/source refresh/delivery and M5 experience/governance remain pending. No-Range partial bytes still require an explained stream restart. No live-stream resume promise is made.
