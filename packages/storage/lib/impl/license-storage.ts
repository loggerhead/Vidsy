import { createStorage, StorageEnum } from '../base/index.js';

// Local copies to avoid depending on @extension/shared and introducing a cycle.
type LicenseSource = 'free' | 'subscription' | 'credits';
type AuthorizationState = 'reserved' | 'committed' | 'released';
type DownloadOutcome = 'success' | 'failed' | 'cancelled';
type SubscriptionStatus = 'none' | 'active' | 'trialing' | 'scheduled_cancel' | 'canceled' | 'expired' | 'paused';
type Plan = 'free' | 'pro';

type LicenseDeviceRecord = {
  deviceId: string;
  deviceToken: string;
  createdAt: number;
};

type EntitlementSnapshot = {
  v: 1;
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

type EntitlementCacheRecord = {
  snapshot: EntitlementSnapshot | null;
  signature: string | null;
  verifiedAt: number | null;
};

type LicenseLocalUsage = {
  utcDate: string;
  used: number;
  credits: number;
};

type AuthorizationRecord = {
  state: AuthorizationState;
  source: LicenseSource;
  authorizationId: string;
  createdAt: number;
  updatedAt: number;
  freeReserved: number;
  creditsReserved: number;
};

type LicenseAuthorizations = Record<string, AuthorizationRecord>;

type PendingReport = {
  downloadKey: string;
  outcome: DownloadOutcome;
  bytesDownloaded: number;
  reportedAt: number;
};

const EMPTY_USAGE: LicenseLocalUsage = { utcDate: '', used: 0, credits: 0 };
const EMPTY_ENTITLEMENT: EntitlementCacheRecord = { snapshot: null, signature: null, verifiedAt: null };

/**
 * Device identity is created once per installation. The token is the bearer
 * credential for the billing Worker; it stays in local storage and is never
 * synced across profiles.
 */
export const licenseDeviceStorage = createStorage<LicenseDeviceRecord | null>('license-device', null, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

/** Last verified entitlement snapshot + ECDSA signature for offline grace. */
export const licenseEntitlementStorage = createStorage<EntitlementCacheRecord>(
  'license-entitlement',
  EMPTY_ENTITLEMENT,
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

/** Local free quota and cached credit balance, keyed by UTC day. */
export const licenseLocalUsageStorage = createStorage<LicenseLocalUsage>('license-local-usage', EMPTY_USAGE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

/**
 * Per-download authorization ledger. It lets resume skip authorization and
 * tells retry whether the previous authorization was released (needs a new
 * reservation) or committed (already paid for).
 */
export const licenseAuthorizationsStorage = createStorage<LicenseAuthorizations>(
  'license-authorizations',
  {},
  {
    storageEnum: StorageEnum.Local,
  },
);

/** Reports recorded while offline or while the Worker was unavailable. */
export const licensePendingReportsStorage = createStorage<PendingReport[]>('license-pending-reports', [], {
  storageEnum: StorageEnum.Local,
});

export type {
  AuthorizationRecord,
  AuthorizationState,
  DownloadOutcome,
  EntitlementCacheRecord,
  EntitlementSnapshot,
  LicenseAuthorizations,
  LicenseDeviceRecord,
  LicenseLocalUsage,
  LicenseSource,
  PendingReport,
  Plan,
  SubscriptionStatus,
};
