# M2 evidence — Creem checkout, webhook, ledger

Date: 2026-11-18
Environment: macOS, local D1 (`server/.wrangler/state`), workerd via `wrangler dev --local`.
Creem mode: **mocked** (no live or test-mode API key used). See "External acceptance" below.

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `pnpm -F @extension/billing-worker type-check` | exit 0 | `worker-type-check.log` |
| `pnpm -F @extension/billing-worker lint` | exit 0 | `worker-lint.log` |
| `pnpm -F @extension/billing-worker test` | 30 passed (10 Creem + 20 billing) | `worker-test.log` |
| `pnpm type-check` (workspace) | 18/18 tasks successful | `workspace-type-check.log` |
| `pnpm lint` (workspace) | 18/18 tasks successful | `workspace-lint.log` |
| `pnpm wrangler d1 migrations apply uuget-billing --local` | `0002_license_activations.sql` applied (3 statements) | `d1-migrate-local.log` |
| `pnpm build` | success; synced `~/Downloads/UUGet` (manifest `1.1.0`) | `build.log` |
| `diff -r .output/chrome-mv3 ~/Downloads/UUGet` | exit 0 (no differences) | `artifact-diff.log` |
| manifest version | `1.1.0` | `manifest-version.log` |
| secret scan of `.output/chrome-mv3` | no matches for `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`, `CREEM_FETCH`, `creem_test_`, `test-webhook-secret` | `artifact-secret-scan.log` |

## Local runtime smoke (`wrangler dev --local`, port 8790)

`CREEM_WEBHOOK_SECRET=smoke-secret` supplied via `--var`; no Creem API key bound.

| Step | Expected | Observed |
| --- | --- | --- |
| `GET /health` | 200 | `{"ok":true,"service":"uuget-billing",...}` |
| `POST /v1/devices/register` | 200 | `{"ok":true}` |
| `POST /v1/checkout` with no API key | 503 fail-closed | `{"ok":false,"error":"billing_unavailable"}` |
| `POST /webhooks/creem` forged signature | 401, no writes | `{"ok":false,"error":"invalid_signature"}` |
| `POST /webhooks/creem` valid HMAC `checkout.completed` (credits_10) | 200 | `{"ok":true}` |
| `GET /v1/entitlement` after purchase | credits 10 | `credits: 10`, free `0/2` |
| Replay same webhook | duplicate no-op | `{"ok":true,"duplicate":true}` |
| `GET /v1/entitlement` after replay | credits still 10 | `credits: 10` |

Raw transcript: `wrangler-dev-smoke.log`.

## Covered by automated tests (`server/test/creem.test.ts`)

- Checkout payload: `product_id`, `request_id`, `success_url`, `metadata.device_id/product_key`, `x-api-key` header.
- Unknown product key → 400 without a Creem call.
- `checkout.completed` grants credits once; same event id and same order id with a new event id do not double-grant.
- Credits are spendable after the two free downloads (third authorize uses `credits`, balance 9).
- `license_keys[]` stored as hash + last4; `/v1/license/activate` normalizes the key, calls Creem with `instance_name = deviceId`, binds the device, and skips a second Creem call for the same device.
- Activation limit enforced across devices (403, no Creem call).
- Subscription: checkout → `active`; `canceled` keeps access through `current_period_end`; `expired` revokes and the next download is 402 once free quota is exhausted.
- Refund reverses credits once (same event id and new event id for the same order are no-ops); subscription refund revokes the subscription.
- Forged signature → 401 with no `webhook_events` / `purchases` rows.
- `/v1/portal` returns `customer_portal_link` and posts the stored `customer_id`.

## External acceptance (blocked on requirements §10)

The following acceptance items require Creem test-mode credentials and product
ids, which the user has not provided (and production creation is explicitly
forbidden without confirmation):

- A real test-mode `credits_10` purchase through Creem checkout.
- A real test-mode `pro_monthly` purchase, cancellation and expiry via Creem
  dashboard events.
- A real `customer_portal_link` from Creem (route is verified against a mock).

The Worker fails closed (`503 billing_unavailable`) until `PRODUCTS_JSON`,
`CREEM_API_KEY` and `CREEM_WEBHOOK_SECRET` are configured, so no accidental
charges can occur in the current state.

## Redaction

No API keys, webhook secrets, private keys, full license keys or customer
emails are recorded here. The smoke device/order ids are synthetic.
