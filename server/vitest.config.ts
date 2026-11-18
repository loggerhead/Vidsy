import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Ephemeral signing key for tests: the Worker signs snapshots and the test
// verifies them with the matching public JWK, mirroring the extension in M4.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const snapshotPrivateKey = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const snapshotPublicJwk = JSON.stringify(publicKey.export({ format: 'jwk' }));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SNAPSHOT_PUBLIC_JWK: snapshotPublicJwk,
            SNAPSHOT_PRIVATE_KEY: snapshotPrivateKey,
            SNAPSHOT_KEY_ID: 'test-key',
            ENVIRONMENT: 'test',
            BILLING_ENFORCEMENT: 'on',
            CORS_ORIGINS: 'https://uu0uu.com',
            RATE_LIMIT_REGISTER_PER_HOUR: '1000',
            // Kept low so the 429 test stays cheap; every test uses a fresh
            // device id, and the limit is keyed by device.
            RATE_LIMIT_AUTHORIZE_PER_MINUTE: '3',
            CREEM_API_KEY: 'test-api-key',
            CREEM_WEBHOOK_SECRET: 'test-webhook-secret',
            CREEM_API_BASE: 'https://api.creem.test',
            CHECKOUT_SUCCESS_URL: 'https://uu0uu.com/billing/success',
            PRODUCTS_JSON: JSON.stringify({
              credits_10: 'prod_credits_10',
              credits_50: 'prod_credits_50',
              credits_120: 'prod_credits_120',
              credits_300: 'prod_credits_300',
              pro_monthly: 'prod_pro_monthly',
              pro_yearly: 'prod_pro_yearly',
            }),
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
