import {
  countLicenseActivations,
  findAccountById,
  findLicenseActivation,
  findLicenseByHash,
  linkDevice,
  recordLicenseActivation,
} from './accounts.js';
import { authenticateDevice, registerDevice, sha256Hex } from './auth.js';
import { normalizeLicenseKey } from './contract.js';
import { CreemError, creemClientFromEnv } from './creem.js';
import {
  consumeRateLimit,
  deleteAccountData,
  deleteWebhookEvent,
  insertOfflineAuthorization,
  insertWebhookEvent,
  pruneRateLimits,
  revokeDevice,
  sweepStaleReservations,
} from './db.js';
import { authorizeDownload, reportDownload } from './entitlement.js';
import { corsHeaders, getClientIp, intFromEnv, upgradeOptions } from './http.js';
import { productFromKey, resolveCreemProductId } from './products.js';
import { buildEntitlementPayload } from './respond.js';
import { processCreemEvent, verifyCreemSignature } from './webhooks.js';
import { Hono } from 'hono';
import type { AppVariables, Env } from './env.js';
import type { CreemWebhookEvent } from './webhooks.js';
import type { Context, Next } from 'hono';

const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{8,64}$/;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_DOWNLOAD_KEY_LENGTH = 200;

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') ?? null;
  if (c.req.method === 'OPTIONS') {
    const headers = corsHeaders(origin, c.env) ?? {};
    return c.body(null, 204, headers);
  }
  await next();
  const headers = corsHeaders(origin, c.env);
  if (headers) for (const [name, value] of Object.entries(headers)) c.header(name, value);
  return undefined;
});

