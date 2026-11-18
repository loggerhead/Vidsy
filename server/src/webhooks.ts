/* eslint-disable import-x/exports-last */
import {
  ensureAccount,
  findPurchase,
  grantCredits,
  linkDevice,
  recordChargeback,
  recordPurchase,
  revokeAccountSubscriptions,
  saveLicenseKey,
  upsertSubscription,
} from './accounts.js';
import { productFromKey, productKeyFromId } from './products.js';
import type { CustomerIdentity } from './accounts.js';
import type { SubscriptionStatus } from './contract.js';
import type { Env } from './env.js';

export type CreemWebhookEvent = {
  id?: string;
  eventType?: string;
  type?: string;
  created_at?: string | number;
  object?: unknown;
};

type LicenseKeyInfo = {
  key: string;
  status: string;
  activationLimit: number | null;
  expiresAt: number | null;
};

const encoder = new TextEncoder();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Creem timestamps are ISO strings; accept epoch seconds/milliseconds too. */
export const parseTimestamp = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Creem signs the raw request body with HMAC-SHA256 using the webhook secret
 * and sends the lowercase hex digest in `creem-signature`.
 */
export const verifyCreemSignature = async (
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> => {
  if (!signature) return false;
  const provided = signature
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, '');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const expected = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody)));
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return diff === 0;
};

const extractCustomer = (source: Record<string, unknown>): CustomerIdentity => {
  const customer = asRecord(source.customer) ?? {};
  return {
    id: asString(customer.id) ?? asString(source.customer_id),
    email: asString(customer.email) ?? asString(source.customer_email),
  };
};

const extractProductId = (source: Record<string, unknown>): string | null => {
  const product = asRecord(source.product);
  return asString(product?.id) ?? asString(source.product_id);
};

const extractMetadata = (source: Record<string, unknown>): Record<string, unknown> => {
  const raw = source.metadata;
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw)) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(raw) ?? {};
};

/** Order id may sit at the top level (checkout/order) or inside checkout. */
const extractOrderId = (source: Record<string, unknown>): string | null => {
  const order = asRecord(source.order);
  const checkout = asRecord(source.checkout);
  const checkoutOrder = asRecord(checkout?.order);
  return (
    asString(order?.id) ??
    asString(source.order_id) ??
    asString(checkoutOrder?.id) ??
    asString(checkout?.order_id) ??
    asString(checkout?.id)
  );
};

const extractAmountCents = (source: Record<string, unknown>): number => {
  const order = asRecord(source.order);
  const checkoutOrder = asRecord(asRecord(source.checkout)?.order);
  return asFiniteNumber(order?.amount) ?? asFiniteNumber(checkoutOrder?.amount) ?? asFiniteNumber(source.amount) ?? 0;
};

const extractCurrency = (source: Record<string, unknown>): string => {
  const order = asRecord(source.order);
  const checkoutOrder = asRecord(asRecord(source.checkout)?.order);
  return (
    asString(order?.currency) ??
    asString(checkoutOrder?.currency) ??
    asString(source.currency) ??
    'USD'
  ).toUpperCase();
};

const extractLicenseKeys = (source: Record<string, unknown>): LicenseKeyInfo[] => {
  const order = asRecord(source.order);
  const keys: LicenseKeyInfo[] = [];
  for (const candidate of [source.license_keys, order?.license_keys]) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const record = asRecord(entry);
      const key = asString(record?.key);
      if (!key) continue;
      keys.push({
        key,
        status: asString(record?.status) ?? 'active',
        activationLimit: asFiniteNumber(record?.activation_limit),
        expiresAt: parseTimestamp(record?.expires_at),
      });
    }
  }
  return keys;
};

/** Unknown paid states fail closed so a typo can never grant access. */
const mapSubscriptionStatus = (status: string): SubscriptionStatus => {
  switch (status.toLowerCase()) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'scheduled_cancel':
      return 'scheduled_cancel';
    case 'canceled':
      return 'canceled';
    case 'paused':
      return 'paused';
    case 'expired':
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
      return 'expired';
    default:
      return 'expired';
  }
};

const statusForEvent = (eventType: string, rawStatus: string | null): SubscriptionStatus => {
  switch (eventType) {
    case 'subscription.scheduled_cancel':
      return 'scheduled_cancel';
    case 'subscription.canceled':
      return 'canceled';
    case 'subscription.expired':
      return 'expired';
    case 'subscription.paused':
      return 'paused';
    case 'subscription.trialing':
      return 'trialing';
    case 'subscription.paid':
    case 'subscription.active':
      return rawStatus ? mapSubscriptionStatus(rawStatus) : 'active';
    default:
      return rawStatus ? mapSubscriptionStatus(rawStatus) : 'expired';
  }
};

