import type { DeviceRow } from './db.js';

/** Bindings and per-request variables for the billing Worker. */
export type Env = {
  DB: D1Database;
  ENVIRONMENT?: string;
  /** `off` disables quota/credit enforcement (global kill switch). */
  BILLING_ENFORCEMENT?: string;
  CORS_ORIGINS?: string;
  PRICING_URL?: string;
  SUPPORT_EMAIL?: string;
  EXTENSION_OPTIONS_URL?: string;
  RATE_LIMIT_REGISTER_PER_HOUR?: string;
  RATE_LIMIT_AUTHORIZE_PER_MINUTE?: string;
  RATE_LIMIT_CHECKOUT_PER_HOUR?: string;
  /** Base64 PKCS#8 ECDSA P-256 private key used to sign entitlement snapshots. */
  SNAPSHOT_PRIVATE_KEY?: string;
  SNAPSHOT_KEY_ID?: string;
  PRODUCTS_JSON?: string;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_API_BASE?: string;
  /** Where Creem sends the browser after a successful checkout. */
  CHECKOUT_SUCCESS_URL?: string;
  /** Test-only fetch injection; never set in deployed bindings. */
  CREEM_FETCH?: typeof fetch;
};

export type AppVariables = {
  device: DeviceRow;
};
