# M5 production launch evidence — 2026-11-18

Production resources created and verified by the agent with the owner's explicit
authorization (Creem live mode, Cloudflare account `89a8933410e86f415bb8ceb07b4ea26b`,
zone `uu0uu.com`).

## Creem (live mode)

| productKey | Creem product id | Price | License key |
| --- | --- | --- | --- |
| `credits_10` | `prod_4VOHZYrMiFHIoKZuKZlRUC` | $2.99 one-time | on, limit 3 |
| `credits_50` | `prod_hslFhZpU2VdrMjwQXTRJM` | $6.99 one-time | on, limit 3 |
| `credits_120` | `prod_11t9XIGUlZRFOCsjVh6mJ5` | $9.99 one-time | on, limit 3 |
| `credits_300` | `prod_13aS2HhQtDgbpfAsHKvOR2` | $19.99 one-time | on, limit 3 |
| `pro_monthly` | `prod_7cpU2njsOmprhXknRcioq2` | $4.99/month | on, limit 3 |
| `pro_yearly` | `prod_5hQGkEl57t58CZe2VYOszw` | $39.00/year | on, limit 3 |

- All products use `tax_mode=inclusive`, `tax_category=saas`, `external_id=<productKey>`,
  and return URL `https://uu0uu.com/billing/success`.
- License-key delivery was added through the Creem dashboard (the public API only
  supports `customerCredits` features); activation limit `3` was verified in the
  dashboard for `credits_10` and `pro_monthly`, and the scripted flow set `3` for
  the other four.
- Webhook endpoint `wh_7eNDYzXCPm1faoiFJ7jWNh`
  (`UUGet production billing`) points at `https://billing.uu0uu.com/webhooks/creem`
  and subscribes to `checkout.completed`, `subscription.paid`,
  `subscription.active`, `subscription.scheduled_cancel`,
  `subscription.canceled`, `subscription.expired`, `subscription.paused`,
  `refund.created`, `dispute.created`. The signing secret is stored only in
  `server/.dev.vars` and the Worker secret store.

## Cloudflare

- D1 production `uuget-billing` = `78bcc728-f6f9-455a-ae5f-158fed8e1bcd`
  (APAC); staging `uuget-billing-staging` =
  `9f24683e-d0e6-41b6-8343-8b74b5d1a4c5`. Migrations `0001_init.sql` and
  `0002_license_activations.sql` applied to both.
- Worker `uuget-billing` deployed to the `production` env (version
  `07a308fb-a1a0-4341-a513-b19ad18a3ccb`), custom domain
  `billing.uu0uu.com`, cron `17 * * * *`.
- Worker secrets set: `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`,
  `SNAPSHOT_PRIVATE_KEY`, `SNAPSHOT_KEY_ID=uuget-2026-11`.
- Static site: Cloudflare Pages project `uuget-site`, deployment
  `https://uuget-site.pages.dev`, custom domain `uu0uu.com` (apex CNAME to
  `uuget-site.pages.dev`; the previous origin returned an ICP-filing error
  page).
- GitHub Actions repository variables `WXT_SNAPSHOT_PUBLIC_KEY` and
  `VITE_SNAPSHOT_PUBLIC_KEY` set so CI builds embed the same public key.

## Public pages (all HTTP 200)

| URL | Title |
| --- | --- |
| `https://uu0uu.com/` | UUGet — video and audio downloader for Chrome |
| `https://uu0uu.com/privacy` | UUGet — Privacy Policy |
| `https://uu0uu.com/terms` | UUGet — Terms of Service |
| `https://uu0uu.com/refund` | UUGet — Refund Policy |
| `https://uu0uu.com/pricing` | UUGet — Pricing |
| `https://uu0uu.com/billing/success` | UUGet — Payment complete |

## Extension artifact

- `pnpm build` succeeded; `.output/chrome-mv3/manifest.json` version `1.2.0`.
- `~/Downloads/UUGet` synced; `diff -r .output/chrome-mv3 ~/Downloads/UUGet` clean.
- Built `background.js` contains the snapshot public key
  (`x=kiIRiRVfFA_zPNOvQR984eQfIUaC8jziBpd6E3kh3TI`).
- Artifact scan for `creem_...`, `whsec_`, `SNAPSHOT_PRIVATE_KEY` and
  `BEGIN PRIVATE KEY` found no secrets.

## Production smoke tests

Logs: `smoke.log`, `synthetic-webhook.log`, `synthetic-subscription.log`,
`kill-switch.log`.

- `GET /health` → 200, `version=1.2.0`, `environment=production`.
- `POST /v1/devices/register` → 200; `GET /v1/entitlement` → 200 with a signed
  snapshot (`keyId=uuget-2026-11`).
- `POST /v1/checkout` for `credits_10` → 200 and a live Creem checkout URL
  (`https://www.creem.io/checkout/prod_4VOHZYrMiFHIoKZuKZlRUC/ch_2olbsyVUzNpidfR11wSBDS`).
  No charge was made.
- Webhook without a signature and with a forged signature → 401
  `invalid_signature`.
- `POST /v1/license/activate` with an unknown key → 404 `license_not_found`.
- Signed synthetic `checkout.completed` (HMAC-SHA256 with the production webhook
  secret) → 200; duplicate delivery → 200 `{duplicate:true}`; entitlement then
  reported `credits=10` and a snapshot with `creditBalance=10`.
- Signed synthetic subscription lifecycle: `subscription.active` →
  `plan=pro`; `subscription.scheduled_cancel` → `plan=pro` with status
  `scheduled_cancel`; `subscription.expired` → `plan=free` with status
  `expired`.
- All snapshot signatures in the logs verified with the extension's
  `verifySnapshotSignature` and the embedded public JWK.
- Kill switch: quota-exhausted device got 402 with `billing_enforcement=on`,
  got 200 `source=free` after setting `settings.billing_enforcement='off'`, and
  402 again after restoring `'on'`.
- Synthetic D1 rows (accounts, devices, purchases, ledger, license keys,
  subscriptions, webhook events, rate limits) were deleted after the tests;
  production D1 is back to zero business rows and `billing_enforcement=on`.

## Not yet performed (requires the owner's payment instrument)

- A real live-mode purchase and refund through Creem checkout. The checkout
  session above is ready; completing it needs a card. After payment, the
  `checkout.completed` webhook, credit grant, entitlement and `refund.created`
  reversal must be observed with the real Creem event ids.
- Real license-key activation and customer portal on a purchased account
  (requires a real Creem customer/license key).
- WAF custom rules and alert policies beyond the Worker's built-in rate limits
  and `observability.enabled=true`; the Worker cron and 5xx logs are available in
  Cloudflare observability.
