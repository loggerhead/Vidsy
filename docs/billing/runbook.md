# UUGet billing runbook

Operational procedures for the Cloudflare Worker (`server/`), D1 database and the
extension license client. All SQL below assumes `wrangler d1 execute uuget-billing
--remote --command "..."` (or `--local` for development).

## 1. Reconciliation

### Scheduled sweep (Worker)

`wrangler.toml` registers an hourly cron (`17 * * * *`). The `scheduled` handler:

- commits every `authorizations` row still `reserved` after 24h (conservative:
  the user may have downloaded without reporting; see requirement §6.5);
- prunes `rate_limits` buckets older than 7 days;
- logs `billing_reconcile` with `staleReservationsCommitted` and
  `rateLimitsPruned` when either is non-zero.

Inspect the Worker logs:

```bash
pnpm wrangler tail uuget-billing --format pretty
```

### Extension-side reconciliation

On every service-worker start and every 6h `uuget-license-sync` alarm the
background runs `reconcileLocalState()` then `flushPendingReports()`:

- local reservations older than 24h are marked `committed` (mirrors the Worker);
- pending reports are flushed in order; a failure stops the drain and keeps the
  tail for the next sync;
- `license.reconcile` / `license.reports_flushed` log lines record the backlog.

The License panel shows `offline` and the number of queued reports.

### Manual discrepancy queries

```sql
-- reservations older than 24h that the cron has not committed yet
SELECT id, device_id, download_key, source, created_at, updated_at
  FROM authorizations
 WHERE state = 'reserved' AND updated_at < (unixepoch() * 1000) - 86400000;

-- accounts with negative derived credit balances
SELECT account_id, SUM(delta) AS balance
  FROM credit_ledger
 GROUP BY account_id
HAVING balance < 0;

-- offline backfills recorded from the extension
SELECT id, device_id, download_key, source, state, created_at
  FROM authorizations
 WHERE id LIKE 'auth_%' AND created_at < updated_at
 ORDER BY updated_at DESC
 LIMIT 50;
```

A client with `pendingReports > 0` that never drains usually means the Worker is
unreachable or the device token was revoked. Ask the user to open the extension
and click **Refresh** in the License panel, then check `wrangler tail`.

## 2. Refunds and chargebacks

- Creem sends `refund.created` / `dispute.created` webhooks; `processCreemEvent`
  records a `chargeback` ledger row (`-credits`) and revokes subscriptions. The
  derived balance may go negative by design; later grants offset it.
- Duplicate events are ignored through `webhook_events.id` and the unique
  `(account_id, ref)` constraint.
- Manual refund of an unconsumed credit pack:

```sql
-- find the grant to reverse
SELECT * FROM credit_ledger WHERE ref = 'grant:<order_id>';
-- append the compensating entry (use a unique ref)
INSERT INTO credit_ledger (id, account_id, delta, reason, ref, created_at)
VALUES ('adjust:<order_id>', '<account_id>', -<credits>, 'adjust', 'adjust:<order_id>', unixepoch() * 1000);
```

Never delete ledger rows. Financial history is append-only.

## 3. License keys and device activations

- `POST /v1/license/activate` validates the key, calls Creem with
  `instance_name = deviceId`, and records `license_activations`.
- The default limit is 3 devices per key (`license_keys.activation_limit`).
  A 4th device returns `403 activation_limit_reached`.
- Deactivate a device in the Creem customer portal (the user-facing hint is in
  the License panel). After deactivation, activation on the new device succeeds
  because Creem rejects the old instance binding.
- To force a re-activation slot in an emergency:

```sql
DELETE FROM license_activations WHERE key_hash = '<hash>' AND device_id = '<device_id>';
```

Only do this after confirming the old device is no longer in use; Creem remains
the authority for the license key itself.

## 4. Snapshot signing keys

