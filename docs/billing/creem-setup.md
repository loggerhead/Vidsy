# Creem setup (M2)

This is the operator checklist for the UUGet billing Worker. It covers the six
Creem products, license keys, webhook registration, Worker secrets and
test-mode verification. The live-mode products are already created; their ids
are recorded below.

## 1. Products

Create the same six products twice: once in Creem **test mode**, once in live
mode (M5). Prices are in USD and must match `server/src/products.ts`.

| `productKey` | Type | Billing period | Price | Credits | License keys |
| --- | --- | --- | --- | --- | --- |
| `credits_10` | one-time | `once` | `$2.99` | 10 | on, activation limit 3 |
| `credits_50` | one-time | `once` | `$6.99` | 50 | on, activation limit 3 |
| `credits_120` | one-time | `once` | `$9.99` | 120 | on, activation limit 3 |
| `credits_300` | one-time | `once` | `$19.99` | 300 | on, activation limit 3 |
| `pro_monthly` | subscription | `every-month` | `$4.99` | 0 | on, activation limit 3 |
| `pro_yearly` | subscription | `every-year` | `$39.00` | 0 | on, activation limit 3 |

Record the six Creem product ids (`prod_...`) and map them in the
`PRODUCTS_JSON` variable. The Worker treats prices/credits in `products.ts` as
authoritative; Creem only needs to return the same ids.

```json
{
  "credits_10": "prod_xxx",
  "credits_50": "prod_xxx",
  "credits_120": "prod_xxx",
  "credits_300": "prod_xxx",
  "pro_monthly": "prod_xxx",
  "pro_yearly": "prod_xxx"
}
```

`server/wrangler.toml` ships `PRODUCTS_JSON = "{}"` so checkout fails closed
(`503 billing_unavailable`) until the ids are configured.

### Live-mode product ids (created 2026-11-18)

| `productKey` | Live Creem product id |
| --- | --- |
| `credits_10` | `prod_4VOHZYrMiFHIoKZuKZlRUC` |
| `credits_50` | `prod_hslFhZpU2VdrMjwQXTRJM` |
| `credits_120` | `prod_11t9XIGUlZRFOCsjVh6mJ5` |
| `credits_300` | `prod_13aS2HhQtDgbpfAsHKvOR2` |
| `pro_monthly` | `prod_7cpU2njsOmprhXknRcioq2` |
| `pro_yearly` | `prod_5hQGkEl57t58CZe2VYOszw` |

All six use `tax_mode=inclusive`, `tax_category=saas`, `external_id=<productKey>`
and return URL `https://uu0uu.com/billing/success`. These ids are already wired
into the production `PRODUCTS_JSON` in `server/wrangler.toml`. The live webhook
is `wh_7eNDYzXCPm1faoiFJ7jWNh` on `https://billing.uu0uu.com/webhooks/creem`.
The script `server/scripts/create-creem-products.mjs` can re-create or discover
the products; it writes ids to the git-ignored
`server/.env.creem-products.json`.

## 2. License keys

For every product enable **License Key** delivery with activation limit `3`.
Checkout responses then include `license_keys[]`; the Worker stores only
`SHA-256(normalized key)` and the last four characters. The raw key is shown to
the buyer by Creem and can be restored later through
`POST /v1/license/activate` (`instance_name = deviceId`).

## 3. Webhook

Register one endpoint per environment:

```
https://<worker-domain>/webhooks/creem
```

Subscribe to these events (names follow the Creem dashboard; the Worker also
accepts `subscription.trialing`):

- `checkout.completed`
- `subscription.paid`
- `subscription.active`
- `subscription.scheduled_cancel`
- `subscription.canceled`
- `subscription.expired`
- `subscription.paused`
- `refund.created`
- `dispute.created`

Creem signs the raw request body with HMAC-SHA256 and sends the lowercase hex
digest in `creem-signature`. The Worker verifies it in constant time before any
D1 write; invalid signatures return `401` and leave no rows behind.

Idempotency: `webhook_events.id` claims each event. A duplicate delivery
returns `200 {"duplicate":true}`. Business keys are idempotent as well
(`purchases.id = order id`, ledger refs `grant:<order_id>`,
`chargeback:<order_id>`).