const applySubscription = async (
  env: Env,
  accountId: string,
  source: Record<string, unknown>,
  eventType: string,
  updatedAt: number,
): Promise<void> => {
  const subscriptionId = asString(source.id);
  if (!subscriptionId) return;
  await upsertSubscription(env.DB, {
    id: subscriptionId,
    accountId,
    productId: extractProductId(source) ?? '',
    status: statusForEvent(eventType, asString(source.status)),
    currentPeriodEnd: parseTimestamp(source.current_period_end_date ?? source.current_period_end),
    cancelAtPeriodEnd: eventType === 'subscription.scheduled_cancel' || source.cancel_at_period_end === true ? 1 : 0,
    updatedAt,
  });
};

const handleCheckoutCompleted = async (
  env: Env,
  eventId: string,
  object: Record<string, unknown>,
  now: number,
): Promise<void> => {
  const customer = extractCustomer(object);
  if (!customer.id && !customer.email) {
    console.warn('billing_webhook_checkout_without_customer', JSON.stringify({ eventId }));
    return;
  }

  const metadata = extractMetadata(object);
  const accountId = await ensureAccount(env.DB, customer, now);

  const deviceId = asString(metadata.device_id) ?? asString(object.device_id);
  if (deviceId) await linkDevice(env.DB, deviceId, accountId);

  const productId = extractProductId(object);
  const productKey = asString(metadata.product_key) ?? productKeyFromId(env, productId);
  const product = productKey ? productFromKey(productKey) : undefined;
  const orderId = extractOrderId(object) ?? `checkout_${eventId}`;
  const kind = product?.kind ?? 'credits';
  const credits = product?.credits ?? 0;

  if (!product) {
    console.warn('billing_webhook_unknown_product', JSON.stringify({ eventId, productId, productKey }));
  }

  await recordPurchase(env.DB, {
    id: orderId,
    accountId,
    productId: productId ?? '',
    productKey: productKey ?? 'unknown',
    kind,
    credits,
    amountCents: extractAmountCents(object),
    currency: extractCurrency(object),
    now,
  });

  // The ledger ref `grant:<order_id>` makes duplicate deliveries harmless even
  // when two events raced past the webhook_events claim.
  if (kind === 'credits') await grantCredits(env.DB, accountId, credits, orderId, now);

  for (const license of extractLicenseKeys(object)) {
    await saveLicenseKey(env.DB, {
      key: license.key,
      accountId,
      productId: productId ?? '',
      activationLimit: license.activationLimit ?? product?.licenseActivationLimit ?? null,
      status: license.status,
      expiresAt: license.expiresAt,
      now,
    });
  }

  const subscription = asRecord(object.subscription);
  if (subscription) await applySubscription(env, accountId, subscription, 'checkout.completed', now);
};

const handleSubscriptionEvent = async (
  env: Env,
  eventType: string,
  object: Record<string, unknown>,
  updatedAt: number,
): Promise<void> => {
  const customer = extractCustomer(object);
  if (!customer.id && !customer.email) {
    console.warn('billing_webhook_subscription_without_customer', JSON.stringify({ eventType }));
    return;
  }
  const accountId = await ensureAccount(env.DB, customer, updatedAt);
  await applySubscription(env, accountId, object, eventType, updatedAt);
};

const handleRefundOrDispute = async (
  env: Env,
  eventId: string,
  eventType: string,
  object: Record<string, unknown>,
  now: number,
): Promise<void> => {
  // Pending refunds can still fail; only succeeded (or unspecified) ones reverse.
  const status = asString(object.status);
  if (eventType === 'refund.created' && status && status.toLowerCase() !== 'succeeded') return;

  const orderId = extractOrderId(object);
  const purchase = orderId ? await findPurchase(env.DB, orderId) : null;
  if (!purchase) {
    console.warn('billing_webhook_reversal_unknown_order', JSON.stringify({ eventId, eventType, orderId }));
    return;
  }

  // The ref is order-scoped so a refund and a later dispute for the same
  // purchase cannot reverse the credits twice.
  await recordChargeback(env.DB, purchase.account_id, purchase.credits, orderId ?? eventId, now);
  if (purchase.kind === 'subscription') {
    await revokeAccountSubscriptions(env.DB, purchase.account_id, now);
  }
};

/**
 * Dispatch a verified Creem event. Unknown event types are acknowledged so
 * Creem stops retrying them; processing failures bubble up so the caller can
 * release the idempotency claim and let Creem redeliver.
 */
export const processCreemEvent = async (env: Env, event: CreemWebhookEvent, now: number): Promise<void> => {
  const eventType = event.eventType ?? event.type ?? 'unknown';
  const object = asRecord(event.object) ?? {};
  const eventId = event.id ?? '';
  // Subscription updates are ordered by the event time so a delayed event
  // cannot resurrect a newer cancellation.
  const eventTime = parseTimestamp(event.created_at) ?? now;

  if (eventType === 'checkout.completed') {
    await handleCheckoutCompleted(env, eventId, object, eventTime);
    return;
  }
  if (eventType.startsWith('subscription.')) {
    await handleSubscriptionEvent(env, eventType, object, eventTime);
    return;
  }
  if (eventType === 'refund.created' || eventType === 'dispute.created') {
    await handleRefundOrDispute(env, eventId, eventType, object, eventTime);
  }
};
