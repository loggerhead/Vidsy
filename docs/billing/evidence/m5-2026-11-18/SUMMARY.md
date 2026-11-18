# M5 evidence — production launch prep

Date: 2026-11-18
Environment: macOS, Node/pnpm workspace, WXT Chrome MV3 build.
Production actions (Creem live products, Worker deployment, domain, real purchase)
were intentionally NOT performed; they require explicit owner confirmation and
the requirements §10 inputs.

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `pnpm -F chrome-extension test` | 226 passed, 0 failed | `extension-test.log` |
| `pnpm -F @extension/billing-worker test` | 39 passed (22 billing + 10 Creem + 7 M4) | `worker-test.log` |
| `pnpm type-check` (workspace) | 18/18 tasks successful | `workspace-type-check.log` |
| `pnpm lint` (workspace) | 18/18 tasks successful | `workspace-lint.log` |
| `pnpm build` | success; synced `~/Downloads/UUGet` (manifest `1.2.0`) | `build.log` |
| `diff -r .output/chrome-mv3 ~/Downloads/UUGet` | exit 0 (no differences) | `artifact-diff.log` |
| manifest version | `1.2.0` | `manifest-version.log` |
| secret scan of `.output/chrome-mv3` | 0 matches for `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`, `creem_test_`, `test-webhook-secret`, `SNAPSHOT_PRIVATE_KEY` | `artifact-secret-scan.log` |
| kill switch test | `billing.test.ts:350` allows every download when `BILLING_ENFORCEMENT=off` | `kill-switch-test.log` |
| policy pages present | `PRIVACY.html`, `TERMS.html`, `REFUND.html`, `billing/success.html` | `policy-pages.log` |

## Implementation inventory

Release:

- Version bumped to `1.2.0` across every workspace `package.json`
  (`pnpm update-version 1.2.0`) and in the manifest source `wxt.config.ts`
  (`manifest.version`). Built manifest reports `1.2.0`.
- `README.md` — new "Billing and licensing (v1.2.0)" section (free quota,
  credits, Pro, restore, offline grace, data/deletion, policy links) and a
  billing feature bullet.
- `CHANGELOG.md` — `1.2.0 — 2026-11-18` with a billing subsection and the
  existing download-recovery notes moved under the same release.

Policy pages and links:

- `PRIVACY.html` — billing data section (anonymous device ID, token hash, Creem
  purchase email, purchase/subscription state, usage counters, license
  activations), Cloudflare/D1 processing, 72h signed snapshot, offline report
  queue, account deletion path, support email; the previous "no financial data"
  and "no developer servers" claims were corrected.
- `TERMS.html` — service description, free quota, credits, subscriptions,
  License-Key device limit, acceptable use, availability, liability, contact.
- `REFUND.html` — zero-byte rule, credit packs, subscription cancellation,
  statutory rights, chargeback/negative-balance behavior, request process.
- `billing/success.html` — static `/billing/success` return page. It shows no
  payment result, so the Creem `signature` check is not applicable; the page
  says payment is complete and to return to UUGet.
- `packages/ui/lib/components/billing/PaywallDialog.tsx` — Privacy, Terms and
  Refunds links before checkout.
- `pages/options/src/components/LicensePanel.tsx` — Refunds link added next to
  Privacy and Terms.
- `packages/i18n/locales/{en,ko}/messages.json` — `paywallTerms`,
  `paywallRefund`, `licenseRefund`.

Operations:

- `docs/billing/runbook.md` — new "Production launch checklist" covering Creem
  products/webhook/secrets, production D1 migrations, custom domain, WAF/edge
  rate limits, alerts (5xx, webhook, D1, hourly `billing_reconcile` cron), static
  page deployment, extension build/diff/version, production smoke tests and
  rollback.
- Kill switch already implemented: `BILLING_ENFORCEMENT=off` in the Worker env
  or `billing_enforcement=off` in D1 settings makes `/v1/download/authorize`
  allow downloads without consuming quota or credits; all three `wrangler.toml`
  environments default to `on`.
- Cross-boundary snapshot contract test: a Worker test verifies the live
  `/v1/entitlement` signature with the extension's exact
  `canonicalSnapshotJson` / `verifySnapshotSignature` helpers (including a
  tampered-snapshot rejection), and a CORS preflight test covers the
  `https://uu0uu.com` and `chrome-extension://` origins.

## Blocked on requirements §10 / owner confirmation

Not performed, by design:

- Creating Creem production products or switching to live mode.
- Setting production Worker secrets (`CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`,
  `SNAPSHOT_PRIVATE_KEY`, `SNAPSHOT_KEY_ID`) and deploying the Worker.
- Applying D1 migrations to the production database.
- Attaching the custom domain (`billing.uu0uu.com` proposed) and configuring
  WAF/alerts.
- Publishing `PRIVACY.html` / `TERMS.html` / `REFUND.html` /
  `billing/success.html` to `uu0uu.com` (site deployment is outside this repo).
- The M5 acceptance purchase/refund/subscription/restore smoke tests against
  production Creem, and the final all-green STATUS with live evidence.
- Owner/legal confirmation of the policy text. `TERMS.html` / `REFUND.html`
  describe the implemented behavior (2/day free quota, credits do not expire,
  zero-byte downloads are not charged, subscription cancellation at period end);
  requirements §10 items 5–7 still need explicit sign-off before publishing.

## Redaction

No API keys, webhook secrets, license keys, customer emails or snapshot private
keys are recorded here.
