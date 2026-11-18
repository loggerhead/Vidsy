/* eslint-disable import-x/exports-last */
import type { AuthorizationState, LicenseSource } from './contract.js';

export type DeviceRow = {
  id: string;
  account_id: string | null;
  name: string | null;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
};

export type AuthorizationRow = {
  id: string;
  device_id: string;
  account_id: string | null;
  download_key: string;
  source: LicenseSource;
  state: AuthorizationState;
  credits_reserved: number;
  free_reserved: number;
  created_at: number;
  updated_at: number;
};

export type SubscriptionRow = {
  id: string;
  status: string;
  current_period_end: number | null;
  product_id: string;
  cancel_at_period_end: number;
};

export type Reservation = {
  source: LicenseSource;
  freeReserved: number;
  creditsReserved: number;
};

export type WriteFailureReason = 'duplicate' | 'free_quota_exhausted' | 'insufficient_credits';

export type InsertAuthorizationResult = { ok: true } | { ok: false; reason: WriteFailureReason };

export type RateLimitResult = {
  allowed: boolean;
  retryAfter: number;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Map trigger RAISE messages and unique violations to actionable outcomes. */
const classifyWriteError = (error: unknown): WriteFailureReason | null => {
  const message = errorMessage(error);
  if (/free_quota_exhausted/i.test(message)) return 'free_quota_exhausted';
  if (/insufficient_credits/i.test(message)) return 'insufficient_credits';
  if (/UNIQUE constraint failed/i.test(message)) return 'duplicate';
  return null;
};

export const getSettings = async (db: D1Database): Promise<Record<string, string>> => {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  return Object.fromEntries((results ?? []).map(row => [row.key, row.value]));
};

export const getDailyUsed = async (db: D1Database, deviceId: string, utcDay: string): Promise<number> => {
  const row = await db
    .prepare('SELECT used FROM daily_usage WHERE device_id = ? AND utc_date = ?')
    .bind(deviceId, utcDay)
    .first<{ used: number }>();
  return Math.max(0, row?.used ?? 0);
};

export const getCreditBalance = async (db: D1Database, accountId: string): Promise<number> => {
  const row = await db
    .prepare('SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_ledger WHERE account_id = ?')
    .bind(accountId)
    .first<{ balance: number }>();
  return Math.trunc(row?.balance ?? 0);
};

export const getSubscription = async (db: D1Database, accountId: string): Promise<SubscriptionRow | null> =>
  db
    .prepare(
      `SELECT id, status, current_period_end, product_id, cancel_at_period_end
         FROM subscriptions
        WHERE account_id = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .bind(accountId)
    .first<SubscriptionRow>();

export const findAuthorization = async (
  db: D1Database,
  deviceId: string,
  downloadKey: string,
): Promise<AuthorizationRow | null> =>
  db
    .prepare(
      `SELECT id, device_id, account_id, download_key, source, state,
              credits_reserved, free_reserved, created_at, updated_at
         FROM authorizations
        WHERE device_id = ? AND download_key = ?`,
    )
    .bind(deviceId, downloadKey)
    .first<AuthorizationRow>();

/**
 * Insert a fresh reservation. The free/credits triggers inside the INSERT make
 * quota claiming atomic; a unique violation means a concurrent authorize for
 * the same downloadKey won the race.
 */
export const insertAuthorization = async (
  db: D1Database,
  input: { id: string; device: DeviceRow; downloadKey: string; reservation: Reservation; now: number },
): Promise<InsertAuthorizationResult> => {
  try {
    await db
      .prepare(
        `INSERT INTO authorizations
           (id, device_id, account_id, download_key, source, state,
            credits_reserved, free_reserved, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.device.id,
        input.device.account_id,
        input.downloadKey,
        input.reservation.source,
        input.reservation.creditsReserved,
        input.reservation.freeReserved,
        input.now,
        input.now,
      )
      .run();
    return { ok: true };
  } catch (error) {
    const reason = classifyWriteError(error);
    if (reason) return { ok: false, reason };
    throw error;
  }
};

/**
 * Re-reserve a released authorization for a retry. Returns false when another
 * request already moved it out of `released` or the trigger rejected the new
 * reservation (quota/credits), so the caller can try the next source.
 */
