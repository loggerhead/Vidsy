# M0 acceptance — 2026-11-12

M0 passes its acceptance gate. The full M0–M5 objective is not complete. Existing user changes were retained; no commit, push or release was performed.

## Results and commands

| Verification | Command | Result |
| --- | --- | --- |
| Core unit and worker/HTTP integration | `pnpm --filter chrome-extension test` | 148 passed; 0 failed or skipped |
| Workspace unit regressions | Python enumerated `.test.ts` files in `packages` and `pages` (excluding node_modules), then ran `pnpm exec tsx --test` with that list | 48 passed; 0 failed or skipped |
| HLS orchestration and mux cancellation | `node --import tsx --experimental-test-module-mocks --test chrome-extension/src/offscreen/lib/hls-download.test.mjs chrome-extension/src/offscreen/download_worker/mux-cancel.test.mjs` | 8 passed; 0 failed or skipped |
| Production extension | `pnpm build` | passed |
| Browser failure/recovery and pipeline regression | `VIDSY_E2E_AI=off pnpm --filter @extension/e2e exec vitest run --config vitest.config.ts specs/download-pipeline.test.ts specs/resume-m0.test.ts` | 29 passed; 0 failed or skipped |
| Workspace types | `pnpm type-check` | 17 packages passed |
| Modified download implementation and browser test lint | ESLint over offscreen, download runtime/queue/adapters, background entrypoint and the two browser specs | passed |
| Patch formatting | `git diff --check` | passed |

Logs and source hashes are in [evidence/m0-2026-11-12](evidence/m0-2026-11-12). Source hashes identify the changed implementation used for this acceptance, including files with preexisting user changes.

## Requirement evidence

- Persistent single-block 403 at 50%: local HTTP worker integration and production browser fixture both retain the first complete range; Retry only requests the missing second interval. The browser checks all visible retry download byte counts against the retained value and compares the downloaded file byte-for-byte with the fixture.
- Mux failure: the production browser test sends one invalid local mux input through the offscreen worker channel, making the real libav invocation fail. HTTP MP3, non-Range stream MP3, separate A/V, HLS and DASH Retry then request zero media bytes. Re-fetched manifests are metadata, not media. ffprobe confirms expected codecs and duration within 0.5 seconds of the 2-second fixture.
- HLS input preservation: orchestration checks retain both fully downloaded inputs on mux failure, and retain completed video when audio transport fails. Atomic segment worker integration retains completed parts only; Retry requests missing parts, and a completed-input retry requests no media.
- Integrity: unit/worker checks reject ETag, total-length, interval, manifest, missing-file and cached-byte changes. Completed-input hashes cover every byte in 1 MiB blocks, including a mutated byte inside the second block of a large test blob. Wrong Range and truncated bodies never become deliverable output.
- Cancel: worker integration, runtime tests and real-browser cancellation release retained files/parts and completion records. Removing a failed task also releases retained inputs. Pause keeps them.
- Progress reporting: a terminal failure carries the last checkpoint even if a coalesced progress report has not reached the background. Runtime and browser tests verify Retry never shows fewer downloaded bytes.

## Human reproduction steps

1. Run the build and browser command above with `VIDSY_E2E_HEADED=true` added to see the isolated test browser. Fixtures are prepared by `pnpm --filter chrome-extension test`; no external website or login is needed.
2. For the 50%/403 case, observe the failed task, its retained half-file progress and error reason. The fixture enables the missing interval, clicks the real Retry button, records storage progress changes and verifies completed ranges are requested once. The output must equal the complete fixture bytes.
3. For mux failures, inspect the five `resume-m0` cases. One mux request gets an invalid local input; the original OPFS input stays unchanged. Retry uses the cached input, the server records no media requests, and ffprobe checks the saved file.
4. For cancellation, the pipeline case cancels an active partial download and queries OPFS through the extension context to verify its related files are gone; queued cancellation produces no source requests.

These steps are automated by the recorded browser run. A separate human-run session is not claimed.

## Limits and next gate

All M0 checkpoints remain session-scoped. Browser restart/extension reload recovery, schema migration, TTL/LRU and reusable resource identities await M1. Automatic recovery, persistent VOD/track ledgers, weak-validator sampling, sub-chunk checkpoints, signed-URL refresh, persistent delivery, and cache/batch/capability UI remain M2–M5. Non-Range transfer Retry must restart with an explicit reason; complete non-Range input still supports processing Retry. Live-stream resume is not supported.

## Changed files

- `chrome-extension/src/background/index.ts`
- `chrome-extension/src/background/lib/download.ts`
- `chrome-extension/src/background/lib/download-queue.ts`
- `chrome-extension/src/background/lib/download-runtime.ts`
- `chrome-extension/src/background/lib/download-runtime.test.ts`
- `chrome-extension/src/offscreen/index.ts`
- `chrome-extension/src/offscreen/download_worker/main.ts`
- `chrome-extension/src/offscreen/download_worker/completed-inputs.ts`
- `chrome-extension/src/offscreen/download_worker/completed-inputs.test.ts`
- `chrome-extension/src/offscreen/download_worker/messages.ts`
- `chrome-extension/src/offscreen/download_worker/output-validation.ts`
- `chrome-extension/src/offscreen/download_worker/range-resume.ts`
- `chrome-extension/src/offscreen/download_worker/range-resume.test.ts`
- `chrome-extension/src/offscreen/download_worker/response-validation.ts`
- `chrome-extension/src/offscreen/download_worker/worker-transport.test.ts`
- `chrome-extension/src/offscreen/download_worker/mux-cancel.test.mjs`
- `chrome-extension/src/offscreen/lib/download-failure.ts`
- `chrome-extension/src/offscreen/lib/download-failure.test.ts`
- `chrome-extension/src/offscreen/lib/http-download.ts`
- `chrome-extension/src/offscreen/lib/merged-download.ts`
- `chrome-extension/src/offscreen/lib/hls-download.ts`
- `chrome-extension/src/offscreen/lib/hls-download.test.mjs`
- `chrome-extension/src/offscreen/lib/dash-download.ts`
- `chrome-extension/src/offscreen/lib/execution-registry.ts`
- `chrome-extension/src/offscreen/lib/execution-registry.test.ts`
- `chrome-extension/src/offscreen/lib/network-request.ts`
- `chrome-extension/src/offscreen/lib/output-delivery.ts`
- `chrome-extension/src/offscreen/lib/worker-client.ts`
- `chrome-extension/src/offscreen/lib/worker-client.test.ts`
- `tests/e2e/specs/download-pipeline.test.ts`
- `tests/e2e/specs/resume-m0.test.ts`
- `README.md`
- `CHANGELOG.md`
- `docs/download-resume/requirements.md` — original complete objective
- `docs/download-resume/STATUS.md` — milestone status
- `docs/download-resume/M0-acceptance.md` and evidence directory — commands, results, reproduction and source hashes
