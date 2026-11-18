/* eslint-disable import-x/exports-last */
import type {
  EntitlementSnapshot,
  FreeQuota,
  LicenseSource,
  OfflineReservation,
  Plan,
  SubscriptionSummary,
  UpgradeOptions,
} from '@extension/shared';

export const DEFAULT_BILLING_API_URL = 'https://uuget.uu0uu.com';
const REQUEST_TIMEOUT_MS = 8000;

export type BillingIdentity = { deviceId: string; deviceToken: string };

export type RemoteEntitlement = {
  plan: Plan;
  free: FreeQuota;
  credits: number;
  subscription: SubscriptionSummary;
  snapshot: EntitlementSnapshot | null;
  signature: string | null;
  keyId: string | null;
};

export type RemoteAuthorization =
  | {
      allowed: true;
      source: LicenseSource;
      authorizationId: string;
      free: FreeQuota;
      credits: number;
      subscription: SubscriptionSummary;
    }
  | {
      allowed: false;
      error: 'payment_required';
      free: FreeQuota;
      credits: number;
      subscription: SubscriptionSummary;
      upgrade?: UpgradeOptions;
    };

export type RemoteReportState = 'reserved' | 'committed' | 'released' | 'unknown';

export type BillingRemote = {
  authorize: (input: { downloadKey: string; kind?: string; urlHash?: string }) => Promise<RemoteAuthorization>;
  report: (input: {
    downloadKey: string;
    outcome: 'success' | 'failed' | 'cancelled';
    bytesDownloaded: number;
    /** Reservation made locally while the Worker was unreachable. */
    offline?: OfflineReservation;
  }) => Promise<{ state: RemoteReportState }>;
  fetchEntitlement: () => Promise<RemoteEntitlement>;
  checkout: (productKey: string) => Promise<{ checkoutUrl: string }>;
  portal: () => Promise<{ portalUrl: string }>;
  activate: (licenseKey: string) => Promise<RemoteEntitlement>;
};

export type BillingErrorCode =
  | 'billing_unavailable'
  | 'unauthorized'
  | 'rate_limited'
  | 'invalid_request'
  | 'invalid_product'
  | 'account_not_found'
  | 'invalid_license_key'
  | 'license_not_found'
  | 'license_expired'
  | 'license_inactive'
  | 'activation_limit_reached'
  | 'license_activation_rejected';

/**
 * Network failure, timeout, or 5xx. `allowLocalFallback` is true only when the
 * Worker is unreachable, which lets the extension fall back to its cached
 * free quota/credits instead of blocking every download.
 */
export class BillingUnavailableError extends Error {
  readonly code = 'billing_unavailable' as const;
  readonly allowLocalFallback: boolean;
  readonly status: number | null;

  constructor(message: string, options: { allowLocalFallback: boolean; status?: number | null }) {
    super(message);
    this.name = 'BillingUnavailableError';
    this.allowLocalFallback = options.allowLocalFallback;
    this.status = options.status ?? null;
  }
}

/** A reachable Worker refused the request; never fall back to local authority. */
export class BillingRequestError extends Error {
  readonly code: BillingErrorCode;
  readonly status: number | null;

  constructor(code: BillingErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'BillingRequestError';
    this.code = code;
    this.status = status;
  }
}

const REQUEST_ERROR_CODES: Record<string, BillingErrorCode> = {
  unauthorized: 'unauthorized',
  rate_limited: 'rate_limited',
  invalid_device: 'invalid_request',
  device_conflict: 'invalid_request',
  invalid_download_key: 'invalid_request',
  invalid_outcome: 'invalid_request',
  invalid_product: 'invalid_product',
  account_not_found: 'account_not_found',
  invalid_license_key: 'invalid_license_key',
  license_not_found: 'license_not_found',
  license_expired: 'license_expired',
  license_inactive: 'license_inactive',
  activation_limit_reached: 'activation_limit_reached',
  license_activation_rejected: 'license_activation_rejected',
};

const REQUEST_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: 'This device is not authorized. Reload the extension and try again.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  invalid_product: 'This product is not available.',
  account_not_found: 'No purchase is linked to this device yet.',
  invalid_license_key: 'Enter a valid license key from your Creem email.',
  license_not_found: 'That license key was not found.',
  license_expired: 'That license key has expired.',
  license_inactive: 'That license key is not active.',
  activation_limit_reached: 'This license key reached its device limit. Deactivate another device first.',
  license_activation_rejected: 'Creem rejected the license activation.',
  device_conflict: 'Device registration conflict. Reinstall the extension to get a new device identity.',
};