- The Worker signs the 72h entitlement snapshot with ECDSA P-256
  (`SNAPSHOT_PRIVATE_KEY`, base64 PKCS#8). The extension embeds the matching
  public JWK at build time via `WXT_SNAPSHOT_PUBLIC_KEY`.
- Rotation: generate a new P-256 key pair, set the new `SNAPSHOT_PRIVATE_KEY`
  and `SNAPSHOT_KEY_ID` as Worker secrets, rebuild the extension with the new
  public JWK, and release it. Until users update, their extension rejects the
  new signature and treats the snapshot as missing (offline falls back to the
  local free quota). Rotate only together with an extension release.
- Generate a pair locally:

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});console.log('PRIVATE='+privateKey.export({type:'pkcs8',format:'der'}).toString('base64'));console.log('PUBLIC_JWK='+JSON.stringify(publicKey.export({format:'jwk'})))"
```

## 5. Rollback and kill switch

- **Disable enforcement without redeploying:** set the `billing_enforcement`
  setting to `off`, or set the `BILLING_ENFORCEMENT` Worker variable to `off`:

```bash
pnpm wrangler d1 execute uuget-billing --remote \
  --command "UPDATE settings SET value='off', updated_at=unixepoch()*1000 WHERE key='billing_enforcement'"
```

  With enforcement off, `/v1/download/authorize` allows downloads without
  consuming quota or credits (source `free`, zero reservations). Re-enable by
  setting it back to `on`.

- **Worker rollback:** `pnpm wrangler rollback --env production` (or
  `--env staging`). D1 migrations are additive; no rollback migration is
  required for 0001/0002.
- **D1 recovery:** use Cloudflare's point-in-time restore (Time Travel) to a
  timestamp before the incident:

```bash
pnpm wrangler d1 time-travel restore uuget-billing --timestamp=<unix-ms>
```

## 6. Multiple accounts from multiple emails

Creem identifies customers by email; buying with a different email creates a
second account. v1 does **not** merge accounts automatically.

Manual merge / credit transfer:

```sql
-- 1. inspect both accounts
SELECT id, email, creem_customer_id FROM accounts WHERE email IN ('a@x.com', 'b@x.com');
-- 2. move device bindings to the surviving account
UPDATE devices SET account_id = '<survivor>' WHERE account_id = '<old>';
-- 3. transfer the derived balance with an explicit adjustment pair
INSERT INTO credit_ledger (id, account_id, delta, reason, ref, created_at)
VALUES ('adjust:merge-out:<old>', '<old>', -<balance>, 'adjust', 'adjust:merge-out:<old>', unixepoch()*1000);
INSERT INTO credit_ledger (id, account_id, delta, reason, ref, created_at)
VALUES ('adjust:merge-in:<old>', '<survivor>', <balance>, 'adjust', 'adjust:merge-in:<old>', unixepoch()*1000);
-- 4. mark the old account deleted (keeps purchases for accounting)
UPDATE accounts SET email = 'deleted+<old>@deleted.invalid', creem_customer_id = NULL,
       deleted_at = unixepoch()*1000 WHERE id = '<old>';
```

Record the ticket id in the `ref` values for auditability.

## 7. Account deletion

Users delete their account with `DELETE /v1/account` (device Bearer token) or by
contacting support. The Worker then:

- deletes `license_activations` and revokes license keys for the account;
- expires active subscriptions;
- revokes every device token and clears `devices.account_id`;
- anonymizes the account email and clears `creem_customer_id`, sets `deleted_at`;
- keeps `purchases` and `credit_ledger` as financial records under the
  anonymized account id.

A revoked device token cannot re-register; the user must reinstall the extension
to obtain a new device identity. Support-side deletion uses the same SQL:

```sql
DELETE FROM license_activations
 WHERE key_hash IN (SELECT key_hash FROM license_keys WHERE account_id = '<account_id>');
UPDATE license_keys SET status='revoked', account_id=NULL WHERE account_id='<account_id>';
UPDATE subscriptions SET status='expired', updated_at=unixepoch()*1000 WHERE account_id='<account_id>';
UPDATE devices SET revoked_at=unixepoch()*1000, account_id=NULL WHERE account_id='<account_id>';
UPDATE accounts SET email='deleted+<account_id>@deleted.invalid', creem_customer_id=NULL,
       deleted_at=unixepoch()*1000 WHERE id='<account_id>';
