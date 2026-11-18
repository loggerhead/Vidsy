import type { FreeQuota, Plan, SubscriptionSummary } from './types.js';

/**
 * Cross-context message names for the billing/license surface. The options
 * page and the paywall talk to the background worker through these; keep the
 * strings stable so an old UI tab cannot silently hit an unknown handler.
 */
export const LICENSE_MESSAGE = {
  STATUS: 'license/status',
  REFRESH: 'license/refresh',
  CHECKOUT: 'license/checkout',
  PORTAL: 'license/portal',
  ACTIVATE: 'license/activate',
} as const;

export type LicenseMessageType = (typeof LICENSE_MESSAGE)[keyof typeof LICENSE_MESSAGE];

/** Entitlement snapshot rendered by the License panel and the paywall. */
export type LicenseStatusPayload = {
  free: FreeQuota;
  credits: number;
  subscription: SubscriptionSummary;
  plan: Plan;
  /** True when the last remote call failed and local state is being used. */
  offline: boolean;
  deviceId: string | null;
  pendingReports: number;
};

export type LicenseStatusResponse = { ok: true; status: LicenseStatusPayload } | { ok: false; error: string };

export type LicenseCheckoutResponse = { ok: true; checkoutUrl: string } | { ok: false; error: string; code?: string };

export type LicensePortalResponse = { ok: true; portalUrl: string } | { ok: false; error: string; code?: string };

export type LicenseActivateResponse =
  | { ok: true; status: LicenseStatusPayload }
  | { ok: false; error: string; code?: string };
