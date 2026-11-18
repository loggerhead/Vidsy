import { readEntitlementState } from './entitlement.js';
import { buildSnapshot, signSnapshot } from './snapshot.js';
import type { DeviceRow } from './db.js';
import type { Env } from './env.js';

/**
 * Canonical entitlement payload shared by `/v1/entitlement` and the license
 * activation response. The signed snapshot is the extension's offline source
 * of truth for the 72h grace window.
 */
export const buildEntitlementPayload = async (env: Env, device: DeviceRow, now: number) => {
  const state = await readEntitlementState(env.DB, device, now);
  const plan = state.subscriptionEntitled ? 'pro' : 'free';
  const snapshot = buildSnapshot({
    deviceId: device.id,
    plan,
    subscriptionStatus: state.subscription?.status ?? 'none',
    subscriptionEnd: state.subscription?.currentPeriodEnd ?? null,
    creditBalance: state.credits,
    freeUsed: state.free.used,
    utcDay: state.free.utcDate,
    now,
  });
  const signature = await signSnapshot(snapshot, env.SNAPSHOT_PRIVATE_KEY);

  return {
    ok: true as const,
    plan,
    free: state.free,
    credits: state.credits,
    subscription: state.subscription,
    snapshot,
    signature,
    keyId: env.SNAPSHOT_KEY_ID ?? null,
  };
};