const SUBSCRIPTION_STATUSES = new Set([
  'none',
  'active',
  'trialing',
  'scheduled_cancel',
  'canceled',
  'expired',
  'paused',
]);

type SubscriptionInfo = NonNullable<SubscriptionSummary>;

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeFree = (value: unknown): FreeQuota => {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    used: Math.max(0, Math.trunc(asNumber(record.used))),
    limit: Math.max(0, Math.trunc(asNumber(record.limit))),
    utcDate: typeof record.utcDate === 'string' ? record.utcDate : '',
  };
};

const normalizeSubscription = (value: unknown): SubscriptionSummary => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const status = typeof record.status === 'string' && SUBSCRIPTION_STATUSES.has(record.status) ? record.status : 'none';
  return {
    status: status as SubscriptionInfo['status'],
    currentPeriodEnd:
      typeof record.currentPeriodEnd === 'number' && Number.isFinite(record.currentPeriodEnd)
        ? record.currentPeriodEnd
        : null,
  };
};

const normalizeSnapshot = (value: unknown): EntitlementSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.deviceId !== 'string') return null;
  if (typeof record.issuedAt !== 'number' || typeof record.expiresAt !== 'number') return null;
  const subscription = normalizeSubscription({
    status: record.subscriptionStatus,
    currentPeriodEnd: record.subscriptionEnd,
  });
  return {
    v: 1,
    deviceId: record.deviceId,
    plan: record.plan === 'pro' ? 'pro' : 'free',
    subscriptionStatus: subscription?.status ?? 'none',
    subscriptionEnd:
      typeof record.subscriptionEnd === 'number' && Number.isFinite(record.subscriptionEnd)
        ? record.subscriptionEnd
        : null,
    creditBalance: Math.trunc(asNumber(record.creditBalance)),
    freeUsed: Math.max(0, Math.trunc(asNumber(record.freeUsed))),
    utcDay: typeof record.utcDay === 'string' ? record.utcDay : '',
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  };
};

const normalizeEntitlement = (body: Record<string, unknown>): RemoteEntitlement => ({
  plan: body.plan === 'pro' ? 'pro' : 'free',
  free: normalizeFree(body.free),
  credits: Math.max(0, Math.trunc(asNumber(body.credits))),
  subscription: normalizeSubscription(body.subscription),
  snapshot: normalizeSnapshot(body.snapshot),
  signature: typeof body.signature === 'string' ? body.signature : null,
  keyId: typeof body.keyId === 'string' ? body.keyId : null,
});

const readEnv = (): Record<string, string | undefined> => {
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  } catch {
    return {};
  }
};

type JsonResponse = { status: number; body: Record<string, unknown> | null };

export type BillingRemoteOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Minimal Worker client. It never stores credentials beyond the device token
 * that `getIdentity` already keeps in `chrome.storage.local`; every request is
 * an ordinary HTTPS call so the extension build contains no Creem secrets.
 */