const readJsonObject = async (c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> => {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const unauthorized = (c: Context<HonoEnv>) => c.json({ ok: false, error: 'unauthorized' }, 401);

app.get('/health', c =>
  c.json({
    ok: true,
    service: 'uuget-billing',
    environment: c.env.ENVIRONMENT ?? 'development',
    version: '1.2.0',
  }),
);

app.post('/v1/devices/register', async c => {
  const now = Date.now();
  const rate = await consumeRateLimit(
    c.env.DB,
    `register:${getClientIp(c.req.raw)}`,
    60 * 60 * 1000,
    intFromEnv(c.env.RATE_LIMIT_REGISTER_PER_HOUR, 10),
    now,
  );
  if (!rate.allowed) {
    return c.json({ ok: false, error: 'rate_limited' }, 429, { 'Retry-After': String(rate.retryAfter) });
  }

  const body = await readJsonObject(c);
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
  const deviceToken = typeof body?.deviceToken === 'string' ? body.deviceToken.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 64) : undefined;
  if (!DEVICE_ID_PATTERN.test(deviceId) || !DEVICE_TOKEN_PATTERN.test(deviceToken)) {
    return c.json({ ok: false, error: 'invalid_device' }, 400);
  }

  const result = await registerDevice(c.env.DB, { deviceId, deviceToken, name }, now);
  if (!result.ok) return c.json({ ok: false, error: 'device_conflict' }, 409);
  return c.json({ ok: true });
});

const requireDevice = async (c: Context<HonoEnv>, next: Next) => {
  const device = await authenticateDevice(c.env.DB, c.req.header('Authorization') ?? null, Date.now());
  if (!device) return unauthorized(c);
  c.set('device', device);
  await next();
  return undefined;
};

app.use('/v1/entitlement', requireDevice);
app.use('/v1/download/*', requireDevice);
app.use('/v1/checkout', requireDevice);
app.use('/v1/portal', requireDevice);
app.use('/v1/license/*', requireDevice);
app.use('/v1/account', requireDevice);

app.get('/v1/entitlement', async c => c.json(await buildEntitlementPayload(c.env, c.get('device'), Date.now())));

app.post('/v1/download/authorize', async c => {
  const device = c.get('device');
  const now = Date.now();
  const rate = await consumeRateLimit(
    c.env.DB,
    `authorize:${device.id}`,
    60 * 1000,
    intFromEnv(c.env.RATE_LIMIT_AUTHORIZE_PER_MINUTE, 60),
    now,
  );
  if (!rate.allowed) {
    return c.json({ ok: false, error: 'rate_limited' }, 429, { 'Retry-After': String(rate.retryAfter) });
  }

  const body = await readJsonObject(c);
  const downloadKey = typeof body?.downloadKey === 'string' ? body.downloadKey.trim() : '';
  if (!downloadKey || downloadKey.length > MAX_DOWNLOAD_KEY_LENGTH) {
    return c.json({ ok: false, error: 'invalid_download_key' }, 400);
  }

  const result = await authorizeDownload(c.env, device, downloadKey, now);
  if (result.allowed) {
    return c.json({
      allowed: true,
      source: result.source,
      authorizationId: result.authorizationId,
      free: result.state.free,
      credits: result.state.credits,
      subscription: result.state.subscription,
    });
  }

  return c.json(
    {
      allowed: false,
      error: 'payment_required',
      free: result.state.free,
      credits: result.state.credits,
      subscription: result.state.subscription,
      upgrade: upgradeOptions(c.env),
    },
    402,
  );
});

app.post('/v1/download/report', async c => {
  const device = c.get('device');
  const body = await readJsonObject(c);
  const downloadKey = typeof body?.downloadKey === 'string' ? body.downloadKey.trim() : '';
  const outcome = body?.outcome;
  if (!downloadKey || downloadKey.length > MAX_DOWNLOAD_KEY_LENGTH) {
    return c.json({ ok: false, error: 'invalid_download_key' }, 400);
  }
  if (outcome !== 'success' && outcome !== 'failed' && outcome !== 'cancelled') {
    return c.json({ ok: false, error: 'invalid_outcome' }, 400);
  }

  const rawBytes = typeof body?.bytesDownloaded === 'number' ? body.bytesDownloaded : 0;
  const bytesDownloaded = Number.isFinite(rawBytes) ? Math.max(0, Math.trunc(rawBytes)) : 0;
  const now = Date.now();

  // Reports for downloads authorized while the Worker was unreachable carry
  // the local reservation so the Worker can backfill the usage (§6.6).
  const rawOffline = body?.offline;
  let offline:
    | {
        source: 'free' | 'credits' | 'subscription';
        freeReserved: number;
        creditsReserved: number;
        authorizedAt: number;
      }
    | undefined;
  if (rawOffline !== undefined) {
    const record = rawOffline && typeof rawOffline === 'object' ? (rawOffline as Record<string, unknown>) : null;
    const source = record?.source;
    const freeReserved = typeof record?.freeReserved === 'number' ? record.freeReserved : 0;
    const creditsReserved = typeof record?.creditsReserved === 'number' ? record.creditsReserved : 0;
    const authorizedAt = typeof record?.authorizedAt === 'number' ? record.authorizedAt : NaN;
    if (
      !record ||
      (source !== 'free' && source !== 'credits' && source !== 'subscription') ||
      !Number.isFinite(authorizedAt) ||
      authorizedAt <= 0 ||
      authorizedAt > now + 5 * 60 * 1000 ||
      freeReserved < 0 ||
      creditsReserved < 0
    ) {
      return c.json({ ok: false, error: 'invalid_request' }, 400);
    }
    offline = { source, freeReserved, creditsReserved, authorizedAt };
  }

  const result = await reportDownload(c.env.DB, device, downloadKey, outcome, bytesDownloaded, now);
  if (result.state === 'unknown' && offline) {
    const backfill = await insertOfflineAuthorization(c.env.DB, {
      device,
      downloadKey,
      source: offline.source,
      freeReserved: offline.freeReserved,
      creditsReserved: offline.creditsReserved,
      authorizedAt: offline.authorizedAt,
      committed: outcome === 'success' || bytesDownloaded > 0,
      now,
    });
    return c.json({ ok: true, state: backfill.state, retroactive: true });
  }
  return c.json({ ok: true, state: result.state });
});

app.delete('/v1/account', async c => {
  const device = c.get('device');
  const now = Date.now();
  if (device.account_id) await deleteAccountData(c.env.DB, device.account_id, now);
  else await revokeDevice(c.env.DB, device.id, now);
  return c.json({ ok: true });
});

app.post('/v1/checkout', async c => {
  const device = c.get('device');
  const now = Date.now();
  const rate = await consumeRateLimit(
    c.env.DB,
    `checkout:${device.id}`,
    60 * 60 * 1000,
    intFromEnv(c.env.RATE_LIMIT_CHECKOUT_PER_HOUR, 10),
    now,
  );
  if (!rate.allowed) {
    return c.json({ ok: false, error: 'rate_limited' }, 429, { 'Retry-After': String(rate.retryAfter) });
  }

  const body = await readJsonObject(c);
  const productKey = typeof body?.productKey === 'string' ? body.productKey.trim() : '';
  const product = productFromKey(productKey);
  if (!product) return c.json({ ok: false, error: 'invalid_product' }, 400);

  const productId = resolveCreemProductId(c.env, productKey);
  const client = creemClientFromEnv(c.env);
  if (!productId || !client) return c.json({ ok: false, error: 'billing_unavailable' }, 503);

  try {
    const checkout = await client.createCheckout({
      product_id: productId,
      request_id: `${device.id}:${productKey}:${crypto.randomUUID()}`,
      success_url: c.env.CHECKOUT_SUCCESS_URL ?? 'https://uu0uu.com/billing/success',
      metadata: { device_id: device.id, product_key: productKey },
    });
    const checkoutUrl = checkout.checkout_url ?? checkout.checkoutUrl;
    if (!checkoutUrl) return c.json({ ok: false, error: 'billing_unavailable' }, 503);
    return c.json({ ok: true, checkoutUrl });
  } catch (error) {
    console.error(
      'billing_checkout_failed',
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        status: error instanceof CreemError ? error.status : null,
      }),
    );
    return c.json({ ok: false, error: 'billing_unavailable' }, 503);
  }
});