export const reReserveAuthorization = async (
  db: D1Database,
  authorizationId: string,
  reservation: Reservation,
  now: number,
): Promise<boolean> => {
  try {
    const result = await db
      .prepare(
        `UPDATE authorizations
            SET state = 'reserved',
                source = ?,
                free_reserved = ?,
                credits_reserved = ?,
                created_at = ?,
                updated_at = MAX(updated_at + 1, ?)
          WHERE id = ? AND state = 'released'`,
      )
      .bind(reservation.source, reservation.freeReserved, reservation.creditsReserved, now, now, authorizationId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  } catch (error) {
    if (classifyWriteError(error)) return false;
    throw error;
  }
};

/** Commit or release a reserved authorization. Returns false when already final. */
export const transitionAuthorization = async (
  db: D1Database,
  authorizationId: string,
  state: 'committed' | 'released',
  now: number,
): Promise<boolean> => {
  const result = await db
    .prepare(
      `UPDATE authorizations
          SET state = ?, updated_at = MAX(updated_at + 1, ?)
        WHERE id = ? AND state = 'reserved'`,
    )
    .bind(state, now, authorizationId)
    .run();
  return (result.meta.changes ?? 0) > 0;
};

/**
 * Record a download that was authorized locally while the Worker was
 * unreachable. The insert is idempotent through the (device_id, download_key)
 * unique constraint; quota/credit effects are applied explicitly because the
 * offline reservation may legitimately exceed the online limits (requirement
 * §6.6 allows a negative credit balance that later grants offset).
 */
export const insertOfflineAuthorization = async (
  db: D1Database,
  input: {
    device: DeviceRow;
    downloadKey: string;
    source: LicenseSource;
    freeReserved: number;
    creditsReserved: number;
    authorizedAt: number;
    committed: boolean;
    now: number;
  },
): Promise<{ recorded: boolean; state: 'committed' | 'released' }> => {
  const freeReserved = Math.min(1, Math.max(0, Math.trunc(input.freeReserved)));
  const creditsReserved = Math.min(1, Math.max(0, Math.trunc(input.creditsReserved)));
  const id = `auth_${crypto.randomUUID()}`;
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO authorizations
         (id, device_id, account_id, download_key, source, state,
          credits_reserved, free_reserved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    .bind(
      id,
      input.device.id,
      input.device.account_id,
      input.downloadKey,
      input.source,
      input.committed ? 'committed' : 'released',
      input.authorizedAt,
      input.now,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    const existing = await findAuthorization(db, input.device.id, input.downloadKey);
    return { recorded: false, state: existing?.state === 'released' ? 'released' : 'committed' };
  }
  if (!input.committed) return { recorded: true, state: 'released' };

  if (input.source === 'free' && freeReserved > 0) {
    await db
      .prepare(
        `INSERT INTO daily_usage (device_id, utc_date, used)
         VALUES (?, strftime('%Y-%m-%d', ? / 1000, 'unixepoch'), 1)
         ON CONFLICT(device_id, utc_date) DO UPDATE SET used = used + 1`,
      )
      .bind(input.device.id, input.authorizedAt)
      .run();
  }
  if (input.source === 'credits' && creditsReserved > 0 && input.device.account_id) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO credit_ledger (id, account_id, delta, reason, ref, created_at)
         VALUES (?, ?, ?, 'reserve', ?, ?)`,
      )
      .bind(`offline:${id}`, input.device.account_id, -creditsReserved, `offline:${id}`, input.now)
      .run();
  }
  return { recorded: true, state: 'committed' };
};

/** Revoke a single device token (account deletion without an account). */
export const revokeDevice = async (db: D1Database, deviceId: string, now: number): Promise<void> => {
  await db
    .prepare('UPDATE devices SET revoked_at = ?, account_id = NULL WHERE id = ? AND revoked_at IS NULL')
    .bind(now, deviceId)
    .run();
};

/**
 * Account deletion policy (§7 M4): anonymize the account, revoke every device
 * token, revoke subscriptions and license keys, and drop activation bindings.
 * Purchases and the credit ledger are retained as financial records under the
 * (now anonymized) account id.
 */
export const deleteAccountData = async (db: D1Database, accountId: string, now: number): Promise<void> => {
  await db.batch([
    db
      .prepare(
        `DELETE FROM license_activations
          WHERE key_hash IN (SELECT key_hash FROM license_keys WHERE account_id = ?)`,
      )
      .bind(accountId),
    db.prepare("UPDATE license_keys SET status = 'revoked', account_id = NULL WHERE account_id = ?").bind(accountId),
    db
      .prepare(
        "UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE account_id = ? AND status != 'expired'",
      )
      .bind(now, accountId),
    db
      .prepare('UPDATE devices SET revoked_at = ?, account_id = NULL WHERE account_id = ? AND revoked_at IS NULL')
      .bind(now, accountId),
    db
      .prepare('UPDATE accounts SET email = ?, creem_customer_id = NULL, deleted_at = ? WHERE id = ?')
      .bind(`deleted+${accountId}@deleted.invalid`, now, accountId),
  ]);
};

/**
 * Stale reservations older than 24h are committed conservatively (the user may
 * have downloaded without reporting). Supports manual refunds later.
 */
export const sweepStaleReservations = async (db: D1Database, now: number, maxAgeMs = 24 * 60 * 60 * 1000) => {
  const result = await db
    .prepare(
      `UPDATE authorizations
          SET state = 'committed', updated_at = MAX(updated_at + 1, ?)
        WHERE state = 'reserved' AND updated_at < ?`,
    )
    .bind(now, now - maxAgeMs)
    .run();
  return result.meta.changes ?? 0;
};

/**
 * Claim a webhook event id for processing. Returns false when the event was
 * already received, which makes duplicate Creem deliveries cheap no-ops.
 */
export const insertWebhookEvent = async (db: D1Database, id: string, type: string, now: number): Promise<boolean> => {
  const result = await db
    .prepare('INSERT OR IGNORE INTO webhook_events (id, type, received_at) VALUES (?, ?, ?)')
    .bind(id, type, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
};

/** Failed processing releases the claim so Creem's retry is handled again. */
export const deleteWebhookEvent = async (db: D1Database, id: string): Promise<void> => {
  await db.prepare('DELETE FROM webhook_events WHERE id = ?').bind(id).run();
};

/** Fixed-window counter. The window start is part of the bucket key. */
export const consumeRateLimit = async (
  db: D1Database,
  bucket: string,
  windowMs: number,
  limit: number,
  now: number,
): Promise<RateLimitResult> => {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `${bucket}:${windowStart}`;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return {
    allowed: count <= limit,
    retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
  };
};

export const pruneRateLimits = async (db: D1Database, now: number, keepMs = 7 * 24 * 60 * 60 * 1000) => {
  const result = await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(now - keepMs)
    .run();
  return result.meta.changes ?? 0;
};
