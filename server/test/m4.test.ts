import { sweepStaleReservations } from '../src/db';
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const BASE = 'https://billing.test';
let deviceSequence = 0;

type Device = { deviceId: string; deviceToken: string };

const newDevice = (): Device => {
  deviceSequence += 1;
  return {
    deviceId: `dev_m4-${deviceSequence}-0000-0000-000000000000`,
    deviceToken: `m4-token-${deviceSequence}-abcdefghijkl`,
  };
};

const jsonHeaders = { 'Content-Type': 'application/json' };
const authHeaders = (device: Device) => ({
  ...jsonHeaders,
  Authorization: `Bearer ${device.deviceToken}`,
});

const registerOk = async (): Promise<Device> => {
  const device = newDevice();
  const response = await SELF.fetch(`${BASE}/v1/devices/register`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(device),
  });
  expect(response.status).toBe(200);
  return device;
};

const report = async (device: Device, body: Record<string, unknown>): Promise<Response> =>
  SELF.fetch(`${BASE}/v1/download/report`, {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify(body),
  });

const entitlement = async (device: Device): Promise<Response> =>
  SELF.fetch(`${BASE}/v1/entitlement`, { headers: authHeaders(device) });

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const seedAccount = async (device: Device, credits = 0): Promise<string> => {
  const accountId = `acc_m4_${crypto.randomUUID()}`;
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
      .bind(`grant_${accountId}`, accountId, credits, `grant:${accountId}`, now)
      .run();
  }
  return accountId;
};

const offlineBody = (overrides: Record<string, unknown> = {}) => ({
  downloadKey: `offline-${crypto.randomUUID()}`,
  outcome: 'success',
  bytesDownloaded: 1024,
  offline: {
    source: 'credits',
    freeReserved: 0,
    creditsReserved: 1,
    authorizedAt: Date.now() - 60_000,
  },
  ...overrides,
});

describe('M4 offline backfill', () => {
  it('records an offline credit reservation exactly once', async () => {
    const device = await registerOk();
    const accountId = await seedAccount(device, 5);
    const body = offlineBody();

    const first = await report(device, body);
    expect(first.status).toBe(200);
    expect(await readJson(first)).toMatchObject({ ok: true, state: 'committed', retroactive: true });

    let ent = await readJson<{ credits: number }>(await entitlement(device));
    expect(ent.credits).toBe(4);

    const replay = await report(device, body);
    expect(replay.status).toBe(200);
    expect(await readJson(replay)).toMatchObject({ ok: true, state: 'committed' });

    ent = await readJson<{ credits: number }>(await entitlement(device));
    expect(ent.credits).toBe(4);

    const ledger = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM credit_ledger WHERE account_id = ? AND reason = 'reserve'",
    )
      .bind(accountId)
      .first<{ count: number }>();
    expect(ledger?.count).toBe(1);
  });

  it('records offline free usage above the daily limit without granting another download', async () => {
    const device = await registerOk();
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare('INSERT INTO daily_usage (device_id, utc_date, used) VALUES (?, ?, 2)')
      .bind(device.deviceId, day)
      .run();

    const response = await report(
      device,
      offlineBody({
        offline: { source: 'free', freeReserved: 1, creditsReserved: 0, authorizedAt: Date.now() - 60_000 },
      }),
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ state: 'committed', retroactive: true });

    const usage = await env.DB.prepare('SELECT used FROM daily_usage WHERE device_id = ? AND utc_date = ?')
      .bind(device.deviceId, day)
      .first<{ used: number }>();
    expect(usage?.used).toBe(3);

    const blocked = await SELF.fetch(`${BASE}/v1/download/authorize`, {
      method: 'POST',
      headers: authHeaders(device),
      body: JSON.stringify({ downloadKey: 'after-offline-free' }),
    });
    expect(blocked.status).toBe(402);
  });

  it('does not charge a zero-byte offline failure', async () => {
    const device = await registerOk();
    await seedAccount(device, 2);

    const response = await report(device, offlineBody({ outcome: 'failed', bytesDownloaded: 0 }));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ state: 'released', retroactive: true });

    const ent = await readJson<{ credits: number }>(await entitlement(device));
    expect(ent.credits).toBe(2);
  });

  it('rejects malformed offline reservations', async () => {
    const device = await registerOk();
    const response = await report(device, {
      downloadKey: 'bad-offline',
      outcome: 'success',
      bytesDownloaded: 1,
      offline: { source: 'nonsense', freeReserved: 0, creditsReserved: 1, authorizedAt: Date.now() },
    });
    expect(response.status).toBe(400);
  });
});

