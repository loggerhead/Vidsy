/**
 * Billing contract shared with the extension. The Worker imports the
 * framework-free license module directly instead of the `@extension/shared`
 * barrel, which would drag React/Chrome-only modules into the Worker bundle.
 */
export {
  ENTITLEMENT_SNAPSHOT_VERSION,
  FREE_DAILY_LIMIT,
  OFFLINE_GRACE_MS,
  isSubscriptionEntitled,
  normalizeLicenseKey,
  toFreeQuota,
  utcDate,
} from '../../packages/shared/lib/license/index.js';
export type {
  AuthorizationState,
  DownloadOutcome,
  EntitlementSnapshot,
  FreeQuota,
  LicenseSource,
  Plan,
  SubscriptionStatus,
  SubscriptionSummary,
  UpgradeOptions,
} from '../../packages/shared/lib/license/index.js';