export const createBillingRemote = (
  getIdentity: () => Promise<BillingIdentity>,
  options: BillingRemoteOptions = {},
): BillingRemote => {
  const env = readEnv();
  const baseUrl = (
    options.baseUrl ??
    env.WXT_BILLING_API_URL ??
    env.VITE_BILLING_API_URL ??
    DEFAULT_BILLING_API_URL
  ).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const send = async (
    path: string,
    init: { method?: 'GET' | 'POST'; token?: string; body?: unknown } = {},
  ): Promise<JsonResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: Record<string, unknown> | null = null;
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      return { status: response.status, body };
    } catch {
      throw new BillingUnavailableError(
        controller.signal.aborted ? 'Billing request timed out' : 'Billing service is unreachable',
        { allowLocalFallback: true },
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const errorFor = (status: number, body: Record<string, unknown> | null, fallback: string): Error => {
    const serverError = typeof body?.error === 'string' ? body.error : '';
    if (status >= 500) {
      return new BillingUnavailableError(
        REQUEST_ERROR_MESSAGES[serverError] ?? 'Billing service is temporarily unavailable.',
        { allowLocalFallback: true, status },
      );
    }
    const code = REQUEST_ERROR_CODES[serverError] ?? (status === 401 ? 'unauthorized' : 'invalid_request');
    return new BillingRequestError(code, REQUEST_ERROR_MESSAGES[serverError] ?? fallback, status);
  };

  let registration: Promise<void> | undefined;
  const ensureRegistered = (): Promise<void> =>
    (registration ??= (async () => {
      const identity = await getIdentity();
      const { status, body } = await send('/v1/devices/register', {
        method: 'POST',
        body: { deviceId: identity.deviceId, deviceToken: identity.deviceToken, name: 'UUGet' },
      });
      if (status === 200 && body?.ok === true) return;
      throw errorFor(status, body, 'Device registration failed');
    })().catch(error => {
      registration = undefined;
      throw error;
    }));

  const authedSend = async (
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<JsonResponse> => {
    await ensureRegistered();
    const identity = await getIdentity();
    const first = await send(path, { ...init, token: identity.deviceToken });
    if (first.status !== 401) return first;
    // The Worker may have lost this device row (database reset, account
    // deletion). Re-register once before treating the token as revoked.
    registration = undefined;
    await ensureRegistered();
    const refreshed = await getIdentity();
    return send(path, { ...init, token: refreshed.deviceToken });
  };

  const authorize: BillingRemote['authorize'] = async input => {
    const { status, body } = await authedSend('/v1/download/authorize', { method: 'POST', body: input });
    if (status === 200 && body?.allowed === true) {
      if (typeof body.authorizationId !== 'string' || body.authorizationId.length === 0) {
        // A 200 without an authorization id is not safe to treat as offline:
        // the Worker may already have reserved quota for this key.
        throw new BillingUnavailableError('Billing service returned an invalid authorization', {
          allowLocalFallback: false,
          status,
        });
      }
      const source: LicenseSource = body.source === 'credits' || body.source === 'subscription' ? body.source : 'free';
      return {
        allowed: true,
        source,
        authorizationId: body.authorizationId,
        free: normalizeFree(body.free),
        credits: Math.max(0, Math.trunc(asNumber(body.credits))),
        subscription: normalizeSubscription(body.subscription),
      };
    }
    if (status === 402 && body?.allowed === false) {
      return {
        allowed: false,
        error: 'payment_required',
        free: normalizeFree(body.free),
        credits: Math.max(0, Math.trunc(asNumber(body.credits))),
        subscription: normalizeSubscription(body.subscription),
        ...(body.upgrade && typeof body.upgrade === 'object' ? { upgrade: body.upgrade as UpgradeOptions } : {}),
      };
    }
    throw errorFor(status, body, 'Download authorization failed');
  };

  const report: BillingRemote['report'] = async input => {
    const { status, body } = await authedSend('/v1/download/report', { method: 'POST', body: input });
    if (status === 200 && body?.ok === true) {
      const state = body.state;
      return {
        state: state === 'reserved' || state === 'committed' || state === 'released' ? state : 'unknown',
      };
    }
    throw errorFor(status, body, 'Download report failed');
  };

  const fetchEntitlement: BillingRemote['fetchEntitlement'] = async () => {
    const { status, body } = await authedSend('/v1/entitlement', { method: 'GET' });
    if (status === 200 && body?.ok === true) return normalizeEntitlement(body);
    throw errorFor(status, body, 'Entitlement refresh failed');
  };

  const checkout: BillingRemote['checkout'] = async productKey => {
    const { status, body } = await authedSend('/v1/checkout', { method: 'POST', body: { productKey } });
    if (status === 200 && body?.ok === true && typeof body.checkoutUrl === 'string')
      return { checkoutUrl: body.checkoutUrl };
    throw errorFor(status, body, 'Checkout could not be started.');
  };

  const portal: BillingRemote['portal'] = async () => {
    const { status, body } = await authedSend('/v1/portal', { method: 'POST', body: {} });
    if (status === 200 && body?.ok === true && typeof body.portalUrl === 'string') return { portalUrl: body.portalUrl };
    throw errorFor(status, body, 'Subscription management is unavailable.');
  };

  const activate: BillingRemote['activate'] = async licenseKey => {
    const { status, body } = await authedSend('/v1/license/activate', {
      method: 'POST',
      body: { licenseKey },
    });
    if (status === 200 && body?.ok === true) return normalizeEntitlement(body);
    throw errorFor(status, body, 'License activation failed.');
  };

  return { authorize, report, fetchEntitlement, checkout, portal, activate };
};
