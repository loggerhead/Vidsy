import { ENTITLEMENT_SNAPSHOT_VERSION } from './types.js';
import type { EntitlementSnapshot } from './types.js';

const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const binary = atob(value);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
};

/**
 * Canonical snapshot serialization shared with the Worker signer. The field
 * order is part of the signing contract; changing it requires a snapshot
 * version bump on both sides.
 */
export const canonicalSnapshotJson = (snapshot: EntitlementSnapshot): string =>
  JSON.stringify({
    v: snapshot.v,
    deviceId: snapshot.deviceId,
    plan: snapshot.plan,
    subscriptionStatus: snapshot.subscriptionStatus,
    subscriptionEnd: snapshot.subscriptionEnd,
    creditBalance: snapshot.creditBalance,
    freeUsed: snapshot.freeUsed,
    utcDay: snapshot.utcDay,
    issuedAt: snapshot.issuedAt,
    expiresAt: snapshot.expiresAt,
  });

/**
 * Verify an ECDSA P-256 (SHA-256) signature produced by the Worker over the
 * canonical snapshot bytes. Any malformed input fails closed.
 */
export const verifySnapshotSignature = async (
  snapshot: EntitlementSnapshot,
  signature: string | null | undefined,
  publicKeyJwk: JsonWebKey | null | undefined,
): Promise<boolean> => {
  if (!signature || !publicKeyJwk) return false;
  if (snapshot.v !== ENTITLEMENT_SNAPSHOT_VERSION) return false;
  const signatureBytes = decodeBase64(signature);
  if (!signatureBytes) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signatureBytes,
      new TextEncoder().encode(canonicalSnapshotJson(snapshot)),
    );
  } catch {
    return false;
  }
};

/** Parse a public JWK supplied at build time (`WXT_SNAPSHOT_PUBLIC_KEY`). */
export const parseSnapshotPublicKey = (value: string | null | undefined): JsonWebKey | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const jwk = parsed as JsonWebKey;
    return jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string'
      ? jwk
      : null;
  } catch {
    return null;
  }
};
