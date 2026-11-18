/* eslint-disable import-x/exports-last */
import { sha256Hex } from './auth.js';
import { normalizeLicenseKey } from './contract.js';
import type { SubscriptionStatus } from './contract.js';

export type AccountRow = {
  id: string;
  email: string;
  creem_customer_id: string | null;
};

export type LicenseKeyRow = {
  key_hash: string;
  key_last4: string;
  account_id: string | null;
  product_id: string;
  activation_limit: number | null;
  status: string;
  expires_at: number | null;
  created_at: number;
};

export type CustomerIdentity = {
  id: string | null;
  email: string | null;
};

export type PurchaseRow = {
  id: string;
  account_id: string;
  product_id: string;
  product_key: string;
  kind: 'credits' | 'subscription';
  credits: number;
  amount_cents: number;
  currency: string;
  created_at: number;
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const findAccountById = async (db: D1Database, accountId: string): Promise<AccountRow | null> =>
  db
    .prepare('SELECT id, email, creem_customer_id FROM accounts WHERE id = ? AND deleted_at IS NULL')
    .bind(accountId)
    .first<AccountRow>();

/** Resolve an existing account by Creem customer id or email; never creates. */
export const findAccount = async (db: D1Database, customer: CustomerIdentity): Promise<AccountRow | null> => {
  if (customer.id) {
    const byCustomer = await db
      .prepare('SELECT id, email, creem_customer_id FROM accounts WHERE creem_customer_id = ? AND deleted_at IS NULL')
      .bind(customer.id)
      .first<AccountRow>();
    if (byCustomer) return byCustomer;
  }
  if (customer.email) {
    const byEmail = await db
      .prepare('SELECT id, email, creem_customer_id FROM accounts WHERE email = ? AND deleted_at IS NULL')
      .bind(normalizeEmail(customer.email))
      .first<AccountRow>();
    if (byEmail) return byEmail;
  }
  return null;
};

/**
 * Find or create the account for a Creem customer. The email is the stable
 * cross-purchase identity; the Creem customer id is attached when known.
 */
export const ensureAccount = async (db: D1Database, customer: CustomerIdentity, now: number): Promise<string> => {
  const existing = await findAccount(db, customer);
  if (existing) {
    if (customer.id && !existing.creem_customer_id) {
      await db
        .prepare('UPDATE accounts SET creem_customer_id = ? WHERE id = ? AND creem_customer_id IS NULL')
        .bind(customer.id, existing.id)
        .run();
    }
    return existing.id;
  }

  const email = customer.email ? normalizeEmail(customer.email) : `${customer.id ?? 'unknown'}@customers.creem.local`;
  const id = `acc_${crypto.randomUUID()}`;
  try {
    await db
      .prepare('INSERT INTO accounts (id, email, creem_customer_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, email, customer.id, now)
      .run();
    return id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/UNIQUE constraint failed/i.test(message)) throw error;
    const raced = await findAccount(db, customer);
    if (!raced) throw error;
    return raced.id;
  }
};

/** Link a device to an account without ever reassigning an existing binding. */
export const linkDevice = async (db: D1Database, deviceId: string, accountId: string): Promise<boolean> => {
  const result = await db
    .prepare('UPDATE devices SET account_id = ? WHERE id = ? AND (account_id IS NULL OR account_id = ?)')
    .bind(accountId, deviceId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
};

export type PurchaseInput = {
  id: string;
  accountId: string;
  productId: string;
  productKey: string;
  kind: 'credits' | 'subscription';
  credits: number;
  amountCents: number;
  currency: string;
  now: number;
};

/** Returns false when the Creem order was already recorded (idempotent). */
export const recordPurchase = async (db: D1Database, input: PurchaseInput): Promise<boolean> => {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO purchases
         (id, account_id, product_id, product_key, kind, credits, amount_cents, currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.accountId,
      input.productId,
      input.productKey,
      input.kind,
      input.credits,
      input.amountCents,
      input.currency,
      input.now,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
};

export const findPurchase = async (db: D1Database, orderId: string): Promise<PurchaseRow | null> =>
  db
    .prepare(
      `SELECT id, account_id, product_id, product_key, kind, credits, amount_cents, currency, created_at
         FROM purchases
        WHERE id = ?`,
    )
    .bind(orderId)
    .first<PurchaseRow>();

export const grantCredits = async (
  db: D1Database,
  accountId: string,
  credits: number,
  orderId: string,
  now: number,
): Promise<void> => {
  if (credits <= 0) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, account_id, delta, reason, ref, created_at)
       VALUES (?, ?, ?, 'grant', ?, ?)`,
    )
    .bind(`grant:${orderId}`, accountId, credits, `grant:${orderId}`, now)
    .run();
};

/** Refunds/chargebacks may push the derived balance negative; later grants offset it. */
export const recordChargeback = async (
  db: D1Database,
  accountId: string,
  credits: number,
  eventId: string,
  now: number,
): Promise<void> => {
  if (credits <= 0) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, account_id, delta, reason, ref, created_at)
       VALUES (?, ?, ?, 'chargeback', ?, ?)`,
    )
    .bind(`chargeback:${eventId}`, accountId, -credits, `chargeback:${eventId}`, now)
    .run();
};

export type SubscriptionInput = {
  id: string;
  accountId: string;
  productId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: number;
  updatedAt: number;
};

export const upsertSubscription = async (db: D1Database, input: SubscriptionInput): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO subscriptions
         (id, account_id, product_id, status, current_period_end, cancel_at_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id,
         product_id = excluded.product_id,
         status = excluded.status,
         -- Events such as canceled may omit the period end; keep the known one.
         current_period_end = COALESCE(excluded.current_period_end, subscriptions.current_period_end),
         cancel_at_period_end = excluded.cancel_at_period_end,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= subscriptions.updated_at`,
    )
    .bind(
      input.id,
      input.accountId,
      input.productId,
      input.status,
      input.currentPeriodEnd,
      input.cancelAtPeriodEnd,
      input.updatedAt,
    )
    .run();
};

export const setSubscriptionStatus = async (
  db: D1Database,
  subscriptionId: string,
  status: SubscriptionStatus,
  now: number,
): Promise<void> => {
  await db
    .prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, now, subscriptionId)
    .run();
};

/** Refunds and disputes revoke every paid period still on the account. */
export const revokeAccountSubscriptions = async (db: D1Database, accountId: string, now: number): Promise<void> => {
  await db
    .prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE account_id = ? AND status != 'expired'")
    .bind(now, accountId)
    .run();
};

export type LicenseKeyInput = {
  key: string;
  accountId: string;
  productId: string;
  activationLimit: number | null;
  status: string;
  expiresAt: number | null;
  now: number;
};

/** Only the SHA-256 hash and last four characters of a license key are stored. */
export const saveLicenseKey = async (db: D1Database, input: LicenseKeyInput): Promise<void> => {
  const normalized = normalizeLicenseKey(input.key);
  if (!normalized) return;
  const keyHash = await sha256Hex(normalized);
  const keyLast4 = normalized.slice(-4);
  await db
    .prepare(
      `INSERT INTO license_keys
         (key_hash, key_last4, account_id, product_id, activation_limit, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_hash) DO UPDATE SET
         account_id = COALESCE(license_keys.account_id, excluded.account_id),
         activation_limit = COALESCE(license_keys.activation_limit, excluded.activation_limit),
         status = excluded.status,
         expires_at = COALESCE(excluded.expires_at, license_keys.expires_at)`,
    )
    .bind(
      keyHash,
      keyLast4,
      input.accountId,
      input.productId,
      input.activationLimit,
      input.status,
      input.expiresAt,
      input.now,
    )
    .run();
};

export const findLicenseByHash = async (db: D1Database, keyHash: string): Promise<LicenseKeyRow | null> =>
  db
    .prepare(
      `SELECT key_hash, key_last4, account_id, product_id, activation_limit, status, expires_at, created_at
         FROM license_keys
        WHERE key_hash = ?`,
    )
    .bind(keyHash)
    .first<LicenseKeyRow>();

export const countLicenseActivations = async (db: D1Database, keyHash: string): Promise<number> => {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM license_activations WHERE key_hash = ?')
    .bind(keyHash)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

export const findLicenseActivation = async (db: D1Database, keyHash: string, deviceId: string): Promise<boolean> => {
  const row = await db
    .prepare('SELECT 1 AS found FROM license_activations WHERE key_hash = ? AND device_id = ?')
    .bind(keyHash, deviceId)
    .first<{ found: number }>();
  return Boolean(row?.found);
};

export const recordLicenseActivation = async (
  db: D1Database,
  keyHash: string,
  deviceId: string,
  now: number,
): Promise<boolean> => {
  const result = await db
    .prepare('INSERT OR IGNORE INTO license_activations (key_hash, device_id, created_at) VALUES (?, ?, ?)')
    .bind(keyHash, deviceId, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
};