describe('M4 account deletion', () => {
  it('revokes the device token and anonymizes the account', async () => {
    const device = await registerOk();
    const accountId = await seedAccount(device, 3);
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, account_id, product_id, status, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?, ?, 'prod_pro_monthly', 'active', NULL, 0, ?)`,
    )
      .bind(`sub_${accountId}`, accountId, Date.now())
      .run();
    await env.DB.prepare(
      `INSERT INTO license_keys (key_hash, key_last4, account_id, product_id, activation_limit, status, expires_at, created_at)
       VALUES (?, '1234', ?, 'prod_pro_monthly', 3, 'active', NULL, ?)`,
    )
      .bind(`hash_${accountId}`, accountId, Date.now())
      .run();
    await env.DB.prepare('INSERT INTO license_activations (key_hash, device_id, created_at) VALUES (?, ?, ?)')
      .bind(`hash_${accountId}`, device.deviceId, Date.now())
      .run();

    const deleted = await SELF.fetch(`${BASE}/v1/account`, { method: 'DELETE', headers: authHeaders(device) });
    expect(deleted.status).toBe(200);
    expect(await readJson(deleted)).toEqual({ ok: true });

    const after = await entitlement(device);
    expect(after.status).toBe(401);

    const account = await env.DB.prepare('SELECT email, creem_customer_id, deleted_at FROM accounts WHERE id = ?')
      .bind(accountId)
      .first<{ email: string; creem_customer_id: string | null; deleted_at: number | null }>();
    expect(account?.deleted_at).not.toBeNull();
    expect(account?.email.startsWith('deleted+')).toBe(true);
    expect(account?.creem_customer_id).toBeNull();

    const deviceRow = await env.DB.prepare('SELECT revoked_at, account_id FROM devices WHERE id = ?')
      .bind(device.deviceId)
      .first<{ revoked_at: number | null; account_id: string | null }>();
    expect(deviceRow?.revoked_at).not.toBeNull();
    expect(deviceRow?.account_id).toBeNull();

    const subscription = await env.DB.prepare('SELECT status FROM subscriptions WHERE account_id = ?')
      .bind(accountId)
      .first<{ status: string }>();
    expect(subscription?.status).toBe('expired');

    const activations = await env.DB.prepare('SELECT COUNT(*) AS count FROM license_activations WHERE key_hash = ?')
      .bind(`hash_${accountId}`)
      .first<{ count: number }>();
    expect(activations?.count).toBe(0);

    const reRegister = await SELF.fetch(`${BASE}/v1/devices/register`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(device),
    });
    expect(reRegister.status).toBe(409);
  });

  it('revokes a device without an account', async () => {
    const device = await registerOk();
    const deleted = await SELF.fetch(`${BASE}/v1/account`, { method: 'DELETE', headers: authHeaders(device) });
    expect(deleted.status).toBe(200);
    expect((await entitlement(device)).status).toBe(401);
  });
});

describe('M4 reconciliation sweep', () => {
  it('commits reservations with no report after 24h and leaves fresh ones reserved', async () => {
    const device = await registerOk();
    const authorize = async (downloadKey: string): Promise<Response> =>
      SELF.fetch(`${BASE}/v1/download/authorize`, {
        method: 'POST',
        headers: authHeaders(device),
        body: JSON.stringify({ downloadKey }),
      });
    expect((await authorize('stale')).status).toBe(200);
    expect((await authorize('fresh')).status).toBe(200);

    const now = Date.now();
    await env.DB.prepare('UPDATE authorizations SET updated_at = ? WHERE device_id = ? AND download_key = ?')
      .bind(now - 25 * 60 * 60 * 1000, device.deviceId, 'stale')
      .run();

    const committed = await sweepStaleReservations(env.DB, now);
    expect(committed).toBeGreaterThanOrEqual(1);

    const states = await env.DB.prepare('SELECT download_key, state FROM authorizations WHERE device_id = ?')
      .bind(device.deviceId)
      .all<{ download_key: string; state: string }>();
    const byKey = Object.fromEntries((states.results ?? []).map(row => [row.download_key, row.state]));
    expect(byKey.stale).toBe('committed');
    expect(byKey.fresh).toBe('reserved');
  });
});
