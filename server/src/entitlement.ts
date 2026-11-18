/* eslint-disable import-x/exports-last */
import { FREE_DAILY_LIMIT, isSubscriptionEntitled, utcDate } from './contract.js';
import {
  findAuthorization,
  getCreditBalance,
  getDailyUsed,
  getSettings,
  getSubscription,
  insertAuthorization,
  reReserveAuthorization,
  transitionAuthorization,
} from './db.js';
import type { FreeQuota, LicenseSource, SubscriptionStatus, SubscriptionSummary } from './contract.js';
import type { DeviceRow, Reservation } from './db.js';
import type { Env } from './env.js';

export type EntitlementState = {
  free: FreeQuota;
  credits: number;
  subscription: SubscriptionSummary;
  subscriptionEntitled: boolean;
};

export type AuthorizeOutcome =
  | { allowed: true; source: LicenseSource; authorizationId: string; state: EntitlementState }
  | { allowed: false; state: EntitlementState };

const freeLimitFrom = (settings: Record<string, string>): number => {
  const parsed = Number.parseInt(settings.free_daily_limit ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : FREE_DAILY_LIMIT;
};

export const isEnforcementOn = (env: Env, settings: Record<string, string>): boolean => {
  if ((env.BILLING_ENFORCEMENT ?? '').trim().toLowerCase() === 'off') return false;
  if ((settings.billing_enforcement ?? '').trim().toLowerCase() === 'off') return false;
  return true;
};

export const readEntitlementState = async (
  db: D1Database,
  device: DeviceRow,
  now: number,
  settings?: Record<string, string>,
): Promise<EntitlementState> => {
  const resolvedSettings = settings ?? (await getSettings(db));
  const day = utcDate(new Date(now));
  const used = await getDailyUsed(db, device.id, day);
  const credits = device.account_id ? await getCreditBalance(db, device.account_id) : 0;
  const row = device.account_id ? await getSubscription(db, device.account_id) : null;
  const status = (row?.status ?? 'none') as SubscriptionStatus;
  const subscription: SubscriptionSummary = row ? { status, currentPeriodEnd: row.current_period_end ?? null } : null;
  const entitled = row
    ? isSubscriptionEntitled({ plan: 'pro', subscriptionStatus: status, subscriptionEnd: row.current_period_end }, now)
    : false;

  return {
    free: { used, limit: freeLimitFrom(resolvedSettings), utcDate: day },
    credits,
    subscription,
    subscriptionEntitled: entitled,
  };
};

const allowed = (state: EntitlementState, source: LicenseSource, authorizationId: string): AuthorizeOutcome => ({
  allowed: true,
  source,
  authorizationId,
  state,
});

/**
 * Reserve a download. Source priority: paid subscription, free daily quota,
 * prepaid credits. A released authorization (retry) is re-reserved under the
 * same downloadKey; reserved/committed duplicates return the original
 * decision without writing.
 */
export const authorizeDownload = async (
  env: Env,
  device: DeviceRow,
  downloadKey: string,
  now: number,
): Promise<AuthorizeOutcome> => {
  const settings = await getSettings(env.DB);
  const enforcement = isEnforcementOn(env, settings);
  const existing = await findAuthorization(env.DB, device.id, downloadKey);
  let state = await readEntitlementState(env.DB, device, now, settings);

  if (existing && existing.state !== 'released') {
    return allowed(state, existing.source, existing.id);
  }

  const candidates: Reservation[] = [];
  if (state.subscriptionEntitled) {
    candidates.push({ source: 'subscription', freeReserved: 0, creditsReserved: 0 });
  }
  if (!enforcement) {
    // Kill switch: allow without consuming quota or credits.
    candidates.push({ source: 'free', freeReserved: 0, creditsReserved: 0 });
  } else {
    if (state.free.used < state.free.limit) candidates.push({ source: 'free', freeReserved: 1, creditsReserved: 0 });
    if (device.account_id && state.credits > 0) {
      candidates.push({ source: 'credits', freeReserved: 0, creditsReserved: 1 });
    }
  }

  for (const reservation of candidates) {
    if (existing) {
      const updated = await reReserveAuthorization(env.DB, existing.id, reservation, now);
      if (updated) {
        state = await readEntitlementState(env.DB, device, now, settings);
        return allowed(state, reservation.source, existing.id);
      }
      // A concurrent request may have won the re-reservation.
      const current = await findAuthorization(env.DB, device.id, downloadKey);
      if (current && current.state !== 'released') return allowed(state, current.source, current.id);
      continue;
    }

    const authorizationId = `auth_${crypto.randomUUID()}`;
    const result = await insertAuthorization(env.DB, {
      id: authorizationId,
      device,
      downloadKey,
      reservation,
      now,
    });
    if (result.ok) {
      state = await readEntitlementState(env.DB, device, now, settings);
      return allowed(state, reservation.source, authorizationId);
    }
    if (result.reason === 'duplicate') {
      const current = await findAuthorization(env.DB, device.id, downloadKey);
      if (current && current.state !== 'released') return allowed(state, current.source, current.id);
      continue;
    }
    // free_quota_exhausted / insufficient_credits: try the next source.
  }

  state = await readEntitlementState(env.DB, device, now, settings);
  return { allowed: false, state };
};

export type ReportOutcome = {
  state: 'reserved' | 'committed' | 'released' | 'unknown';
};

/**
 * Settle a reservation. Success always commits; failure/cancellation releases
 * only when zero bytes moved (bandwidth already spent otherwise). Repeated
 * reports observe the current state and never refund twice.
 */
export const reportDownload = async (
  db: D1Database,
  device: DeviceRow,
  downloadKey: string,
  outcome: 'success' | 'failed' | 'cancelled',
  bytesDownloaded: number,
  now: number,
): Promise<ReportOutcome> => {
  const authorization = await findAuthorization(db, device.id, downloadKey);
  if (!authorization) return { state: 'unknown' };
  if (authorization.state !== 'reserved') return { state: authorization.state };

  const commit = outcome === 'success' || bytesDownloaded > 0;
  await transitionAuthorization(db, authorization.id, commit ? 'committed' : 'released', now);

  const current = await findAuthorization(db, device.id, downloadKey);
  return { state: current?.state ?? (commit ? 'committed' : 'released') };
};
