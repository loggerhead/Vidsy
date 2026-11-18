# M0 evidence — 2026-11-18

Scope: shared license contracts, license storage, local free quota, authorize/report integration.
Mode: local only (no billing Worker yet). Version: `1.1.0`.

## Commands and results

| Command | Exit | Log |
| --- | --- | --- |
| `pnpm type-check` | 0 | `type-check.log` |
| `pnpm lint` | 0 | `lint.log` |
| `pnpm -F chrome-extension test` | 0 | `chrome-extension-test.log` (212 pass, 0 fail) |
| `pnpm build` | 0 | `build.log` |
| `diff -r .output/chrome-mv3 "$HOME/Downloads/UUGet"` | 0 | `diff.log` |
| manifest version | `1.1.0` | `manifest-version.log` |

`pnpm -F @extension/billing-worker test` is not applicable to M0 (Worker is created in M1).

## Acceptance mapping

All local-mode assertions are covered by `chrome-extension/src/background/lib/license.test.ts`
(included in the 212 passing tests):

| Acceptance item | Evidence |
| --- | --- |
| First two downloads per UTC day allowed, third returns `PAYMENT_REQUIRED` | `free quota allows two downloads per UTC day and rejects the third` |
| UTC day rollover resets the allowance | `the free allowance resets on the next UTC day` |
| Duplicate `authorize` for one download key reserves once | `duplicate authorize for the same key reserves exactly once` |
| Zero-byte failure releases quota; retry re-reserves the same key once; committed retry does not re-charge | `a zero-byte failure releases the quota and a retry re-reserves the same key once` |
| Failure/cancel after bytes moved is committed | `failed or cancelled attempts with transferred bytes are committed` |
| Credits are used only after the free quota and released on zero-byte failure | `credits are reserved only after the free quota is exhausted and released on zero-byte failure` |
| Duplicate reports are absorbed (no double refund) | `duplicate reports are absorbed without double refunds` |
| Unknown keys never move the ledger | `unknown download keys never move the ledger` |
| Verified subscription snapshot does not spend quota/credits | `a verified subscription snapshot allows downloads without spending quota or credits` |
| Entitlement window helpers | `subscription and snapshot helpers implement the documented entitlement windows` |

Integration points:

- `download-queue.ts`: `authorizeDownload` runs after duplicate-job detection and before
  `runtime.submit` in both `enqueueDownload` and `resubmitDownload`; `retry` calls
  `ensureRetryAuthorization` (re-reserve only when released); `resume` never authorizes;
  `runtime.submit` failures report `failed/0` to release.
- `projectSnapshot` reports terminal outcomes (`success`, `failed`, `cancelled`) with the
  final downloaded byte count.
- `download.ts` maps `PaymentRequiredError` to `{ ok: false, code: 'PAYMENT_REQUIRED', ... }`;
  `background/index.ts` returns the same shape for retry/again control paths.
- Subtitle downloads still return before the queue and are not metered.

## Notes

- Local ledger writes are serialized and quota is written before the authorization record so
  an interrupted write over-charges rather than granting a free download.
- `licenseEntitlementStorage` is populated/verified in M4; M0 keeps `resolveSnapshot` unset,
  so only the local free/credit ledger decides.
- Build artifact synchronized to `~/Downloads/UUGet/`; `diff -r` is clean.
