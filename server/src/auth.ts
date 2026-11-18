/* eslint-disable import-x/exports-last */
import type { DeviceRow } from './db.js';

export type RegisterInput = {
  deviceId: string;
  deviceToken: string;
  name?: string;
};

export type RegisterResult = { ok: true } | { ok: false; reason: 'conflict' };

const encoder = new TextEncoder();

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const parseBearerToken = (header: string | null): string | null => {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
};

/**
 * Resolve a Bearer token to an active device. The raw token is never stored:
 * only SHA-256(token) is compared against `devices.token_hash`.
 */
export const authenticateDevice = async (
  db: D1Database,
  authorizationHeader: string | null,
  now: number,
): Promise<DeviceRow | null> => {
  const token = parseBearerToken(authorizationHeader);
  if (!token || token.length > 256) return null;
  const tokenHash = await sha256Hex(token);
  const device = await db
    .prepare(
      `SELECT id, account_id, name, created_at, last_seen_at, revoked_at
         FROM devices
        WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(tokenHash)
    .first<DeviceRow>();
  if (!device) return null;
  // Throttle last_seen_at writes to keep the hot path read-only.
  if (now - device.last_seen_at > 60 * 60 * 1000) {
    try {
      await db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, device.id).run();
    } catch {
      // Presence bookkeeping must never fail a request.
    }
  }
  return device;
};

/**
 * Register (or refresh) a device. Re-registering the same id+token is
 * idempotent; reusing an id or token across devices is rejected so an attacker
 * cannot hijack an existing installation by guessing its device id.
 */
export const registerDevice = async (db: D1Database, input: RegisterInput, now: number): Promise<RegisterResult> => {
  const tokenHash = await sha256Hex(input.deviceToken);
  const existing = await db
    .prepare('SELECT id, token_hash, revoked_at FROM devices WHERE id = ? OR token_hash = ? LIMIT 1')
    .bind(input.deviceId, tokenHash)
    .first<{ id: string; token_hash: string; revoked_at: number | null }>();

  if (existing) {
    // Revoked tokens stay dead: the user must reinstall to get a new identity.
    if (existing.id !== input.deviceId || existing.token_hash !== tokenHash || existing.revoked_at !== null)
      return { ok: false, reason: 'conflict' };
    await db
      .prepare('UPDATE devices SET last_seen_at = ?, name = COALESCE(?, name) WHERE id = ?')
      .bind(now, input.name ?? null, input.deviceId)
      .run();
    return { ok: true };
  }

  try {
    await db
      .prepare(
        `INSERT INTO devices (id, token_hash, account_id, name, created_at, last_seen_at)
         VALUES (?, ?, NULL, ?, ?, ?)`,
      )
      .bind(input.deviceId, tokenHash, input.name ?? null, now, now)
      .run();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) return { ok: false, reason: 'conflict' };
    throw error;
  }
};
