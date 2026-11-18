import { ENTITLEMENT_SNAPSHOT_VERSION, FREE_DAILY_LIMIT } from './types.js';
import type { EntitlementSnapshot, FreeQuota, LicenseLocalUsage, SubscriptionSummary } from './types.js';

/** UTC calendar day (YYYY-MM-DD) used by the free daily quota. */
export const utcDate = (date: Date = new Date()): string => date.toISOString().slice(0, 10);

/**
 * Remaining free downloads for the given usage record. A usage record from a
 * previous UTC day grants a fresh allowance without needing a write.
 */
export const freeRemaining = (usage: Pick<LicenseLocalUsage, 'utcDate' | 'used'>, day = utcDate()): number => {
  if (usage.utcDate !== day) return FREE_DAILY_LIMIT;
  const used = Number.isFinite(usage.used) ? Math.max(0, Math.floor(usage.used)) : 0;
  return Math.max(0, FREE_DAILY_LIMIT - used);
};

export const toFreeQuota = (usage: Pick<LicenseLocalUsage, 'utcDate' | 'used'>, day = utcDate()): FreeQuota => {
  const current = usage.utcDate === day;
  const used = current && Number.isFinite(usage.used) ? Math.max(0, Math.floor(usage.used)) : 0;
  return { used, limit: FREE_DAILY_LIMIT, utcDate: day };
};

/**
 * Subscription entitlement is derived from the latest Creem-driven snapshot:
 * active/trialing are live, scheduled cancellation keeps the paid period, and
 * a canceled subscription keeps access until its current period end.
 */
export const isSubscriptionEntitled = (
  snapshot: Pick<EntitlementSnapshot, 'plan' | 'subscriptionStatus' | 'subscriptionEnd'> | null | undefined,
  now = Date.now(),
): boolean => {
  if (!snapshot || snapshot.plan !== 'pro') return false;
  if (snapshot.subscriptionStatus === 'active' || snapshot.subscriptionStatus === 'trialing') return true;
  if (snapshot.subscriptionStatus === 'scheduled_cancel' || snapshot.subscriptionStatus === 'canceled')
    return typeof snapshot.subscriptionEnd === 'number' && snapshot.subscriptionEnd > now;
  return false;
};

/**
 * A cached snapshot may drive offline decisions only inside its signed 72h
 * window. Signature verification happens before this check.
 */
export const canUseCachedEntitlement = (
  snapshot: Pick<EntitlementSnapshot, 'v' | 'issuedAt' | 'expiresAt'> | null | undefined,
  now = Date.now(),
): boolean => {
  if (!snapshot || snapshot.v !== ENTITLEMENT_SNAPSHOT_VERSION) return false;
  return snapshot.issuedAt <= now && snapshot.expiresAt > now;
};

export const subscriptionSummary = (
  snapshot: Pick<EntitlementSnapshot, 'plan' | 'subscriptionStatus' | 'subscriptionEnd'> | null | undefined,
): SubscriptionSummary => {
  if (!snapshot || snapshot.plan !== 'pro') return null;
  return {
    status: snapshot.subscriptionStatus,
    currentPeriodEnd: snapshot.subscriptionEnd,
  };
};

/** Creem license keys are case-insensitive and may be pasted with whitespace. */
export const normalizeLicenseKey = (key: string): string => key.trim().replace(/\s+/g, '').toUpperCase();

export { LICENSE_MESSAGE } from './messages.js';
export type {
  LicenseActivateResponse,
  LicenseCheckoutResponse,
  LicenseMessageType,
  LicensePortalResponse,
  LicenseStatusPayload,
  LicenseStatusResponse,
} from './messages.js';
export { PRODUCTS, productFromKey, formatPrice } from './products.js';
export type { Product, ProductKind } from './products.js';
export { canonicalSnapshotJson, parseSnapshotPublicKey, verifySnapshotSignature } from './verify.js';
export { FREE_DAILY_LIMIT, OFFLINE_GRACE_MS, ENTITLEMENT_SNAPSHOT_VERSION } from './types.js';
export type {
  AuthorizationRecord,
  AuthorizationState,
  DownloadOutcome,
  EntitlementCacheRecord,
  EntitlementSnapshot,
  FreeQuota,
  LicenseAuthorizations,
  LicenseDeviceRecord,
  LicenseLocalUsage,
  LicenseSource,
  LicenseVerdict,
  OfflineReservation,
  PendingReport,
  Plan,
  SubscriptionStatus,
  SubscriptionSummary,
  UpgradeOptions,
} from './types.js';
