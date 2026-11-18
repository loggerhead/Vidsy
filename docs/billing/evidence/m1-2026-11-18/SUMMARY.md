# M1 evidence — 2026-11-18

Scope: billing Worker workspace (`server/`, `@extension/billing-worker`), D1 schema,
device auth, entitlement snapshots, authorize/report with atomic reserve/commit/release.
Mode: local Worker + local D1 (no remote deploy, no Creem calls). Version: `1.1.0`.

## Commands and results

| Command | Exit | Log |
| --- | --- | --- |
| `pnpm -F @extension/billing-worker type-check` | 0 | `type-check.log` |
| `pnpm -F @extension/billing-worker lint` | 0 | `lint.log` |
| `pnpm -F @extension/billing-worker test` | 0 | `test.log` (20 pass, 0 fail) |
| `pnpm type-check` (workspace, 18 packages) | 0 | `workspace-type-check.log` |
| `pnpm lint` (workspace, 18 packages) | 0 | `workspace-lint.log` |
| `wrangler d1 migrations apply uuget-billing --local` | 0 | `d1-migrate-local.log` (26 statements) |
| `wrangler dev --local` + curl smoke | 0 | `wrangler-dev-smoke.log` |

The test runner is `@cloudflare/vitest-pool-workers` (workerd runtime, real D1 binding).
Migrations are applied with `readD1Migrations` + `applyD1Migrations`, so the same SQL file
used by `wrangler d1 migrations apply` is exercised in tests.

## Acceptance mapping

| Acceptance item | Evidence |
| --- | --- |
| Two concurrent requests racing for the last free slot: exactly one succeeds | `lets exactly one of two concurrent requests win the last free slot` — atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE used < limit` trigger, aborting statement rolls back the loser |
| Duplicate authorize for the same key returns the same decision without double charging | `returns the same decision for a duplicate authorize without double charging` (same `authorizationId`, `free.used` stays 1) |
| Reserve → commit keeps the deduction; reserve → release refunds; daily usage stays correct | `commits on success and keeps the free slot consumed`, `releases a zero-byte failure and refunds the free slot`, `reserves, commits and releases credits against the derived balance` |
| Failure/cancel with bytes moved commits (bandwidth spent) | `commits a failure that already downloaded bytes` |
| Duplicate reports are no-ops | `treats duplicate reports as no-ops` |
| Released key retried with the same `downloadKey` re-reserves once | `re-reserves a released download on retry with the same key` |
| Subscription active allows; expired denies; canceled inside the paid period allows | `allows an active subscription without consuming free quota or credits`, `denies an expired subscription`, `keeps access for a canceled subscription until the period ends` |
| Invalid device token → 401 | `rejects an invalid bearer token` |
| Authorize rate limit → 429 | `rate limits authorize calls per device` (test binding: 3/minute/device) |
| `BILLING_ENFORCEMENT=off` allows every download | `allows every download when BILLING_ENFORCEMENT=off is bound`; also `allows every download when the settings kill switch is off` |
| Entitlement snapshot is signed | `registers a device idempotently and returns a signed entitlement snapshot` — verifies ECDSA P-256 over `JSON.stringify(snapshot)` |
| `wrangler dev --local` smoke: health, register, entitlement, 2 free + 402, release, retry, 401, CORS | `wrangler-dev-smoke.log` |

## Implementation notes

- **Atomic reservation via triggers.** `authorizations_free_guard` claims a `daily_usage`
  slot on INSERT with an upsert guarded by `used < free_daily_limit`; zero changed rows
  raises `free_quota_exhausted` and rolls the authorization back. `authorizations_credits_guard`
  appends a `-N` reserve row only when the derived balance covers it, otherwise
  `insufficient_credits`. D1 serializes writes, so the last free slot cannot be double-granted.
- **Settlement.** Success or any non-zero-byte failure/cancellation transitions
  `reserved → committed`; only zero-byte failure/cancellation transitions to `released`.
  `authorizations_release_effects` refunds the free slot and appends a `+N` release ledger row
  exactly once per transition; duplicate reports find a non-reserved row and only read state.
- **Retry.** A released row is re-reserved in place (same `downloadKey`, same
  `authorizationId`) with `created_at` reset to the retry time (so the free slot counts
  against the current UTC day) and monotonic `updated_at`. Ledger refs are suffixed with
  `updated_at` so repeated reserve/release cycles stay unique under the append-only ledger.
- **Source priority.** Subscription → free quota → credits. A subscription reservation spends
  nothing; the kill switch reserves with zero quantities so nothing is consumed.
- **Kill switch.** Off when `env.BILLING_ENFORCEMENT=off` or `settings.billing_enforcement='off'`
  (the setting lets tests and operations toggle without a deploy).
- **Device auth.** Registration stores only `SHA-256(deviceToken)` (hex) and is idempotent for
  the same id+token; reusing either across devices returns 409. Bearer lookup is by token hash.
- **Rate limits.** Fixed-window counters in `rate_limits` keyed by `bucket:<windowStart>`:
  register 10/IP/hour, authorize 60/device/minute (env-overridable).
- **Snapshot.** `GET /v1/entitlement` returns plan/subscription/free/credits plus a
  72h snapshot signed with ECDSA P-256 (`SNAPSHOT_PRIVATE_KEY`, PKCS#8 base64). Signature is
  over the UTF-8 bytes of `JSON.stringify(snapshot)` with the literal field order in
  `server/src/snapshot.ts`; `signature` is `null` when no key is configured (local dev).
- **Scheduled handler.** Commits reservations older than 24h and prunes rate-limit windows.
  This is deployed but not exercised by the M1 test suite.
- **Workspace.** `server` added to `pnpm-workspace.yaml`; `.wrangler/` and `.dev.vars` are
  gitignored. The Worker imports the framework-free shared license module directly
  (`server/src/contract.ts`) so React/Chrome code is not bundled.

## Follow-ups carried into M2

- `server/src/creem.ts`, `/v1/checkout`, `/webhooks/creem`, `/v1/license/activate`,
  `server/src/products.ts` and `docs/billing/creem-setup.md`.
- Replace placeholder D1 `database_id`s in `server/wrangler.toml` before any deploy.
- `@cloudflare/vitest-pool-workers` is deprecated upstream in favor of
  `@cloudflare/vitest-plugin`; tests pass on the current package and can be migrated later.
