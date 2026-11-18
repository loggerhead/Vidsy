#!/usr/bin/env node
/**
 * Create (or discover) the six live Creem products for UUGet.
 *
 * Reads CREEM_API_KEY from the environment. Run it with:
 *   cd server && set -a && . ./.dev.vars && set +a && node scripts/create-creem-products.mjs
 *
 * Writes ids to server/.env.creem-products.json (gitignored, never committed).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outFile = join(root, '.env.creem-products.json');

const apiKey = process.env.CREEM_API_KEY;
if (!apiKey) {
  console.error('CREEM_API_KEY is required');
  process.exit(1);
}
const base = process.env.CREEM_API_BASE ?? 'https://api.creem.io';

const products = [
  { key: 'credits_10', name: 'UUGet 10 Credits', description: '10 download credits for UUGet. One credit unlocks one paid download.', price: 299, billing_type: 'onetime' },
  { key: 'credits_50', name: 'UUGet 50 Credits', description: '50 download credits for UUGet. One credit unlocks one paid download.', price: 699, billing_type: 'onetime' },
  { key: 'credits_120', name: 'UUGet 120 Credits', description: '120 download credits for UUGet. One credit unlocks one paid download.', price: 999, billing_type: 'onetime' },
  { key: 'credits_300', name: 'UUGet 300 Credits', description: '300 download credits for UUGet. One credit unlocks one paid download.', price: 1999, billing_type: 'onetime' },
  { key: 'pro_monthly', name: 'UUGet Pro (Monthly)', description: 'Unlimited UUGet downloads, billed monthly. License key activates up to 3 devices.', price: 499, billing_type: 'recurring', billing_period: 'every-month' },
  { key: 'pro_yearly', name: 'UUGet Pro (Yearly)', description: 'Unlimited UUGet downloads, billed yearly. License key activates up to 3 devices.', price: 3900, billing_type: 'recurring', billing_period: 'every-year' },
];

const headers = { 'x-api-key': apiKey, 'content-type': 'application/json' };

const listProducts = async () => {
  const res = await fetch(`${base}/v1/products/search?page_number=1&page_size=100`, { headers });
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.items ?? [];
};

const existing = await listProducts();
const byExternal = new Map(existing.filter((p) => p.external_id).map((p) => [p.external_id, p]));
const result = {};

for (const product of products) {
  const found = byExternal.get(product.key);
  if (found) {
    result[product.key] = found.id;
    console.log(`${product.key}: existing ${found.id} (${found.mode})`);
    continue;
  }
  const payload = {
    name: product.name,
    description: product.description,
    price: product.price,
    currency: 'USD',
    billing_type: product.billing_type,
    ...(product.billing_period ? { billing_period: product.billing_period } : {}),
    tax_mode: 'inclusive',
    tax_category: 'saas',
    external_id: product.key,
    default_success_url: 'https://uu0uu.com/billing/success',
    metadata: { productKey: product.key, app: 'uuget' },
  };
  const res = await fetch(`${base}/v1/products`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': `uuget-${product.key}-v1` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`${product.key}: create failed ${res.status} ${text}`);
    process.exitCode = 1;
    continue;
  }
  const created = JSON.parse(text);
  result[product.key] = created.id;
  console.log(`${product.key}: created ${created.id} (${created.mode})`);
}

const doc = {
  _note: 'Local only, gitignored via **/.env*. Created by scripts/create-creem-products.mjs',
  mode: 'prod',
  createdAt: new Date().toISOString(),
  products: result,
};
writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${outFile}`);
console.log(JSON.stringify(result));
