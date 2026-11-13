# M1 acceptance — 2026-11-12

M1 passes its independent acceptance gate. M0 and M1 are accepted; M2 implementation is next. The overall M0–M5 objective remains active. Existing user edits are preserved; no commit, push or release.

## Implementation

Versioned task runtime (schema 2), progress projection (schema 1) and input ledger (schema 1) persist in storage.local. Migration imports the existing session runtime/progress once and removes legacy keys, while rejecting unsupported schemas. Background owns ledger updates; offscreen and the single download worker use acknowledged runtime RPC. A completed-range checkpoint is committed after OPFS flush and before reporting completion. Concurrent range completions merge into the ledger.

Resource matching uses the URL pair, kind, output format and normalized captured headers to locate a retained task, then validates its content fingerprint (source URL, strong ETag, size/range layout or manifest/track identity). Titles and filenames do not change source identity. Header/account and output/track differences cannot share checkpoints. Canonical fingerprints and semantic range-source comparison remain valid after Chrome reorders dictionary keys.

Startup restores retained interrupted work as paused and preserves its downloaded-byte high water mark. Resume all is available in popup and side panel. Redetection continues the original task key after validation and displays the retained starting percentage. Complete inputs have all-byte SHA-256 hashes in 1 MiB blocks; media bytes are never trusted merely because an OPFS file exists.

GC retains valid owned files for a configurable default 7-day lease, evicts whole input sets by capacity LRU, protects active work and paused delivery, and removes expired, unknown or unverifiable files. Default capacity is 85% of available quota, with a 5 GiB fallback. Cancel after restart opens the cleanup offscreen if necessary and immediately removes files and ledger entries. A 15-minute alarm also collects idle cache; transient offscreen cleanup closes when idle.

## Results and commands

| Verification | Command | Result |
| --- | --- | --- |
| Core unit and worker/HTTP integration | `pnpm --filter chrome-extension test` | 157 passed; 0 failures/skips |
| Workspace units | Enumerate package/page `.test.ts` outside node_modules, run `pnpm exec tsx --test` | 48 passed; 0 failures/skips |
| HLS orchestration and mux cancellation | `node --import tsx --experimental-test-module-mocks --test chrome-extension/src/offscreen/lib/hls-download.test.mjs chrome-extension/src/offscreen/download_worker/mux-cancel.test.mjs` | 8 passed |
| Workspace types | `pnpm type-check` | 17 packages passed |
| Build | `pnpm build` | passed |
| Dedicated real-browser acceptance | `VIDSY_E2E_AI=off pnpm --filter @extension/e2e exec vitest run --config vitest.config.ts specs/resume-m1.test.ts` | 7 passed; 0 failures/skips |
| Full browser regression including HEVC remux | `VIDSY_E2E_AI=off VIDSY_MEDIA_REMUX_E2E=true pnpm --filter @extension/e2e exec vitest run --config vitest.config.ts` | 51 passed; 0 failed; 4 opt-in external-site cases skipped (no live-account run claimed) |
| Relevant ESLint and `git diff --check` | Download modules and affected specs | passed, including final fixture changes and documentation patch check |

Logs and source hashes are in [evidence/m1-2026-11-12](evidence/m1-2026-11-12). The manifest lists source files used by the current acceptance, including affected files with preexisting edits.

## Dedicated acceptance evidence and human reproduction

Run the dedicated browser command above with `VIDSY_E2E_HEADED=true` to observe the isolated test profile. Local fixtures require no external account. The seven recorded tests perform these checks:

1. Pause at half a Range file, close and restart Chromium with the same temporary profile, inspect restored progress and click Resume all. Server media requests cover only the missing interval; final bytes equal the fixture.
2. Kill the isolated browser abruptly with SIGKILL after a durable checkpoint. The test verifies its temporary user-data-dir before identifying/killing the browser PID. Reopen that profile; interrupted work is paused and resumes only missing bytes.
3. Invoke the actual extension-manager reload under developer mode, reconnect to its worker and continue the original cached job. Retained intervals are not fetched again.
4. Redetect the same source under a new detection identity. Download reuses the original request key and displays the retained percentage before continuing. Output identity/length is checked.
5. Age a paused lease beyond TTL, collect and inspect OPFS plus storage.local: related files and checkpoint records are gone, with an actionable expired-cache reason retained in the task.
6. Set a capacity budget for two paused input sets, collect and verify the oldest whole set disappears while the newer checkpoint and physical file remain.
7. Restart a paused browser and cancel: neither job files nor checkpoint entries remain.

These steps are automated by the recorded browser tests. A separate human session is not claimed. Unit/integration cases also reject unsupported schemas, invalid fingerprints, ETag/length/range changes and mutated cached inputs, and verify concurrent completion merging and account/format isolation.

## Limits

M2 automatic recovery, M3 complete VOD/independent-track/live acceptance, M4 weak validators/sub-chunk offsets/signed-URL refresh/persistent delivery and M5 capability/cache/metered/batch UI remain pending. No-Range partial transfer must restart with an explicit reason; complete input supports processing Retry. Partial HTTP resume still requires a strong ETag. Final browser delivery artifacts remain session-scoped. Default TTL/configuration exists in the backend; the user-facing cache settings are M5.

## Changed files

The exact source list is [source-sha256.txt](evidence/m1-2026-11-12/source-sha256.txt). M1 adds cache ledger/store, persistence migration, resource identity, worker/offscreen cache RPC and canonical cache protocol; modifies background runtime/queue/download/progress and cache alarms, offscreen GC/HTTP/Range/worker paths, shared storage/progress fields and popup/side-panel Resume all. It adds cache/migration/identity/Range/browser restart tests and migrates existing progress fixtures/getters from session to local. README, CHANGELOG and STATUS document the accepted capability and remaining milestone limits.
