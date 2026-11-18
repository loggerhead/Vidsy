# M4 evidence — restore purchase, portal, offline grace, reconciliation

Date: 2026-11-18
Environment: macOS, Node/pnpm workspace, WXT Chrome MV3 build.
Billing backend: local Worker from M1/M2 (not deployed). No Creem credentials used.

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `pnpm -F chrome-extension test` | 226 passed, 0 failed | `extension-test.log` |
| `pnpm -F @extension/billing-worker test` | 37 passed (20 billing + 10 Creem + 7 M4) | `worker-test.log` |
| `pnpm type-check` (workspace) | 18/18 tasks successful | `workspace-type-check.log` |
| `pnpm lint` (workspace) | 18/18 tasks successful | `workspace-lint.log` |
| `pnpm build` | success; synced `~/Downloads/UUGet` (manifest `1.1.0`) | `build.log` |
| `diff -r .output/chrome-mv3 ~/Downloads/UUGet` | exit 0 (no differences) | `artifact-diff.log` |
| manifest version | `1.1.0` | `manifest-version.log` |
| secret scan of `.output/chrome-mv3` | 0 matches for `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`, `creem_test_`, `test-webhook-secret`, `SNAPSHOT_PRIVATE_KEY` | `artifact-secret-scan.log` |

## Implementation inventory

Shared:

- `packages/shared/lib/license/verify.ts` — `canonicalSnapshotJson` (field order is the signing contract), `verifySnapshotSignature` (ECDSA P-256 / SHA-256 over canonical JSON, fails closed on malformed input), `parseSnapshotPublicKey` (accepts only EC/P-256 JWK with `x`/`y`).
- `packages/shared/lib/license/types.ts` — `AuthorizationRecord.offline?`, `OfflineReservation { source, freeReserved, creditsReserved, authorizedAt }`, `PendingReport.offline?`.
- `packages/shared/lib/license/index.ts` — re-exports verify helpers and offline types.

Extension background:

- `chrome-extension/src/background/lib/license.ts`
  - `createSnapshotResolver({ publicKey, deviceId, now })` — verifies the signature, enforces device match and `v === 1`, stamps `verifiedAt`; expired or unverifiable snapshots resolve to `null`.
  - Offline fallback (`offlineFallback`): free quota is capped by `min(localRemaining, limit - snapshot.freeUsed)`; credits require a verified snapshot when a remote is configured (`max(localCredits, snapshot.creditBalance)`); the authorization record and verdict carry `offline: true`.
  - `enqueuePendingReport(input, bytes, offline?)` — report failures (`state: 'unknown'`) or transport errors persist the offline reservation for later backfill.
  - `flushPendingReports()` — replays queued reports with the `offline` payload.
  - `reconcileLocalState()` — commits locally reserved records older than `STALE_RESERVATION_MS` (24h); returns `{ pendingReports, staleCommitted }`.
  - Singleton wires `resolveSnapshot` from `WXT_SNAPSHOT_PUBLIC_KEY` / `VITE_SNAPSHOT_PUBLIC_KEY`; exports `reconcileLocalState`.
- `chrome-extension/src/background/lib/billing-api.ts` — `report` accepts an optional `offline` reservation and forwards it in the request body.
- `chrome-extension/src/background/index.ts` — `runLicenseSync` runs `reconcileLocalState()` first, logs `license.reconcile` when it has pending/stale work, then flushes pending reports and syncs entitlement.
- `pages/options/src/components/LicensePanel.tsx` — restore row now shows `licenseRestoreHint` (3-device limit, deactivate guidance).
- `packages/i18n/locales/{en,ko}/messages.json` — added `licenseRestoreHint`.

Worker:

- `server/src/db.ts`
  - `insertOfflineAuthorization` — idempotent on `(device_id, download_key)`; explicit `daily_usage` increment allowing free usage beyond the limit; credit ledger `reserve` row may drive the balance negative (offset by later grants).
  - `revokeDevice` — marks device revoked.
  - `deleteAccountData` — deletes activations, revokes license keys, expires subscriptions, revokes devices, anonymizes account email/customer id.
- `server/src/auth.ts` — `registerDevice` rejects revoked rows with `409 device_conflict`.
- `server/src/index.ts`
  - `POST /v1/download/report` parses optional `offline` (`source`, `freeReserved`, `creditsReserved`, `authorizedAt`, clamped 0/1), validates it (`400` on malformed), and backfills via `insertOfflineAuthorization` when `state === 'unknown'`; response includes `{ ok: true, state, retroactive: true }`.
  - `DELETE /v1/account` (device bearer) — account deletion via `deleteAccountData`; `/v1/account` is gated by `requireDevice`.
  - Scheduled handler logs `billing_reconcile` with stale-reservation/rate-limit counts.
- `server/wrangler.toml` — `[triggers] crons = ["17 * * * *"]` for default, staging, production.
- `server/test/m4.test.ts` — 7 M4 tests.

Docs:

- `docs/billing/runbook.md` — reconciliation, refunds/chargebacks/negative balance, license activations/deactivate, snapshot key rotation, kill switch/rollback/D1 time travel, multi-email manual merge, account deletion, support checklist.

## Behavior verified by automated tests

Extension (`license.test.ts`, 24 license tests total, M4 additions):

- Valid snapshot signature verifies; tampered payload and wrong key fail closed.
- Resolver rejects device mismatch and missing/invalid public key; successful resolution stamps `verifiedAt`.
- Offline fallback grants snapshot credits and caps free quota at `limit - snapshot.freeUsed`.
- Expired or missing snapshot grants no credits (falls back to local free quota only).
- Offline report is queued with reservation metadata and replayed with the `offline` payload on flush.
- `reconcileLocalState` commits reservations older than 24h and reports `pendingReports` / `staleCommitted`.

Worker (`m4.test.ts`):

- Offline credit backfill is idempotent (repeat report does not double-charge).
- Offline free usage may exceed the daily limit without a charge error.
- Zero-byte offline failure does not charge.
- Malformed `offline` payload returns 400.
- Account deletion revokes devices, expires subscriptions, revokes license keys, deletes activations, anonymizes the account.
- Device-only deletion path works.
- Stale reservation sweep commits expired reservations.

Activation limit (4th device → `403 activation_limit_reached`) is covered in `creem.test.ts` (activation limit 1 scenario: second activation rejected; extension surfaces the error).

## External acceptance (blocked on requirements §10)

These M4 acceptance items need a deployed Worker and Creem test mode:

- Restoring a real Creem License Key on a new device through the License panel.
- Live `customer_portal_link` from `/v1/portal`.
- 72h offline window observed with real DevTools offline toggling and a Worker-signed snapshot (local tests use synthetic signed snapshots with an in-test key pair).
- End-to-end pending-report backfill after reconnect against the deployed D1.

The code paths are implemented and covered by type-check/lint/build plus 226 extension tests and 37 Worker tests.

## Redaction

No API keys, webhook secrets, license keys, customer emails or snapshot private keys are recorded here. Test device/order ids and the in-test signing key are synthetic.
