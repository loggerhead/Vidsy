# M4 acceptance — 2026-11-12

M4 passes its independent acceptance gate. M0–M4 are accepted; M5 is next. The overall goal remains active.

## Behavior and validation

HTTP recovery uses exact strong ETag, or Last-Modified date If-Range plus local SHA-256 and remote boundary samples, or total length plus local SHA-256 and remote boundary samples. Weak ETags are extra change guards, never If-Range. Each retained interval is checked before appending bytes. Cache/remote mutation, response coordinates, validator and length mismatches reject reuse; HTTP performs at most one explained restart of the affected input and retains other valid input bytes. Older completed Range records without durable block hashes cannot silently migrate into trusted resumed bytes.

HTTP and Range-capable HLS/DASH media/init connections persist offsets at 1 MiB boundaries after write/flush/hash/ledger acknowledgement. A reset or pause loses at most one unacknowledged MiB per Range connection. Manifest byte ranges retain remote coordinates while writing separate local segment files. Partial segment checkpoints survive pause cleanup and browser restart. Segments become mux inputs only after atomic completion and full local hashes. AES-128 checkpoints ciphertext first, then publishes complete decrypted plaintext; ciphertext cache is removed after successful plaintext completion.

403/410 tries one original-page reparse per execution attempt. A unique same-origin/path player URL and latest captured headers are locator candidates. HTTP adoption requires matching validators/length, local hashes and remote boundary samples, including for strong ETag aliases. The background persists the updated execution and refreshes DNR; the offscreen executor restores header-origin scoping. Cross-origin request Range/If-Range controls survive filtering while source credentials stay scoped. A failed refresh or missing/ambiguous source page preserves cache and shows re-detection guidance with the original status. Live transport never receives this automatic renewal/restart path. HLS/DASH retain strict manifest/track fingerprints; changed identity still triggers their existing explained restart rather than unsafe concatenation.

Delivery persists metadata and a full-file 1 MiB checksum vector before publishing a Blob. Its separate snapshot preserves the original immutable input identity for passthrough. A native interruption revokes the old Blob and retains the output. Restart Retry validates all bytes before a fresh delivery; corrupted output cannot be published and the next Retry regenerates valid bytes. Native completion/cancel removes the entire owned family even if the old inventory is absent. Output metadata expires after 24 hours. Pure expired outputs are collected; shared inputs keep their original independent lease and can regenerate a delivery without network payload.

## Protocol limits and degradation

A server that does not honor Range cannot resume by offset or guarantee the 1 MiB retransmission bound. Direct streams retry from the beginning; segmented sources retain complete atomic parts and retry only the incomplete part in full. This is a protocol limitation, not a claimed byte-resume capability. AES-128 complete decryption currently has a 32 MiB per-segment processing bound. Sources available only as blob/custom-player state, an unavailable original page, a changed CDN/path or ambiguous candidates cannot be generically re-signed by the extension: failed reparse retains cache and directs the user to refresh/re-detect. Native Chrome downloads retain their own existing semantics; saved artifact delivery creates a fresh copy.

## Test results

- Core unit and worker integration: 195 passed. Includes real reset checkpoints, Date/weak dispatch, checksum mutation, legacy checkpoint rejection, segment pause-cleanup retention, AES-128 ciphertext reset/decryption, renewal policy/identity fencing and cross-origin protocol-header isolation.
- Package/page units: 48 passed. Orchestration/mux-cancel: eight passed.
- All 17 type-check packages, production build, relevant lint and patch checks passed.
- Final combined browser regression of M0/M3/M4: 30 passed, no failures (five M0, twelve shared M3/segment cases, thirteen HTTP/delivery cases).
- Latest URL/header renewal: two passed; twelve other cases filtered out. Both URL rotation and same-URL expired headers perform one reparse, keep verified cached intervals and deliver byte-identical output without repeating retained payload.
- Latest HLS/DASH manifest-expiry checks: two passed; twelve other cases filtered out. Expired manifests keep complete cached parts and show re-detection guidance without media requests.
- Initial full browser sweep: 78 passed, three failed, four existing opt-in external-site cases skipped. Failures were (1) omitted 403 status in refresh guidance, (2) filtering worker Range controls on a cross-origin rendition, and (3) a queue-release fixture expecting a new identity for the same URL after artifact retention. The status/filtering were fixed and the fixture now uses an independent resource to verify slot release. All three passed in the targeted correction run. The later 30-case combined run also passed. This is not described as a zero-failure initial full run; M5 will perform the final whole-suite sweep.

