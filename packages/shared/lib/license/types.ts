/**
 * Billing/licensing contracts shared by the extension UI, background worker and
 * the Cloudflare Worker. Keep this file free of Chrome or Node APIs.
 */

export const FREE_DAILY_LIMIT = 2;
export const OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000;
export const ENTITLEMENT_SNAPSHOT_VERSION = 1 as const;

export type Plan = 'free' | 'pro';

export type LicenseSource = 'free' | 'subscription' | 'credits';

export type AuthorizationState = 'reserved' | 'committed' | 'released';

export type DownloadOutcome = 'success' | 'failed' | 'cancelled';

export type SubscriptionStatus =
  | 'none'
  | 'active'
  | 'trialing'
  | 'scheduled_cancel'
  | 'canceled'
  | 'expired'
  | 'paused';

export type FreeQuota = {
  used: number;
  limit: number;
  utcDate: string;
};

export type SubscriptionSummary = {
  status: SubscriptionStatus;
  currentPeriodEnd: number | null;
  productKey?: string;
} | null;

export type UpgradeOptions = {
  optionsUrl: string;
  pricingUrl: string;
};

export type EntitlementSnapshot = {
  v: typeof ENTITLEMENT_SNAPSHOT_VERSION;
  deviceId: string;
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  subscriptionEnd: number | null;
  creditBalance: number;
  freeUsed: number;
  utcDay: string;
  issuedAt: number;
  expiresAt: number;
};

export type LicenseVerdict = {
  allowed: boolean;
  source?: LicenseSource;
  authorizationId?: string;
  free: FreeQuota;
  credits: number;
  subscription: SubscriptionSummary;
  /** True when the verdict came from a verified offline snapshot. */
  offline?: boolean;
  error?: 'payment_required' | 'unavailable';
  upgrade?: UpgradeOptions;
};

export type AuthorizationRecord = {
  state: AuthorizationState;
  source: LicenseSource;
  authorizationId: string;
  createdAt: number;
  updatedAt: number;
  freeReserved: number;
  creditsReserved: number;
  /** True when the reservation was made locally because the Worker was unreachable. */
  offline?: boolean;
};

/** Reservation details carried by reports for offline-authorized downloads. */
export type OfflineReservation = {
  source: LicenseSource;
  freeReserved: number;
  creditsReserved: number;
  authorizedAt: number;
};

export type PendingReport = {
  downloadKey: string;
  outcome: DownloadOutcome;
  bytesDownloaded: number;
  reportedAt: number;
  /** Present when the Worker had no authorization row for this download key. */
  offline?: OfflineReservation;
};

export type LicenseDeviceRecord = {
  deviceId: string;
  deviceToken: string;
  createdAt: number;
};

export type LicenseLocalUsage = {
  utcDate: string;
  used: number;
  credits: number;
};

export type EntitlementCacheRecord = {
  snapshot: EntitlementSnapshot | null;
  signature: string | null;
  verifiedAt: number | null;
};

export type LicenseAuthorizations = Record<string, AuthorizationRecord>;
