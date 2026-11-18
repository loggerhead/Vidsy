import {
  canonicalSnapshotJson,
  parseSnapshotPublicKey,
  verifySnapshotSignature,
} from '../../packages/shared/lib/license/verify.js';
import { app } from '../src/index';
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { EntitlementSnapshot } from '../../packages/shared/lib/license/types.js';
import type { Env } from '../src/env';

const BASE = 'https://billing.test';
let deviceSequence = 0;

type Device = { deviceId: string; deviceToken: string };

const newDevice = (): Device => {
  deviceSequence += 1;
  return {
    deviceId: `dev_test-${deviceSequence}-0000-0000-000000000000`,
    deviceToken: `token-${deviceSequence}-abcdefghijklmnop`,
  };
};

const jsonHeaders = { 'Content-Type': 'application/json' };

const authHeaders = (device: Device) => ({
  ...jsonHeaders,
  Authorization: `Bearer ${device.deviceToken}`,
});

const register = async (device: Device): Promise<Response> =>
  SELF.fetch(`${BASE}/v1/devices/register`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(device),
  });

const registerOk = async (): Promise<Device> => {
  const device = newDevice();
  const response = await register(device);
  expect(response.status).toBe(200);
  return device;
};

const authorize = async (device: Device, downloadKey: string): Promise<Response> =>
  SELF.fetch(`${BASE}/v1/download/authorize`, {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify({ downloadKey }),
  });

const report = async (
  device: Device,
  downloadKey: string,
  outcome: 'success' | 'failed' | 'cancelled',
  bytesDownloaded = 0,
): Promise<Response> =>
  SELF.fetch(`${BASE}/v1/download/report`, {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify({ downloadKey, outcome, bytesDownloaded }),
  });

const entitlement = async (device: Device): Promise<Response> =>
  SELF.fetch(`${BASE}/v1/entitlement`, { headers: authHeaders(device) });

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

let accountSequence = 0;

const seedAccount = async (device: Device, credits = 0): Promise<string> => {
  accountSequence += 1;
  const accountId = `acc_test_${accountSequence}`;
  const now = Date.now();
  await env.DB.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)')
    .bind(accountId, `${accountId}@example.com`, now)
    .run();
  await env.DB.prepare('UPDATE devices SET account_id = ? WHERE id = ?').bind(accountId, device.deviceId).run();
  if (credits > 0) {
    await env.DB.prepare(
      `INSERT INTO credit_ledger (id, account_id, delta, reason, ref, created_at)
       VALUES (?, ?, ?, 'grant', ?, ?)`,
    )
      .bind(`grant_${accountId}_${credits}`, accountId, credits, `grant:${accountId}:${credits}`, now)
      .run();
  }
  return accountId;
};

const exhaustFreeQuota = async (device: Device): Promise<void> => {
  await env.DB.prepare('INSERT INTO daily_usage (device_id, utc_date, used) VALUES (?, ?, 2)')
    .bind(device.deviceId, new Date().toISOString().slice(0, 10))
    .run();
};

