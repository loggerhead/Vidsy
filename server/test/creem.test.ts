import { app } from '../src/index';
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';

const BASE = 'https://billing.test';
const WEBHOOK_SECRET = 'test-webhook-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

let sequence = 0;
const nextId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}_${sequence}_${Date.now()}`;
};

type Device = { deviceId: string; deviceToken: string };

const newDevice = (): Device => {
  sequence += 1;
  return {
    deviceId: `dev_creem-${sequence}-0000-0000-000000000000`,
    deviceToken: `token-creem-${sequence}-abcdefghijklmnop`,
  };
};

const jsonHeaders = { 'Content-Type': 'application/json' };
const authHeaders = (device: Device) => ({ ...jsonHeaders, Authorization: `Bearer ${device.deviceToken}` });

const register = async (device: Device): Promise<Response> =>
  SELF.fetch(`${BASE}/v1/devices/register`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(device),
  });

const registerOk = async (): Promise<Device> => {
  const device = newDevice();
  expect((await register(device)).status).toBe(200);
  return device;
};

const authorize = async (device: Device, downloadKey: string): Promise<Response> =>
  SELF.fetch(`${BASE}/v1/download/authorize`, {
    method: 'POST',
    headers: authHeaders(device),
    body: JSON.stringify({ downloadKey }),
  });

const entitlement = async (device: Device): Promise<Response> =>
  SELF.fetch(`${BASE}/v1/entitlement`, { headers: authHeaders(device) });

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const exhaustFreeQuota = async (device: Device): Promise<void> => {
  await env.DB.prepare('INSERT INTO daily_usage (device_id, utc_date, used) VALUES (?, ?, 2)')
    .bind(device.deviceId, new Date().toISOString().slice(0, 10))
    .run();
};

/** Bind a mock fetch into the Worker env for Creem REST calls. */
const withFetch = (fetchImpl: typeof fetch): Env =>
  new Proxy(env, {
    get: (target, property) => (property === 'CREEM_FETCH' ? fetchImpl : Reflect.get(target, property)),
  }) as unknown as Env;

type FetchCall = { url: string; init: RequestInit | undefined };

const mockFetch = (payload: unknown, status = 200) => {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
};

const sign = async (body: string, secret = WEBHOOK_SECRET): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const sendWebhook = async (event: unknown, options?: { signature?: string; secret?: string }): Promise<Response> => {
  const body = JSON.stringify(event);
  const signature = options?.signature ?? (await sign(body, options?.secret));
  return app.request(
    '/webhooks/creem',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'creem-signature': signature },
      body,
    },
    env,
  );
};

type CheckoutOptions = {
  device: Device;
  productKey?: string;
  productId?: string;
  orderId?: string;
  email?: string;
  customerId?: string;
  amount?: number;
  subscription?: Record<string, unknown>;
  licenseKeys?: Array<Record<string, unknown>>;
  createdAt?: string;
};

const checkoutEvent = (options: CheckoutOptions) => {
  const productKey = options.productKey ?? 'credits_10';
  const eventId = nextId('evt_checkout');
  return {
    id: eventId,
    eventType: 'checkout.completed',
    created_at: options.createdAt ?? new Date().toISOString(),
    object: {
      id: `ch_${eventId}`,
      object: 'checkout',
      order: {
        id: options.orderId ?? `ord_${eventId}`,
        amount: options.amount ?? 299,
        currency: 'USD',
        status: 'paid',
      },
      product: { id: options.productId ?? `prod_${productKey}` },
      customer: {
        id: options.customerId ?? `cus_${eventId}`,
        email: options.email ?? `${eventId}@example.com`,
      },
      ...(options.licenseKeys ? { license_keys: options.licenseKeys } : {}),
      ...(options.subscription ? { subscription: options.subscription } : {}),
      metadata: { device_id: options.device.deviceId, product_key: productKey },
    },
  };
};

const subscriptionEvent = (options: {
  eventType: string;
  subscriptionId: string;
  status: string;
  customerId: string;
  email: string;
  currentPeriodEnd: number | null;
  createdAt?: string;
}) => ({
  id: nextId('evt_subscription'),
  eventType: options.eventType,
  created_at: options.createdAt ?? new Date().toISOString(),
  object: {
    id: options.subscriptionId,
    object: 'subscription',
    status: options.status,
    product: { id: 'prod_pro_monthly' },
    customer: { id: options.customerId, email: options.email },
    ...(options.currentPeriodEnd ? { current_period_end_date: new Date(options.currentPeriodEnd).toISOString() } : {}),
  },
});

describe('creem billing', () => {
  it('creates a checkout with the mapped product id and device metadata', async () => {
    const device = await registerOk();
    const { impl, calls } = mockFetch({ checkout_url: 'https://checkout.creem.io/test-session' });

    const response = await app.request(
      '/v1/checkout',
      { method: 'POST', headers: authHeaders(device), body: JSON.stringify({ productKey: 'credits_10' }) },
      withFetch(impl),
    );

    expect(response.status).toBe(200);
    expect((await readJson<{ checkoutUrl: string }>(response)).checkoutUrl).toBe(
      'https://checkout.creem.io/test-session',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.creem.test/v1/checkouts');
    expect((calls[0].init?.headers as Record<string, string>)['x-api-key']).toBe('test-api-key');
    const payload = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(payload.product_id).toBe('prod_credits_10');
    expect(payload.success_url).toBe('https://uu0uu.com/billing/success');
    expect(payload.metadata).toEqual({ device_id: device.deviceId, product_key: 'credits_10' });
    expect(String(payload.request_id).startsWith(`${device.deviceId}:credits_10:`)).toBe(true);
  });

  it('rejects an unknown product key without calling Creem', async () => {
    const device = await registerOk();
    const { impl, calls } = mockFetch({ checkout_url: 'https://checkout.creem.io/unused' });

    const response = await app.request(
      '/v1/checkout',
      { method: 'POST', headers: authHeaders(device), body: JSON.stringify({ productKey: 'credits_999' }) },
      withFetch(impl),
    );

    expect(response.status).toBe(400);
    expect((await readJson<{ error: string }>(response)).error).toBe('invalid_product');
    expect(calls).toHaveLength(0);
  });

  it('grants credits once for checkout.completed and ignores duplicate deliveries', async () => {
    const device = await registerOk();
    const orderId = nextId('ord_credits');
    const event = checkoutEvent({ device, orderId });

    expect((await sendWebhook(event)).status).toBe(200);
    expect((await readJson<{ credits: number }>(await entitlement(device))).credits).toBe(10);

    const duplicate = await sendWebhook(event);
    expect(duplicate.status).toBe(200);
    expect((await readJson<{ duplicate: boolean }>(duplicate)).duplicate).toBe(true);
    expect((await readJson<{ credits: number }>(await entitlement(device))).credits).toBe(10);

    // A different event id for the same order is still the same purchase.
    expect((await sendWebhook(checkoutEvent({ device, orderId }))).status).toBe(200);
    expect((await readJson<{ credits: number }>(await entitlement(device))).credits).toBe(10);

    const first = await authorize(device, 'credits-after-purchase-1');
    const second = await authorize(device, 'credits-after-purchase-2');
    const third = await authorize(device, 'credits-after-purchase-3');
    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    const thirdBody = await readJson<{ source: string; credits: number }>(third);
    expect(thirdBody.source).toBe('credits');
    expect(thirdBody.credits).toBe(9);
  });

  it('saves license keys and activates them for the current device', async () => {
    const device = await registerOk();
    const licenseKey = 'AAAA-BBBB-CCCC-DDDD';
    await sendWebhook(
      checkoutEvent({
        device,
        licenseKeys: [{ key: licenseKey, status: 'active', activation_limit: 3 }],
      }),
    );

    const { impl, calls } = mockFetch({ license: { id: 'lic_1', status: 'active' }, instance: { id: 'ins_1' } });
    const activate = () =>
      app.request(
        '/v1/license/activate',
        {
          method: 'POST',
          headers: authHeaders(device),
          body: JSON.stringify({ licenseKey: '  aaaa-bbbb-cccc-dddd  ' }),
        },
        withFetch(impl),
      );

    const response = await activate();
    expect(response.status).toBe(200);
    expect((await readJson<{ credits: number }>(response)).credits).toBe(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.creem.test/v1/licenses/activate');
    const payload = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(payload.key).toBe(licenseKey);
    expect(payload.instance_name).toBe(device.deviceId);

    // Re-activating the same device must not consume another Creem slot.
    expect((await activate()).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('enforces the license activation limit across devices', async () => {
    const first = await registerOk();
    const second = await registerOk();
    const licenseKey = 'LIMIT-0000-1111-2222';
    await sendWebhook(
      checkoutEvent({
        device: first,
        licenseKeys: [{ key: licenseKey, status: 'active', activation_limit: 1 }],
      }),
    );

    const ok = mockFetch({ license: { id: 'lic_limit', status: 'active' } });
    expect(
      (
        await app.request(
          '/v1/license/activate',
          { method: 'POST', headers: authHeaders(first), body: JSON.stringify({ licenseKey }) },
          withFetch(ok.impl),
        )
      ).status,
    ).toBe(200);

    const blocked = mockFetch({ license: { id: 'lic_limit', status: 'active' } });
    const response = await app.request(
      '/v1/license/activate',
      { method: 'POST', headers: authHeaders(second), body: JSON.stringify({ licenseKey }) },
      withFetch(blocked.impl),
    );
    expect(response.status).toBe(403);
    expect((await readJson<{ error: string }>(response)).error).toBe('activation_limit_reached');
    expect(blocked.calls).toHaveLength(0);
  });

  it('drives subscription entitlement through checkout, cancellation and expiry', async () => {
    const device = await registerOk();
    const subscriptionId = nextId('sub');
    const customerId = nextId('cus_sub');
    const email = `${customerId}@example.com`;
    const periodEnd = Date.now() + 30 * DAY_MS;

    await sendWebhook(
      checkoutEvent({
        device,
        productKey: 'pro_monthly',
        amount: 499,
        customerId,
        email,
        subscription: {
          id: subscriptionId,
          status: 'active',
          product: { id: 'prod_pro_monthly' },
          current_period_end_date: new Date(periodEnd).toISOString(),
        },
      }),
    );

    const active = await readJson<{ plan: string; subscription: { status: string } }>(await entitlement(device));
    expect(active.plan).toBe('pro');
    expect(active.subscription.status).toBe('active');

    const subscribed = await authorize(device, 'subscription-key');
    expect((await readJson<{ source: string }>(subscribed)).source).toBe('subscription');

    await sendWebhook(
      subscriptionEvent({
        eventType: 'subscription.canceled',
        subscriptionId,
        status: 'canceled',
        customerId,
        email,
        currentPeriodEnd: periodEnd,
      }),
    );
    const canceled = await readJson<{ plan: string; subscription: { status: string } }>(await entitlement(device));
    expect(canceled.plan).toBe('pro');
    expect(canceled.subscription.status).toBe('canceled');
    expect((await authorize(device, 'subscription-key-2')).status).toBe(200);

    await sendWebhook(
      subscriptionEvent({
        eventType: 'subscription.expired',
        subscriptionId,
        status: 'expired',
        customerId,
        email,
        currentPeriodEnd: periodEnd,
      }),
    );
    const expired = await readJson<{ plan: string; subscription: { status: string } }>(await entitlement(device));
    expect(expired.plan).toBe('free');
    expect(expired.subscription.status).toBe('expired');

    await exhaustFreeQuota(device);
    expect((await authorize(device, 'subscription-key-3')).status).toBe(402);
  });

  it('reverses credits for a refunded order exactly once', async () => {
    const device = await registerOk();
    const orderId = nextId('ord_refund');
    await sendWebhook(checkoutEvent({ device, orderId }));
    expect((await readJson<{ credits: number }>(await entitlement(device))).credits).toBe(10);

    const refund = {
      id: nextId('evt_refund'),
      eventType: 'refund.created',
      created_at: new Date().toISOString(),
      object: {
        id: nextId('ref'),
        status: 'succeeded',
        order: { id: orderId, amount: 299, currency: 'USD' },
      },
    };

    expect((await sendWebhook(refund)).status).toBe(200);
    expect((await readJson<{ credits: number }>(await entitlement(device))).credits).toBe(0);

    // Same event and a different event for the same order are both no-ops.
    await sendWebhook(refund);
    await sendWebhook({ ...refund, id: nextId('evt_refund') });
    expect((await readJson<{ credits: number }>(await entitlement(device))).credits).toBe(0);
  });

  it('revokes a subscription when its order is refunded', async () => {
    const device = await registerOk();
    const orderId = nextId('ord_sub_refund');
    const subscriptionId = nextId('sub_refund');
    const customerId = nextId('cus_sub_refund');
    const email = `${customerId}@example.com`;

    await sendWebhook(
      checkoutEvent({
        device,
        orderId,
        productKey: 'pro_monthly',
        amount: 499,
        customerId,
        email,
        subscription: {
          id: subscriptionId,
          status: 'active',
          product: { id: 'prod_pro_monthly' },
          current_period_end_date: new Date(Date.now() + 30 * DAY_MS).toISOString(),
        },
      }),
    );
    expect((await readJson<{ plan: string }>(await entitlement(device))).plan).toBe('pro');

    await sendWebhook({
      id: nextId('evt_refund'),
      eventType: 'refund.created',
      object: { id: nextId('ref'), status: 'succeeded', order: { id: orderId, amount: 499, currency: 'USD' } },
    });

    const state = await readJson<{ plan: string; subscription: { status: string } }>(await entitlement(device));
    expect(state.plan).toBe('free');
    expect(state.subscription.status).toBe('expired');
  });

  it('rejects a forged webhook signature without writing anything', async () => {
    const device = await registerOk();
    const event = checkoutEvent({ device });
    const orderId = event.object.order.id;

    const response = await sendWebhook(event, { signature: 'deadbeef' });
    expect(response.status).toBe(401);
    expect((await readJson<{ error: string }>(response)).error).toBe('invalid_signature');

    const eventRow = await env.DB.prepare('SELECT id FROM webhook_events WHERE id = ?').bind(event.id).first();
    expect(eventRow).toBeNull();
    const purchase = await env.DB.prepare('SELECT id FROM purchases WHERE id = ?').bind(orderId).first();
    expect(purchase).toBeNull();
  });

  it('returns the Creem customer portal link for the device account', async () => {
    const device = await registerOk();
    const customerId = nextId('cus_portal');
    await sendWebhook(checkoutEvent({ device, customerId, email: `${customerId}@example.com` }));

    const { impl, calls } = mockFetch({ customer_portal_link: 'https://creem.io/portal/test-link' });
    const response = await app.request(
      '/v1/portal',
      { method: 'POST', headers: authHeaders(device), body: JSON.stringify({}) },
      withFetch(impl),
    );

    expect(response.status).toBe(200);
    expect((await readJson<{ portalUrl: string }>(response)).portalUrl).toBe('https://creem.io/portal/test-link');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.creem.test/v1/customers/billing');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ customer_id: customerId });
  });
});
