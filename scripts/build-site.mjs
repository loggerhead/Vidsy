#!/usr/bin/env node
/**
 * Assemble the static uu0uu.com site into ./site for Cloudflare Pages.
 *
 * Canonical policy pages live at the repository root (PRIVACY.html, TERMS.html,
 * REFUND.html) and the checkout success page lives in billing/success.html.
 * Pages serves extensionless URLs (/privacy) from `privacy.html`, which is what
 * the extension links to.
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'billing'), { recursive: true });

copyFileSync(join(root, 'PRIVACY.html'), join(out, 'privacy.html'));
copyFileSync(join(root, 'TERMS.html'), join(out, 'terms.html'));
copyFileSync(join(root, 'REFUND.html'), join(out, 'refund.html'));
copyFileSync(join(root, 'billing', 'success.html'), join(out, 'billing', 'success.html'));

const sharedHead = `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; max-width: 760px; margin: 3.5rem auto; padding: 0 1.25rem; line-height: 1.65; color: #1a1a1a; }
  h1 { font-size: 2rem; margin-bottom: 0.25rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.15rem; margin-top: 2.25rem; }
  .tagline { color: #555; font-size: 1.05rem; margin-top: 0; }
  .card { border: 1px solid #e5e5e5; border-radius: 12px; padding: 1.25rem 1.5rem; margin: 1rem 0; }
  .price { font-size: 1.5rem; font-weight: 600; }
  .muted { color: #666; font-size: 0.92rem; }
  a { color: #0b57d0; }
  nav a { margin-right: 1rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.6rem 0.4rem; border-bottom: 1px solid #eee; }
</style>`;

const index = `<!doctype html>
<html lang="en">
<head>
${sharedHead}
<title>UUGet — video and audio downloader for Chrome</title>
</head>
<body>
<h1>UUGet</h1>
<p class="tagline">Detect and download video and audio streams from the pages you visit.</p>
<div class="card">
  <p>UUGet is a Chrome extension that finds media streams in your browser and saves them locally. Downloading and remuxing happen on your machine — media is never uploaded to us.</p>
  <p><strong>Free:</strong> 2 downloads per UTC day. <strong>Paid:</strong> credit packs and unlimited Pro subscriptions.</p>
  <p><a href="/pricing">See pricing</a> · <a href="mailto:support@uu0uu.com">support@uu0uu.com</a></p>
</div>
<nav>
  <a href="/privacy">Privacy</a>
  <a href="/terms">Terms</a>
  <a href="/refund">Refund policy</a>
  <a href="/pricing">Pricing</a>
</nav>
</body>
</html>
`;

const pricing = `<!doctype html>
<html lang="en">
<head>
${sharedHead}
<title>UUGet — Pricing</title>
</head>
<body>
<h1>Pricing</h1>
<p class="tagline">Simple prepaid credits or unlimited Pro. Prices include applicable tax; the final amount is shown at checkout.</p>
<h2>Credit packs</h2>
<table>
  <tr><th>Credits</th><th>Price</th><th>Per download</th></tr>
  <tr><td>10</td><td class="price">$2.99</td><td>$0.30</td></tr>
  <tr><td>50</td><td class="price">$6.99</td><td>$0.14</td></tr>
  <tr><td>120</td><td class="price">$9.99</td><td>$0.083</td></tr>
  <tr><td>300</td><td class="price">$19.99</td><td>$0.067</td></tr>
</table>
<p class="muted">Credits do not expire while your account exists. Failed downloads that transfer zero bytes do not consume a credit.</p>
<h2>Pro</h2>
<div class="card">
  <p><span class="price">$4.99</span> / month</p>
  <p class="muted">Unlimited downloads while active. Cancel anytime; access continues to the end of the paid period.</p>
</div>
<div class="card">
  <p><span class="price">$39.00</span> / year</p>
  <p class="muted">Unlimited downloads while active. Cancel anytime; access continues to the end of the paid period.</p>
</div>
<p class="muted">Purchases are processed by Creem, the merchant of record. License keys activate on up to 3 devices. See the <a href="/refund">refund policy</a>.</p>
<nav>
  <a href="/">Home</a>
  <a href="/privacy">Privacy</a>
  <a href="/terms">Terms</a>
  <a href="/refund">Refund policy</a>
</nav>
</body>
</html>
`;

writeFileSync(join(out, 'index.html'), index);
writeFileSync(join(out, 'pricing.html'), pricing);
console.log(`site built at ${out}`);