## 4. Worker secrets and variables

Secrets (never in `wrangler.toml`, never in the extension):

```bash
cd server
pnpm wrangler secret put CREEM_API_KEY --env staging
pnpm wrangler secret put CREEM_WEBHOOK_SECRET --env staging
pnpm wrangler secret put SNAPSHOT_PRIVATE_KEY --env staging
pnpm wrangler secret put SNAPSHOT_KEY_ID --env staging
```

- `CREEM_API_KEY`: Creem API key for the matching mode (test key for staging).
- `CREEM_WEBHOOK_SECRET`: signing secret shown when the webhook is created.
- `SNAPSHOT_PRIVATE_KEY`: base64 PKCS#8 ECDSA P-256 key used to sign
  entitlement snapshots. The matching public JWK must be embedded in the
  extension at build time via `WXT_SNAPSHOT_PUBLIC_KEY` (or
  `VITE_SNAPSHOT_PUBLIC_KEY`); without it the extension treats every snapshot as
  missing and offline falls back to the local free quota. Key generation and
  rotation are covered in `runbook.md` §4.
- `SNAPSHOT_KEY_ID`: identifier echoed in `/v1/entitlement` as `keyId` for
  rotation bookkeeping.

Non-secret variables (`wrangler.toml`):

- `PRODUCTS_JSON` — product key to Creem product id mapping.
- `CREEM_API_BASE` — `https://api.creem.io`.
- `CHECKOUT_SUCCESS_URL` — `https://uu0uu.com/billing/success`.
- `RATE_LIMIT_CHECKOUT_PER_HOUR` — per-device checkout creation limit (default 10).

Local development can put the same values in `server/.dev.vars` (ignored by
git):

```ini
CREEM_API_KEY=creem_test_xxx
CREEM_WEBHOOK_SECRET=whsec_xxx
PRODUCTS_JSON={"credits_10":"prod_xxx"}
```

## 5. API surface added in M2

| Method | Path | Behaviour |
| --- | --- | --- |
| `POST` | `/v1/checkout` | `{ productKey }` → `{ checkoutUrl }`; writes `metadata.device_id/product_key` and `request_id = <deviceId>:<productKey>:<uuid>` |
| `POST` | `/v1/portal` | Device account's Creem `customer_portal_link` → `{ portalUrl }` |
| `POST` | `/v1/license/activate` | `{ licenseKey }` → activates against Creem (`instance_name = deviceId`), binds the device to the account, returns the entitlement payload |
| `POST` | `/webhooks/creem` | Signature-verified Creem events |

Error codes: `400 invalid_product` / `invalid_license_key`,
`401 invalid_signature`, `403 activation_limit_reached` /
`license_activation_rejected` / `license_inactive`, `404 license_not_found` /
`account_not_found`, `410 license_expired`, `429 rate_limited`,
`503 billing_unavailable`.

## 6. Test-mode verification

1. Configure the six test-mode ids in `PRODUCTS_JSON` and put the test API key
   and webhook secret in staging secrets.
2. Run the Worker tests (mock Creem, no network):

   ```bash
   pnpm -F @extension/billing-worker test
   ```

3. Deploy staging and complete a test purchase with a Creem test card. Confirm:
   - `checkout.completed` grants the credits exactly once (replay the event in
     the Creem dashboard; the second response is `duplicate`).
   - `GET /v1/entitlement` shows the credit balance.
   - `license_keys[]` was saved and `POST /v1/license/activate` binds a second
     device until the activation limit of 3.
   - `pro_monthly` sets the subscription to `active`; canceling keeps access
     until `current_period_end`; `expired` revokes it.
   - `POST /v1/portal` returns a usable portal link.
   - A forged `creem-signature` returns `401` with no D1 writes.

Record event ids/checkout ids (redacted) in
`docs/billing/evidence/m2-YYYY-MM-DD/`.

## 7. Security notes

- The Creem API key and webhook secret live only in Worker secrets. The
  extension never calls Creem directly and never receives these values.
- `CREEM_FETCH` exists only as a test injection hook; do not set it in deployed
  bindings.
- Only the license-key hash and last four characters are stored.
- Refunds/disputes may make the derived credit balance negative; later grants
  offset it (requirements §5).