const seedSubscription = async (device: Device, status: string, currentPeriodEnd: number | null): Promise<void> => {
  const accountId = await seedAccount(device);
  await env.DB.prepare(
    `INSERT INTO subscriptions
       (id, account_id, product_id, status, current_period_end, cancel_at_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(`sub_${accountId}`, accountId, 'prod_pro_monthly', status, currentPeriodEnd, Date.now())
    .run();
};

describe('billing worker', () => {
  it('reports health', async () => {
    const response = await SELF.fetch(`${BASE}/health`);
    expect(response.status).toBe(200);
    const body = await readJson<{ ok: boolean; service: string }>(response);
    expect(body.ok).toBe(true);
    expect(body.service).toBe('uuget-billing');
  });

  it('registers a device idempotently and returns a signed entitlement snapshot', async () => {
    const device = await registerOk();
    expect((await register(device)).status).toBe(200);

    const response = await entitlement(device);
    expect(response.status).toBe(200);
    const body = await readJson<{
      plan: string;
      free: { used: number; limit: number; utcDate: string };
      credits: number;
      snapshot: Record<string, unknown>;
      signature: string;
      keyId: string;
    }>(response);

    expect(body.plan).toBe('free');
    expect(body.free).toEqual({ used: 0, limit: 2, utcDate: new Date().toISOString().slice(0, 10) });
    expect(body.credits).toBe(0);
    expect(body.snapshot).toMatchObject({ v: 1, deviceId: device.deviceId, plan: 'free', freeUsed: 0 });
    expect(body.keyId).toBe('test-key');
    expect(typeof body.signature).toBe('string');

    const publicKey = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(env.TEST_SNAPSHOT_PUBLIC_JWK) as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const signature = Uint8Array.from(atob(body.signature), char => char.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature,
      new TextEncoder().encode(JSON.stringify(body.snapshot)),
    );
    expect(valid).toBe(true);
  });

  it('signs snapshots that pass the extension verifier exactly', async () => {
    const device = await registerOk();
    const body = await readJson<{ snapshot: EntitlementSnapshot; signature: string }>(await entitlement(device));

    // The response order is the canonical order the extension reconstructs.
    expect(canonicalSnapshotJson(body.snapshot)).toBe(JSON.stringify(body.snapshot));

    const publicKey = parseSnapshotPublicKey(env.TEST_SNAPSHOT_PUBLIC_JWK);
    expect(publicKey).not.toBeNull();
    expect(await verifySnapshotSignature(body.snapshot, body.signature, publicKey)).toBe(true);

    const tampered = { ...body.snapshot, creditBalance: body.snapshot.creditBalance + 1 };
    expect(await verifySnapshotSignature(tampered, body.signature, publicKey)).toBe(false);
  });

  it('rejects a different token for an existing device id', async () => {
    const device = await registerOk();
    const response = await register({ ...device, deviceToken: 'other-token-abcdefghijklmnop' });
    expect(response.status).toBe(409);
  });

  it('allows two free downloads per UTC day and rejects the third with 402', async () => {
    const device = await registerOk();

    const first = await authorize(device, 'free-1');
    expect(first.status).toBe(200);
    expect((await readJson<{ source: string }>(first)).source).toBe('free');

    expect((await authorize(device, 'free-2')).status).toBe(200);

    const third = await authorize(device, 'free-3');
    expect(third.status).toBe(402);
    const body = await readJson<{ allowed: boolean; error: string; free: { used: number; limit: number } }>(third);
    expect(body.allowed).toBe(false);
    expect(body.error).toBe('payment_required');
    expect(body.free).toMatchObject({ used: 2, limit: 2 });

    const state = await readJson<{ free: { used: number } }>(await entitlement(device));
    expect(state.free.used).toBe(2);
  });

  it('lets exactly one of two concurrent requests win the last free slot', async () => {
    const device = await registerOk();
    expect((await authorize(device, 'warmup')).status).toBe(200);

    const [first, second] = await Promise.all([authorize(device, 'race-a'), authorize(device, 'race-b')]);
    const statuses = [first.status, second.status].sort((left, right) => left - right);
    expect(statuses).toEqual([200, 402]);

    const state = await readJson<{ free: { used: number } }>(await entitlement(device));
    expect(state.free.used).toBe(2);
  });

  it('returns the same decision for a duplicate authorize without double charging', async () => {
    const device = await registerOk();

    const first = await authorize(device, 'duplicate-key');
    const second = await authorize(device, 'duplicate-key');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstBody = await readJson<{ authorizationId: string; free: { used: number } }>(first);
    const secondBody = await readJson<{ authorizationId: string; free: { used: number } }>(second);
    expect(secondBody.authorizationId).toBe(firstBody.authorizationId);
    expect(secondBody.free.used).toBe(1);
  });

  it('commits on success and keeps the free slot consumed', async () => {
    const device = await registerOk();
    await authorize(device, 'commit-key');

    const result = await report(device, 'commit-key', 'success', 1024);
    expect(result.status).toBe(200);
    expect((await readJson<{ state: string }>(result)).state).toBe('committed');

    const state = await readJson<{ free: { used: number } }>(await entitlement(device));
    expect(state.free.used).toBe(1);
  });

  it('releases a zero-byte failure and refunds the free slot', async () => {
    const device = await registerOk();
    await authorize(device, 'release-key');

    const result = await report(device, 'release-key', 'failed', 0);
    expect((await readJson<{ state: string }>(result)).state).toBe('released');

    const state = await readJson<{ free: { used: number } }>(await entitlement(device));
    expect(state.free.used).toBe(0);
  });

  it('commits a failure that already downloaded bytes', async () => {
    const device = await registerOk();
    await authorize(device, 'partial-key');

    const result = await report(device, 'partial-key', 'failed', 2048);
    expect((await readJson<{ state: string }>(result)).state).toBe('committed');

    const state = await readJson<{ free: { used: number } }>(await entitlement(device));
    expect(state.free.used).toBe(1);
  });

  it('treats duplicate reports as no-ops', async () => {
    const device = await registerOk();
    await authorize(device, 'idempotent-report');

    expect((await report(device, 'idempotent-report', 'failed', 0)).status).toBe(200);
    const second = await report(device, 'idempotent-report', 'failed', 0);
    expect((await readJson<{ state: string }>(second)).state).toBe('released');

    const state = await readJson<{ free: { used: number } }>(await entitlement(device));
    expect(state.free.used).toBe(0);
  });

  it('re-reserves a released download on retry with the same key', async () => {
    const device = await registerOk();
    await authorize(device, 'retry-key');
    await report(device, 'retry-key', 'failed', 0);

    const retry = await authorize(device, 'retry-key');
    expect(retry.status).toBe(200);
    const body = await readJson<{ source: string; free: { used: number } }>(retry);
    expect(body.source).toBe('free');
    expect(body.free.used).toBe(1);
  });

  it('reserves, commits and releases credits against the derived balance', async () => {
    const device = await registerOk();
    await seedAccount(device, 5);
    await exhaustFreeQuota(device);

    const reserved = await authorize(device, 'credits-1');
    expect(reserved.status).toBe(200);
    const reservedBody = await readJson<{ source: string; credits: number }>(reserved);
    expect(reservedBody.source).toBe('credits');
    expect(reservedBody.credits).toBe(4);

    const released = await report(device, 'credits-1', 'failed', 0);
    expect((await readJson<{ state: string }>(released)).state).toBe('released');
    expect((await readJson<{ credits: number }>(await entitlement(device))).credits).toBe(5);

    const retried = await authorize(device, 'credits-1');
    expect((await readJson<{ credits: number }>(retried)).credits).toBe(4);
    await report(device, 'credits-1', 'success', 4096);
    expect((await readJson<{ credits: number }>(await entitlement(device))).credits).toBe(4);
  });

  it('denies credits when the balance is empty', async () => {
    const device = await registerOk();
    await seedAccount(device, 0);
    await exhaustFreeQuota(device);

    const response = await authorize(device, 'credits-empty');
    expect(response.status).toBe(402);
  });

  it('allows an active subscription without consuming free quota or credits', async () => {
    const device = await registerOk();
    await seedSubscription(device, 'active', Date.now() + 30 * 24 * 60 * 60 * 1000);

    const response = await authorize(device, 'sub-active');
    expect(response.status).toBe(200);
    const body = await readJson<{ source: string; subscription: { status: string } }>(response);
    expect(body.source).toBe('subscription');
    expect(body.subscription.status).toBe('active');

    const state = await readJson<{ free: { used: number } }>(await entitlement(device));
    expect(state.free.used).toBe(0);
  });

  it('keeps access for a canceled subscription until the period ends', async () => {
    const device = await registerOk();
    await seedSubscription(device, 'canceled', Date.now() + 24 * 60 * 60 * 1000);

    const response = await authorize(device, 'sub-canceled');
    expect(response.status).toBe(200);
    expect((await readJson<{ source: string }>(response)).source).toBe('subscription');
  });

  it('denies an expired subscription', async () => {
    const device = await registerOk();
    await seedSubscription(device, 'expired', Date.now() - 1000);
    await exhaustFreeQuota(device);

    const response = await authorize(device, 'sub-expired');
    expect(response.status).toBe(402);
  });

  it('rejects an invalid bearer token', async () => {
    const response = await SELF.fetch(`${BASE}/v1/entitlement`, {
      headers: { Authorization: 'Bearer not-a-real-token-000000' },
    });
    expect(response.status).toBe(401);
  });

  it('rate limits authorize calls per device', async () => {
    const device = await registerOk();
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await authorize(device, `rate-${index}`)).status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 402]);
    expect(statuses[3]).toBe(429);
  });

  it('allows every download when the settings kill switch is off', async () => {
    const device = await registerOk();
    await env.DB.prepare("UPDATE settings SET value = 'off' WHERE key = 'billing_enforcement'").run();

    for (let index = 0; index < 3; index += 1) {
      expect((await authorize(device, `kill-switch-${index}`)).status).toBe(200);
    }
    const state = await readJson<{ free: { used: number } }>(await entitlement(device));
    expect(state.free.used).toBe(0);
  });

  it('allows every download when BILLING_ENFORCEMENT=off is bound', async () => {
    const device = await registerOk();
    const offEnv = new Proxy(env, {
      get: (target, property) => (property === 'BILLING_ENFORCEMENT' ? 'off' : Reflect.get(target, property)),
    }) as unknown as Env;

    for (let index = 0; index < 3; index += 1) {
      const response = await app.request(
        '/v1/download/authorize',
        {
          method: 'POST',
          headers: authHeaders(device),
          body: JSON.stringify({ downloadKey: `env-off-${index}` }),
        },
        offEnv,
      );
      expect(response.status).toBe(200);
    }
  });

  it('answers CORS preflight for the configured web and extension origins only', async () => {
    const preflight = (origin: string) =>
      SELF.fetch(`${BASE}/v1/entitlement`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      });

    const web = await preflight('https://uu0uu.com');
    expect(web.status).toBe(204);
    expect(web.headers.get('access-control-allow-origin')).toBe('https://uu0uu.com');

    const extension = await preflight('chrome-extension://abcdefghijklmnop');
    expect(extension.status).toBe(204);
    expect(extension.headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdefghijklmnop');

    const foreign = await preflight('https://evil.example');
    expect(foreign.status).toBe(204);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });
});
