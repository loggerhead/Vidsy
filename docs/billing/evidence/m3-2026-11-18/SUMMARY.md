# M3 evidence — extension enforcement + purchase UI

Date: 2026-11-18
Environment: macOS, Node/pnpm workspace, WXT Chrome MV3 build.
Billing backend: local Worker from M1/M2 (not deployed). No Creem credentials used.

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `pnpm -F chrome-extension test` | 220 passed, 0 failed | `extension-test.log` |
| `pnpm -F @extension/billing-worker test` | 30 passed (10 Creem + 20 billing) | `worker-test.log` |
| `pnpm type-check` (workspace) | 18/18 tasks successful | `workspace-type-check.log` |
| `pnpm lint` (workspace) | 18/18 tasks successful | `workspace-lint.log` |
| `pnpm build` | success; synced `~/Downloads/UUGet` (manifest `1.1.0`) | `build.log` |
| `diff -r .output/chrome-mv3 ~/Downloads/UUGet` | exit 0 (no differences) | `artifact-diff.log` |
| manifest version | `1.1.0` | `manifest-version.log` |
| secret scan of `.output/chrome-mv3` | 0 matches for `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`, `creem_test_`, `test-webhook-secret` | `artifact-secret-scan.log` |

## Implementation inventory

Shared:

- `packages/shared/lib/license/messages.ts` — `LICENSE_MESSAGE = { STATUS, REFRESH, CHECKOUT, PORTAL, ACTIVATE }` plus request/response payload types.
- `packages/shared/lib/license/products.ts` — single product catalog (6 products: `credits_10/50/120/300`, `pro_monthly`, `pro_yearly`) shared by extension UI and Worker.
- `packages/shared/lib/license/index.ts` — re-exports messages/products.
- `packages/shared/lib/utils/media-formatters.ts` — optional `DownloadState.paywall` carrying `free/credits/subscription/upgrade`.
- `server/src/products.ts` — now re-exports the shared catalog (no price drift between extension and Worker).

Extension background:

- `chrome-extension/src/background/lib/billing-api.ts` — remote client (`/v1/devices/register`, `/v1/authorize`, `/v1/report`, `/v1/entitlement`, `/v1/checkout`, `/v1/portal`, `/v1/license/activate`), 8s timeout, one 401 re-register retry, `BillingUnavailableError` (fallback-eligible) vs `BillingRequestError` (never fallback).
- `chrome-extension/src/background/lib/license.ts` — remote-first authorize/report with local fallback only for network/timeout/5xx; mirrors server free/credits into the local ledger; pending-report queue for failed remote reports; `syncEntitlement`, `startCheckout`, `openPortal`, `activateLicense`, `flushPendingReports`; `getLocalStatus` exposes plan/offline/deviceId/pendingReports.
- `chrome-extension/src/background/index.ts` — 6h `uuget-license-sync` alarm; `runLicenseSync` flushes pending reports then fetches entitlement; message handlers for all five `LICENSE_MESSAGE` types; checkout/portal open `chrome.tabs.create`; sync runs on install, startup, and service-worker boot.

Enforcement wiring (§6.5):

- `download-queue.ts` — stable key `payload.key ?? crypto.randomUUID()`; `authorizeDownload` runs after duplicate/paused-failed resume detection and before `runtime.submit` in `enqueueDownload`; `resubmitDownload` (`again`) authorizes under the new `requestId`; submit failure reports `failed, bytesDownloaded: 0` to release; `projectSnapshot` reports terminal `success`/`failed`/`cancelled` with actual bytes; `resume` never re-authorizes; `retry` calls `ensureRetryAuthorization` which only re-reserves when the prior attempt is `released`.
- `download.ts` — `PaymentRequiredError` mapped to `{ ok: false, code: 'PAYMENT_REQUIRED', error, free, credits, subscription, upgrade }`.

UI:

- `packages/ui/lib/components/billing/PaywallDialog.tsx` — 402 paywall with `2/2 used today` free quota, credit packs, Pro monthly/yearly, restore entry, manage subscription, privacy link.
- `pages/popup/src/hooks/useMediaPage.ts`, `pages/side-panel/src/hooks/useMediaPage.ts` — map `PAYMENT_REQUIRED` into `downloadState.paywall`; `closePaywall`, `buyProduct`, `restorePurchase`, `manageSubscription`.
- `pages/popup/src/Popup.tsx`, `pages/side-panel/src/SidePanel.tsx` — render `PaywallDialog`.
- `pages/options/src/components/LicensePanel.tsx` — status card, free quota bar, credits, subscription, buy credits/Pro, restore license key, manage subscription, refresh, 3s polling for up to 2 minutes after checkout, privacy/terms links.
- `pages/options/src/Options.tsx` — `'license'` tab with `#license` deep link and `hashchange` listener.
- `pages/options/src/components/Sidebar.tsx` — License nav item.
- `packages/i18n/locales/{en,ko}/messages.json` — 51 license/paywall strings each.

## Behavior verified by automated tests (`license.test.ts`)

- Remote authorize is always used when configured; local authorization records are rewritten with the server's `authorizationId` and reserved counts.
- Only network/timeout/5xx (`BillingUnavailableError` with `allowLocalFallback`) falls back to the local ledger; 401/429/400/malformed responses never grant a download.
- Remote report success skips the pending queue; report failure settles locally and queues a pending report; reporting never throws.
- `flushPendingReports` stops at the first failure and keeps the failing tail.
- Retry re-authorizes only when the previous authorization is `released`; resume never re-authorizes.
- Zero-byte failure/cancel releases; success or bytes > 0 commits.

## External acceptance (blocked on requirements §10)

These M3 acceptance items require a deployed Worker and Creem test-mode products:

- Free user's 3rd download shows the paywall with live `2/2 used today` counters from the Worker.
- Test-mode purchase of 10 credits → 3rd download succeeds, balance 9.
- Active subscription → unlimited downloads with credits unchanged.

The code paths and UI are implemented and covered by type-check/lint/build plus 220 extension tests; the Worker currently fails closed (`503 billing_unavailable`) without `PRODUCTS_JSON`, `CREEM_API_KEY` and `CREEM_WEBHOOK_SECRET`, so no accidental charges are possible.

## Redaction

No API keys, webhook secrets, license keys or customer emails are recorded here. Test device/order ids in logs are synthetic.