app.post('/v1/portal', async c => {
  const device = c.get('device');
  if (!device.account_id) return c.json({ ok: false, error: 'account_not_found' }, 404);
  const account = await findAccountById(c.env.DB, device.account_id);
  if (!account?.creem_customer_id) return c.json({ ok: false, error: 'account_not_found' }, 404);

  const client = creemClientFromEnv(c.env);
  if (!client) return c.json({ ok: false, error: 'billing_unavailable' }, 503);

  try {
    const portal = await client.createPortalLink(account.creem_customer_id);
    const portalUrl = portal.customer_portal_link ?? portal.customerPortalLink;
    if (!portalUrl) return c.json({ ok: false, error: 'billing_unavailable' }, 503);
    return c.json({ ok: true, portalUrl });
  } catch (error) {
    console.error(
      'billing_portal_failed',
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        status: error instanceof CreemError ? error.status : null,
      }),
    );
    return c.json({ ok: false, error: 'billing_unavailable' }, 503);
  }
});

app.post('/v1/license/activate', async c => {
  const device = c.get('device');
  const now = Date.now();
  const body = await readJsonObject(c);
  const rawKey = typeof body?.licenseKey === 'string' ? body.licenseKey : '';
  const licenseKey = normalizeLicenseKey(rawKey);
  if (licenseKey.length < 8 || licenseKey.length > 128) {
    return c.json({ ok: false, error: 'invalid_license_key' }, 400);
  }

  const keyHash = await sha256Hex(licenseKey);
  const license = await findLicenseByHash(c.env.DB, keyHash);
  if (!license) return c.json({ ok: false, error: 'license_not_found' }, 404);

  const expired = license.status === 'expired' || (license.expires_at !== null && license.expires_at <= now);
  if (expired) return c.json({ ok: false, error: 'license_expired' }, 410);

  const alreadyActivated = await findLicenseActivation(c.env.DB, keyHash, device.id);
  if (!alreadyActivated) {
    if (license.status !== 'active') return c.json({ ok: false, error: 'license_inactive' }, 403);

    const limit = license.activation_limit ?? 3;
    if ((await countLicenseActivations(c.env.DB, keyHash)) >= limit) {
      return c.json({ ok: false, error: 'activation_limit_reached' }, 403);
    }

    const client = creemClientFromEnv(c.env);
    if (!client) return c.json({ ok: false, error: 'billing_unavailable' }, 503);

    try {
      await client.activateLicense(licenseKey, device.id);
    } catch (error) {
      const status = error instanceof CreemError ? error.status : 0;
      console.error(
        'billing_license_activate_failed',
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          status,
        }),
      );
      if (status >= 400 && status < 500) return c.json({ ok: false, error: 'license_activation_rejected' }, 403);
      return c.json({ ok: false, error: 'billing_unavailable' }, 503);
    }
    await recordLicenseActivation(c.env.DB, keyHash, device.id, now);
  }

  if (license.account_id) await linkDevice(c.env.DB, device.id, license.account_id);
  const refreshed = { ...device, account_id: license.account_id ?? device.account_id };
  return c.json(await buildEntitlementPayload(c.env, refreshed, now));
});