```

## 8. Support checklist

1. Ask for the device id shown in the License panel (never the token).
2. Look up the account: `SELECT * FROM devices WHERE id = '<device_id>';`
3. Check entitlement: `GET /v1/entitlement` with the user's device is not
   possible from support; instead query `daily_usage`, `credit_ledger`,
   `subscriptions` for the account id.
4. Check webhook delivery in the Creem dashboard and `webhook_events`.
5. For restore-purchase issues, confirm the license key exists
   (`license_keys.key_last4`), is active, and has a free activation slot.

## 9. Production launch checklist

Do not perform any step in this section without explicit owner confirmation.
Requirements §10 inputs (product ids, domain, store id, support email, pricing,
refund and zero-byte confirmations) must be settled first.

### Creem and secrets

1. Create the six production products (`credits_10/50/120/300`, `pro_monthly`,
   `pro_yearly`) and set their ids in `PRODUCTS_JSON` for the production env.
2. Point the Creem webhook at `https://<worker-domain>/webhooks/creem` and copy
   the signing secret.
3. Set Worker secrets for the production env:
   `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`, `SNAPSHOT_PRIVATE_KEY`,
   `SNAPSHOT_KEY_ID`; keep `SUPPORT_EMAIL` and `CHECKOUT_SUCCESS_URL` current.
4. Apply D1 migrations to the production database before deploying the Worker.

### Cloudflare edge

1. Attach the custom domain (for example `uuget.uu0uu.com`) to the Worker.
2. Add WAF/rate-limit rules for `/v1/*` and `/webhooks/*`. The Worker already
   rate-limits device requests (`429 rate_limited`); edge rules are the outer
   layer.
3. Enable alerts for Worker 5xx rate, webhook failures, D1 errors and cron
   failures. The hourly cron (`17 * * * *`) logs `billing_reconcile` with
   `staleReservationsCommitted` and `rateLimitsPruned`; alert if it stops
   appearing.
4. Deploy the static pages to `uu0uu.com`: `PRIVACY.html`, `TERMS.html`,
   `REFUND.html`, and `billing/success.html` (served as `/billing/success`).
   The success page intentionally shows no payment result, so it does not need
   the Creem `signature` check; if that ever changes, verify SHA-256 with
   `salt=<apiKey>` before rendering any result.

### Extension release

1. Confirm `BILLING_ENFORCEMENT` is unset (default `on`) in production and that
   the kill switch path is documented for incidents.
2. `pnpm build` (runs `sync:chrome-artifact`), then verify
   `diff -r .output/chrome-mv3 "$HOME/Downloads/UUGet"` is clean and record the
   manifest version (expected `1.2.0`).
3. Smoke test in production with a minimal real purchase: checkout → webhook →
   entitlement → download → refund → reversal. Then test subscription
   open/cancel/expiry and License-Key restore on a second device.
4. Test the kill switch: set `BILLING_ENFORCEMENT=off`, confirm downloads are
   allowed without consuming quota, then restore `on`.
5. Archive logs in `docs/billing/evidence/m5-YYYY-MM-DD/` and update
   `docs/billing/STATUS.md`.

### Rollback

Follow section 5. Keep the previous Worker version and D1 bookmark recorded
before the launch so a failed release can be rolled back without losing ledger
data.

### Launch record — 2026-11-18

Production was launched by the agent with the owner's explicit authorization.

- Creem live products: six, ids in `creem-setup.md` §1; webhook
  `wh_7eNDYzXCPm1faoiFJ7jWNh` → `https://uuget.uu0uu.com/webhooks/creem`.
- Cloudflare account `89a8933410e86f415bb8ceb07b4ea26b`, zone `uu0uu.com`.
- D1 `uuget-billing` (production) = `78bcc728-f6f9-455a-ae5f-158fed8e1bcd`,
  migrations `0001` + `0002` applied.
- Worker `uuget-billing` version `90bed2a8-655b-45df-af15-1399a65f8e43`,
  custom domain `uuget.uu0uu.com`, cron `17 * * * *`.
- Pages project `uuget-site` serves `uu0uu.com` (apex CNAME, proxied).
- Snapshot key `uuget-2026-11`; public JWK embedded in the extension and stored
  in GitHub Actions repo variables for CI builds.
- Extension `1.2.0` built, synced to `~/Downloads/UUGet`, `diff -r` clean.
- Evidence: `docs/billing/evidence/m5-prod-2026-11-18/`.

Outstanding: real live-mode purchase + refund (needs the owner's card), real
license-key restore/portal on that purchased account, and optional WAF custom
rules / alert policies (built-in Worker rate limits and observability are
active).