Commands:

- `pnpm --filter chrome-extension test`
- `node --import tsx --test 'packages/**/*.test.ts' 'pages/**/*.test.ts'`
- `node --import tsx --experimental-test-module-mocks --test chrome-extension/src/offscreen/lib/hls-download.test.mjs chrome-extension/src/offscreen/download_worker/mux-cancel.test.mjs`
- `pnpm type-check`
- `pnpm build`
- Relevant changed-file ESLint and `git diff --check`
- `VIDSY_E2E_AI=off VIDSY_MEDIA_REMUX_E2E=true pnpm -F @extension/e2e e2e`
- `VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/download-pipeline.test.ts specs/resume-m2.test.ts -t 'does not forward|releases a finalizing|persistent 403 stays'`
- `VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/resume-m0.test.ts specs/resume-m3.test.ts specs/resume-m4-http.test.ts`
- `VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/resume-m3.test.ts -t 'expired manifest'`
- `VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/resume-m4-http.test.ts -t 'expired request headers|expired signed URL'`

## Changed files

Background: `index.ts`, `download-cache.ts`, `download-runtime.ts`, `download-queue.ts`, `download.ts`, and new `source-renewal.ts` with tests. Worker: `main.ts`, `messages.ts`, `opfs.ts`, `range-resume.ts`, `response-validation.ts`, new `range-fetch.ts`, `segment-checkpoints.ts`, `persistent-artifact.ts`, and associated Range/worker transport tests. Offscreen libraries: new `http-validator.ts`, plus `range-probe.ts`, `http-download.ts`, `worker-client.ts`, `cache-protocol.ts`, `output-delivery.ts`, `blob-cleanup.ts`, `opfs-gc.ts`, `network-request.ts`, `merged-download.ts`, their focused tests, and offscreen `index.ts`. UI/shared/storage validation fields and labels: `media-storage.ts`, shared `media.ts`, `DownloadRow.tsx`, `DownloadDetailsView.tsx`. Browser fixtures: new `resume-m4-http.test.ts`, expanded `resume-m3.test.ts`, and adjusted `download-pipeline.test.ts`. Documentation: README, CHANGELOG, STATUS, M4 progress/acceptance and saved evidence.

## Reproduction and evidence

Use the local fixture suites above; they create isolated unpacked-extension profiles and remove them afterwards. To reproduce manually with an equivalent local fixture, download half a Range file, pause, restart Chrome, and Resume: only missing payload intervals plus bounded validation samples should be requested. Repeat for Last-Modified and validator-free modes, then mutate a boundary/cached byte and confirm an explained restart and byte-identical final output. For a large HLS/DASH part, interrupt after 1.5 MiB; its next payload request begins at 1 MiB. For signature expiry, change the original page's player URL or captured authorization once, then Retry; a failed or unavailable reparse keeps the cache and shows re-detection guidance. Cancel an actual native save after artifact creation, restart, Retry, and compare the delivered bytes; then test output mutation, expiry and cancel cleanup.

Evidence is under [m4-2026-11-12](evidence/m4-2026-11-12). No live-account run, actual host sleep, commit, push or version change is claimed. M5 cache management, metered-network policy, preflight/paused details and batch Pause all remain pending.
