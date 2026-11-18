/* eslint-disable import-x/exports-last */
import { ENTITLEMENT_SNAPSHOT_VERSION, OFFLINE_GRACE_MS } from './contract.js';
import type { EntitlementSnapshot, Plan, SubscriptionStatus } from './contract.js';

export type SnapshotInput = {
  deviceId: string;
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  subscriptionEnd: number | null;
  creditBalance: number;
  freeUsed: number;
  utcDay: string;
  now: number;
};

/**
 * Snapshot field order is part of the signing contract: the extension verifies
 * ECDSA over the UTF-8 bytes of `JSON.stringify(snapshot)`. Keep this literal
 * order stable, or bump ENTITLEMENT_SNAPSHOT_VERSION and update the verifier.
 */
export const buildSnapshot = (input: SnapshotInput): EntitlementSnapshot => ({
  v: ENTITLEMENT_SNAPSHOT_VERSION,
  deviceId: input.deviceId,
  plan: input.plan,
  subscriptionStatus: input.subscriptionStatus,
  subscriptionEnd: input.subscriptionEnd,
  creditBalance: input.creditBalance,
  freeUsed: input.freeUsed,
  utcDay: input.utcDay,
  issuedAt: input.now,
  expiresAt: input.now + OFFLINE_GRACE_MS,
});

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const encodeBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * Sign the snapshot with ECDSA P-256 (SHA-256, raw r||s as produced by
 * WebCrypto). Returns null when signing is not configured so local dev keeps
 * working without secrets; M4 treats a missing signature as "no snapshot".
 */
export const signSnapshot = async (
  snapshot: EntitlementSnapshot,
  privateKeyBase64: string | undefined,
): Promise<string | null> => {
  if (!privateKeyBase64) return null;
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      decodeBase64(privateKeyBase64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(JSON.stringify(snapshot)),
    );
    return encodeBase64(signature);
  } catch {
    return null;
  }
};