app.post('/webhooks/creem', async c => {
  const secret = c.env.CREEM_WEBHOOK_SECRET;
  if (!secret) return c.json({ ok: false, error: 'billing_unavailable' }, 503);

  const rawBody = await c.req.text();
  const valid = await verifyCreemSignature(rawBody, c.req.header('creem-signature') ?? null, secret);
  if (!valid) return c.json({ ok: false, error: 'invalid_signature' }, 401);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, error: 'invalid_payload' }, 400);
  }
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const eventId = typeof record?.id === 'string' ? record.id.trim() : '';
  const eventType =
    typeof record?.eventType === 'string' ? record.eventType : typeof record?.type === 'string' ? record.type : '';
  if (!record || !eventId || !eventType) return c.json({ ok: false, error: 'invalid_payload' }, 400);

  const now = Date.now();
  if (!(await insertWebhookEvent(c.env.DB, eventId, eventType, now))) {
    return c.json({ ok: true, duplicate: true });
  }

  const event: CreemWebhookEvent = {
    id: eventId,
    eventType,
    created_at:
      typeof record.created_at === 'string' || typeof record.created_at === 'number' ? record.created_at : undefined,
    object: record.object,
  };

  try {
    await processCreemEvent(c.env, event, now);
  } catch (error) {
    await deleteWebhookEvent(c.env.DB, eventId);
    console.error(
      'billing_webhook_failed',
      JSON.stringify({
        eventId,
        eventType,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return c.json({ ok: false, error: 'webhook_failed' }, 500);
  }
  return c.json({ ok: true });
});

app.notFound(c => c.json({ ok: false, error: 'not_found' }, 404));

app.onError((error, c) => {
  console.error(
    'billing_worker_error',
    JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
  );
  return c.json({ ok: false, error: 'internal_error' }, 500);
});

const handler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: async (_controller, env) => {
    const now = Date.now();
    const staleReservationsCommitted = await sweepStaleReservations(env.DB, now);
    const rateLimitsPruned = await pruneRateLimits(env.DB, now);
    if (staleReservationsCommitted > 0 || rateLimitsPruned > 0)
      console.log('billing_reconcile', JSON.stringify({ staleReservationsCommitted, rateLimitsPruned, at: now }));
  },
};

export default handler;
export { app };
