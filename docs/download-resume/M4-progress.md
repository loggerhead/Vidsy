# M4 implementation progress — archived snapshot

This file records an intermediate 2026-11-12 state. M4 subsequently passed: see [M4 acceptance](M4-acceptance.md). Statements below about pending acceptance describe that earlier snapshot, not current status.

M4 is **not yet accepted**. M0–M3 remain accepted; M5 has not started.

## Implemented and checked

HTTP recovery supports strong ETag, date If-Range plus local hashes/remote boundary samples, and length plus local hashes/remote boundary samples. Weak ETags are additional guards and are never used as If-Range. Internal checkpoints are acknowledged only after OPFS flush and SHA-256 at 1 MiB boundaries. Invalid cached/remote bytes trigger one explained full restart of the affected input.

Output delivery stores a separate metadata/checksum snapshot before publishing its blob. This does not overwrite a passthrough input's source identity. Interrupted native copies revoke their old blob and retain the file. Restart Retry verifies every saved byte and creates a fresh blob; native completion/cancel removes the complete job family even when the original in-memory inventory is gone. The output lease is 24 hours. Expiry removes pure outputs; shared immutable inputs retain their original input lease.

403/410 attempts one source-page reparse per execution attempt. A unique same-origin/path URL from current media elements and the latest captured request headers forms a locator candidate. Before HTTP cache reuse, new validators and total length must match, local hashes must match, and remote boundary samples must match even for strong ETag aliases. Runtime updates are fenced by execution identity and pause/cancel. A closed page, blob-only/custom player, ambiguous candidate or failed renewal preserves valid cache and gives re-detection guidance. The extension cannot independently generate a website's private signature.

Range-capable HLS/DASH media and initialization parts now use 1 MiB internal offsets while remaining atomic complete inputs to mux. Manifest byte ranges map remote coordinates to independent local files. AES-128 stores checkpointed ciphertext in a temporary `.wire` family member, then decrypts and marks only complete plaintext as a completed part. Ciphertext files are removed after verified plaintext completion. Non-Range segments retain completed parts and retry an incomplete part in full; protocol-level byte resume and the 1 MiB retransmission bound are unavailable on those sources. The same limitation applies to non-Range direct streams. No silent byte-resume promise is made.

## Passing evidence so far

- Core unit/worker integration: 193 passed, including actual worker pause cleanup and AES-128 ciphertext reset/decryption. Latest log `/tmp/uuget-m4-unit.log`.
- All 17 workspace type-check packages passed; package/page units: 48 passed. Orchestration/cancel: eight passed. Relevant lint and patch checks passed.
- Production build passed; latest log `/tmp/uuget-m4-build.log`.
- `pnpm -F @extension/e2e e2e specs/resume-m4-http.test.ts`: seven passed, including actual native cancellation followed by browser restart and byte-identical re-delivery without media requests.
- Signed-URL targeted case: one passed; seven filtered out.
- `VIDSY_E2E_AI=off pnpm -F @extension/e2e e2e specs/resume-m0.test.ts specs/resume-m3.test.ts specs/resume-m4-http.test.ts`: 23 passed, no failures. This run covered the eight-case M4 file before the added 410 case and the M3 file before the added large-segment cases.
- New segment helpers cover strong/date/no-validator mode, nonzero manifest byte offsets, fresh-registry restore, local mutation, manifest identity and non-Range atomic fallback.

## Remaining independent gate work

Large HLS/DASH browser cases now pass after fixing pause cleanup to retain acknowledged partial segments. 410 actionable failure, output corruption/cancel/expiry and ciphertext worker tests pass. The full browser regression is running; its 13-case M4 HTTP/delivery file has passed. Final full-regression result and documentation/evidence closure remain. Archive the final logs/hashes and publish M4-acceptance only after all necessary checks pass. M5 remains pending.
