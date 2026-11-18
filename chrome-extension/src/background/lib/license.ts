/* eslint-disable import-x/exports-last */
import { BillingRequestError, BillingUnavailableError, createBillingRemote } from './billing-api';
import {
  canUseCachedEntitlement,
  FREE_DAILY_LIMIT,
  freeRemaining,
  isSubscriptionEntitled,
  parseSnapshotPublicKey,
  subscriptionSummary,
  toFreeQuota,
  utcDate,
  verifySnapshotSignature,
} from '@extension/shared';
import {
  licenseAuthorizationsStorage,
  licenseDeviceStorage,
  licenseEntitlementStorage,
  licenseLocalUsageStorage,
  licensePendingReportsStorage,
} from '@extension/storage';
import type { BillingRemote, RemoteEntitlement } from './billing-api';
import type {
  AuthorizationRecord,
  DownloadOutcome,
  EntitlementCacheRecord,
  EntitlementSnapshot,
  FreeQuota,
  LicenseAuthorizations,
  LicenseLocalUsage,
  LicenseStatusPayload,
  LicenseVerdict,
  OfflineReservation,
  PendingReport,
  Plan,
  SubscriptionSummary,
  UpgradeOptions,
} from '@extension/shared';
import type { LicenseDeviceRecord } from '@extension/storage';

const MAX_PENDING_REPORTS = 200;
const DEFAULT_PRICING_URL = 'https://uu0uu.com/pricing';

export type LicenseStorageArea<T> = {
  get: () => Promise<T>;
  set: (value: T) => Promise<void>;
};

export type LicenseStorageAdapters = {
  usage: LicenseStorageArea<LicenseLocalUsage>;
  authorizations: LicenseStorageArea<LicenseAuthorizations>;
  pendingReports: LicenseStorageArea<PendingReport[]>;
  /** Signed entitlement cache; optional so M0-style tests stay storage-only. */
  entitlement?: LicenseStorageArea<EntitlementCacheRecord>;
};

export type LicenseManagerOptions = {
  storage?: LicenseStorageAdapters;
  now?: () => number;
  /** Resolves a signature-verified entitlement snapshot; undefined until M4 wires verification. */
  resolveSnapshot?: () => Promise<EntitlementSnapshot | null>;
  upgrade?: () => UpgradeOptions;
  /** Worker client. When omitted the manager runs fully local (M0 behavior). */
  remote?: BillingRemote;
  /** Resolves the local device id for the status card. */
  deviceId?: () => Promise<string | null>;
};

export type AuthorizeInput = {
  downloadKey: string;
  kind?: string;
  urlHash?: string;
};

export type ReportInput = {
  downloadKey: string;
  outcome: DownloadOutcome;
  bytesDownloaded?: number;
};

export type ReportResult = {
  state: AuthorizationRecord['state'] | 'unknown';
  released: boolean;
};

export type LocalLicenseStatus = LicenseStatusPayload;

export type LicenseSyncResult = {
  ok: boolean;
  status: LocalLicenseStatus;
  error?: string;
};

export type CheckoutResult = { ok: true; checkoutUrl: string } | { ok: false; error: string; code?: string };

export type PortalResult = { ok: true; portalUrl: string } | { ok: false; error: string; code?: string };

export type ActivationResult = { ok: true; status: LocalLicenseStatus } | { ok: false; error: string; code?: string };

export type ReconcileResult = {
  /** Reports queued while the Worker was unreachable. */
  pendingReports: number;
  /** Local reservations older than 24h committed conservatively. */
  staleCommitted: number;
};

export type LicenseManager = {
  authorizeDownload: (input: AuthorizeInput) => Promise<LicenseVerdict>;
  reportDownloadOutcome: (input: ReportInput) => Promise<ReportResult>;
  getAuthorization: (downloadKey: string) => Promise<AuthorizationRecord | undefined>;
  ensureRetryAuthorization: (downloadKey: string, kind?: string) => Promise<AuthorizationRecord>;
  getLocalStatus: () => Promise<LocalLicenseStatus>;
  syncEntitlement: () => Promise<LicenseSyncResult>;
  startCheckout: (productKey: string) => Promise<CheckoutResult>;
  openPortal: () => Promise<PortalResult>;
  activateLicense: (licenseKey: string) => Promise<ActivationResult>;
  flushPendingReports: () => Promise<number>;
  reconcileLocalState: () => Promise<ReconcileResult>;
};

/** Commit local reservations the Worker would have swept after 24h. */
export const STALE_RESERVATION_MS = 24 * 60 * 60 * 1000;

/**
 * Build the signature-verified snapshot resolver used by the background
 * manager. Verification failures, a mismatched device id, or a missing
 * embedded public key all degrade to "no snapshot" so offline decisions fall
 * back to the local free quota.
 */
export const createSnapshotResolver = (options: {
  storage: LicenseStorageArea<EntitlementCacheRecord>;
  publicKey: () => JsonWebKey | null;
  deviceId: () => Promise<string | null>;
  now?: () => number;
}): (() => Promise<EntitlementSnapshot | null>) => {
  const now = options.now ?? Date.now;
  return async () => {
    const cache = await options.storage.get();
    const snapshot = cache?.snapshot;
    const signature = cache?.signature;
    if (!snapshot || !signature) return null;
    const publicKey = options.publicKey();
    if (!publicKey) return null;
    const deviceId = await options.deviceId().catch(() => null);
    if (deviceId && snapshot.deviceId !== deviceId) return null;
    if (!(await verifySnapshotSignature(snapshot, signature, publicKey))) return null;
    if (cache.verifiedAt === null) await options.storage.set({ ...cache, verifiedAt: now() }).catch(() => undefined);
    return snapshot;
  };
};

/** Raised when the local (or remote) authority refuses a new download. */
export class PaymentRequiredError extends Error {
  readonly code = 'PAYMENT_REQUIRED' as const;
  readonly verdict: LicenseVerdict;

  constructor(verdict: LicenseVerdict) {
    super('Free daily downloads are used up. Buy a credit pack or Pro to keep downloading.');
    this.name = 'PaymentRequiredError';
    this.verdict = verdict;
  }
}

const defaultUpgrade = (): UpgradeOptions => {
  let optionsUrl = 'options.html#license';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
      optionsUrl = `${chrome.runtime.getURL('options.html')}#license`;
  } catch {
    // Running outside an extension context (tests).
  }
  return { optionsUrl, pricingUrl: DEFAULT_PRICING_URL };
};

const defaultStorage: LicenseStorageAdapters = {
  usage: licenseLocalUsageStorage,
  authorizations: licenseAuthorizationsStorage,
  pendingReports: licensePendingReportsStorage,
  entitlement: licenseEntitlementStorage,
};

const normalizeCredits = (value: unknown): number => (Number.isFinite(value) ? Math.trunc(value as number) : 0);
const normalizeUsed = (value: unknown): number => Math.max(0, normalizeCredits(value));

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const errorCode = (error: unknown): string | undefined =>
  error instanceof BillingUnavailableError || error instanceof BillingRequestError ? error.code : undefined;

const readUsage = async (
  storage: LicenseStorageAdapters,
  now: () => number,
): Promise<{ usage: LicenseLocalUsage; day: string }> => {
  const stored = await storage.usage.get();
  const day = utcDate(new Date(now()));
  const credits = normalizeCredits(stored?.credits);
  if (stored?.utcDate === day) return { usage: { utcDate: day, used: normalizeUsed(stored.used), credits }, day };
  return { usage: { utcDate: day, used: 0, credits }, day };
};

const allowedVerdict = (
  source: LicenseVerdict['source'],
  authorizationId: string,
  usage: LicenseLocalUsage,
  day: string,
  subscription: SubscriptionSummary,
  offline = false,
): LicenseVerdict => ({
  allowed: true,
  source,
  authorizationId,
  free: toFreeQuota(usage, day),
  credits: usage.credits,
  subscription,
  ...(offline ? { offline: true } : {}),
});

const paymentRequiredVerdict = (
  usage: LicenseLocalUsage,
  day: string,
  subscription: SubscriptionSummary,
  upgrade: () => UpgradeOptions,
): LicenseVerdict => ({
  allowed: false,
  error: 'payment_required',
  free: toFreeQuota(usage, day),
  credits: usage.credits,
  subscription,
  upgrade: upgrade(),
});

/**
 * Billing authority. The Worker is authoritative whenever it is reachable;
 * the local ledger mirrors the last server answer so offline authorizes,
 * retries and status cards keep working. All read-modify-write sequences are
 * serialized to keep duplicate authorizes idempotent inside a single
 * service-worker lifetime.
 */
export const createLicenseManager = (options: LicenseManagerOptions = {}): LicenseManager => {
  const storage = options.storage ?? defaultStorage;
  const remote = options.remote;
  const now = options.now ?? Date.now;
  const upgrade = options.upgrade ?? defaultUpgrade;
  let tail: Promise<unknown> = Promise.resolve();
  let lastRemoteFailure = false;
  let lastSubscription: SubscriptionSummary = null;
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const resolveSubscription = async (): Promise<{ snapshot: EntitlementSnapshot | null; entitled: boolean }> => {
    if (!options.resolveSnapshot) return { snapshot: null, entitled: false };
    try {
      const snapshot = await options.resolveSnapshot();
      // An expired snapshot is treated exactly like a missing one: it must not
      // drive offline subscription, free-quota or credit decisions.
      if (!snapshot || !canUseCachedEntitlement(snapshot, now())) return { snapshot: null, entitled: false };
      return { snapshot, entitled: isSubscriptionEntitled(snapshot, now()) };
    } catch {
      return { snapshot: null, entitled: false };
    }
  };

  /** Adopt the Worker's authoritative free quota and credit balance. */
  const mirrorRemoteUsage = async (free: FreeQuota, credits: number): Promise<void> => {
    const day = free.utcDate || utcDate(new Date(now()));
    await storage.usage.set({
      utcDate: day,
      used: Math.max(0, normalizeCredits(free.used)),
      credits: normalizeCredits(credits),
    });
  };

  const rememberEntitlement = async (entitlement: RemoteEntitlement): Promise<void> => {
    lastRemoteFailure = false;
    lastSubscription = entitlement.subscription;
    await mirrorRemoteUsage(entitlement.free, entitlement.credits);
    if (storage.entitlement)
      await storage.entitlement.set({
        snapshot: entitlement.snapshot,
        signature: entitlement.signature,
        verifiedAt: null,
      });
  };

  const refundAuthorization = async (authorization: AuthorizationRecord): Promise<void> => {
    if (authorization.freeReserved === 0 && authorization.creditsReserved === 0) return;
    const { usage } = await readUsage(storage, now);
    if (authorization.source === 'free') usage.used = Math.max(0, usage.used - authorization.freeReserved);
    if (authorization.source === 'credits') usage.credits += authorization.creditsReserved;
    await storage.usage.set(usage);
  };

  const offlineReservation = (authorization: AuthorizationRecord | undefined): OfflineReservation | undefined =>
    authorization?.offline
      ? {
          source: authorization.source,
          freeReserved: authorization.freeReserved,
          creditsReserved: authorization.creditsReserved,
          authorizedAt: authorization.createdAt,
        }
      : undefined;

  const enqueuePendingReport = async (
    input: ReportInput,
    bytesDownloaded: number,
    offline?: OfflineReservation,
  ): Promise<void> => {
    const pending = await storage.pendingReports.get();
    pending.push({
      downloadKey: input.downloadKey,
      outcome: input.outcome,
      bytesDownloaded,
      reportedAt: now(),
      ...(offline ? { offline } : {}),
    });
    if (pending.length > MAX_PENDING_REPORTS) pending.splice(0, pending.length - MAX_PENDING_REPORTS);
    await storage.pendingReports.set(pending);
  };

  /** Apply reserve → commit/release semantics to the local mirror. */
  const settleLocally = async (
    authorizations: LicenseAuthorizations,
    authorization: AuthorizationRecord,
    input: ReportInput,
    bytesDownloaded: number,
  ): Promise<ReportResult> => {
    // Success always commits. Failure/cancellation commits once bytes moved
    // (bandwidth already spent) and releases only a zero-byte attempt.
    const commit = input.outcome === 'success' || bytesDownloaded > 0;
    if (!commit) await refundAuthorization(authorization);
    authorization.state = commit ? 'committed' : 'released';
    authorization.updatedAt = now();
    await storage.authorizations.set(authorizations);
    return { state: authorization.state, released: !commit };
  };

  const authorizeUnlocked = async (input: AuthorizeInput): Promise<LicenseVerdict> => {
    if (!input.downloadKey) throw new Error('authorizeDownload requires a downloadKey');

    let offlineFallback = false;
    if (remote) {
      try {
        const verdict = await remote.authorize(input);
        lastRemoteFailure = false;
        lastSubscription = verdict.subscription;
        await mirrorRemoteUsage(verdict.free, verdict.credits);
        if (!verdict.allowed) {
          throw new PaymentRequiredError({
            allowed: false,
            error: 'payment_required',
            free: verdict.free,
            credits: verdict.credits,
            subscription: verdict.subscription,
            upgrade: upgrade(),
          });
        }

        const authorizations = await storage.authorizations.get();
        const existing = authorizations[input.downloadKey];
        const record: AuthorizationRecord = {
          state: 'reserved',
          source: verdict.source,
          authorizationId: verdict.authorizationId,
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
          freeReserved: verdict.source === 'free' ? 1 : 0,
          creditsReserved: verdict.source === 'credits' ? 1 : 0,
        };
        authorizations[input.downloadKey] = record;
        await storage.authorizations.set(authorizations);
        return {
          allowed: true,
          source: verdict.source,
          authorizationId: verdict.authorizationId,
          free: verdict.free,
          credits: verdict.credits,
          subscription: verdict.subscription,
        };
      } catch (error) {
        if (error instanceof PaymentRequiredError) throw error;
        // Only an unreachable Worker falls back to the local ledger. A 401,
        // 429 or malformed 200 must not grant a free download.
        if (!(error instanceof BillingUnavailableError) || !error.allowLocalFallback) throw error;
        lastRemoteFailure = true;
        offlineFallback = true;
      }
    }

    const { usage, day } = await readUsage(storage, now);
    const authorizations = await storage.authorizations.get();
    const existing = authorizations[input.downloadKey];
    if (existing && existing.state !== 'released') {
      // Duplicate authorize for the same download returns the original decision.
      const { snapshot } = await resolveSubscription();
      return allowedVerdict(
        existing.source,
        existing.authorizationId,
        usage,
        day,
        subscriptionSummary(snapshot),
        existing.source === 'subscription',
      );
    }

    const { snapshot, entitled } = await resolveSubscription();
    const subscription = subscriptionSummary(snapshot);
    if (entitled) {
      const record: AuthorizationRecord = {
        state: 'reserved',
        source: 'subscription',
        authorizationId: existing?.authorizationId ?? `auth_${crypto.randomUUID()}`,
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
        freeReserved: 0,
        creditsReserved: 0,
        ...(offlineFallback ? { offline: true } : {}),
      };
      authorizations[input.downloadKey] = record;
      await storage.authorizations.set(authorizations);
      return allowedVerdict('subscription', record.authorizationId, usage, day, subscription, true);
    }

    // The signed snapshot is the offline source of truth: it can lower the
    // remaining free quota (storage reset must not grant a fresh allowance)
    // and restore credits lost with local storage. Without a verified snapshot
    // only the local free quota is usable while the Worker is unreachable.
    const snapshotFreeUsed =
      snapshot && snapshot.utcDay === day ? Math.max(0, normalizeCredits(snapshot.freeUsed)) : null;
    const localRemaining = freeRemaining(usage, day);
    const remaining =
      remote && snapshotFreeUsed !== null
        ? Math.min(localRemaining, Math.max(0, FREE_DAILY_LIMIT - snapshotFreeUsed))
        : localRemaining;
    const snapshotCredits = snapshot ? Math.max(0, normalizeCredits(snapshot.creditBalance)) : 0;
    const availableCredits = remote ? Math.max(usage.credits, snapshotCredits) : usage.credits;

    let source: 'free' | 'credits' | undefined;
    let freeReserved = 0;
    let creditsReserved = 0;
    if (remaining > 0) {
      source = 'free';
      freeReserved = 1;
      usage.used += 1;
    } else if (availableCredits > 0) {
      source = 'credits';
      creditsReserved = 1;
      if (usage.credits <= 0) usage.credits = snapshotCredits;
      usage.credits -= 1;
    }
    if (!source) throw new PaymentRequiredError(paymentRequiredVerdict(usage, day, subscription, upgrade));

    const record: AuthorizationRecord = {
      state: 'reserved',
      source,
      authorizationId: existing?.authorizationId ?? `auth_${crypto.randomUUID()}`,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
      freeReserved,
      creditsReserved,
      ...(offlineFallback ? { offline: true } : {}),
    };
    authorizations[input.downloadKey] = record;
    // Quota first: a crash between writes over-charges rather than granting a
    // free download. The next authorize sees the reserved authorization.
    await storage.usage.set(usage);
    await storage.authorizations.set(authorizations);
    return allowedVerdict(source, record.authorizationId, usage, day, subscription, offlineFallback);
  };

  const authorizeDownload = (input: AuthorizeInput): Promise<LicenseVerdict> => serial(() => authorizeUnlocked(input));

  const reportDownloadOutcome = (input: ReportInput): Promise<ReportResult> =>
    serial(async () => {
      const authorizations = await storage.authorizations.get();
      const authorization = authorizations[input.downloadKey];
      const bytesDownloaded = Math.max(0, normalizeCredits(input.bytesDownloaded));

      if (remote) {
        try {
          const result = await remote.report({
            downloadKey: input.downloadKey,
            outcome: input.outcome,
            bytesDownloaded,
          });
          lastRemoteFailure = false;
          if (!authorization) return { state: result.state, released: result.state === 'released' };
          if (authorization.state !== 'reserved') return { state: authorization.state, released: false };
          if (result.state === 'unknown') {
            // Authorized while the Worker was unreachable; settle the local
            // mirror and queue a report carrying the offline reservation so
            // the Worker can backfill the usage on the next sync.
            const settled = await settleLocally(authorizations, authorization, input, bytesDownloaded);
            await enqueuePendingReport(input, bytesDownloaded, offlineReservation(authorization));
            return settled;
          }
          if (result.state === 'released') await refundAuthorization(authorization);
          authorization.state =
            result.state === 'released' ? 'released' : result.state === 'committed' ? 'committed' : 'reserved';
          authorization.updatedAt = now();
          await storage.authorizations.set(authorizations);
          return { state: authorization.state, released: result.state === 'released' };
        } catch (error) {
          if (error instanceof BillingUnavailableError) lastRemoteFailure = true;
          // Reporting never blocks completion: settle locally and queue the
          // report for the 6h sync / next startup.
          const settled = authorization
            ? authorization.state === 'reserved'
              ? await settleLocally(authorizations, authorization, input, bytesDownloaded)
              : { state: authorization.state, released: false }
            : { state: 'unknown' as const, released: false };
          await enqueuePendingReport(input, bytesDownloaded);
          return settled;
        }
      }

      if (!authorization) return { state: 'unknown', released: false };
      if (authorization.state !== 'reserved') return { state: authorization.state, released: false };
      const settled = await settleLocally(authorizations, authorization, input, bytesDownloaded);
      await enqueuePendingReport(input, bytesDownloaded);
      return settled;
    });

  const getAuthorization = async (downloadKey: string): Promise<AuthorizationRecord | undefined> =>
    (await storage.authorizations.get())[downloadKey];

  const ensureRetryAuthorization = (downloadKey: string, kind?: string): Promise<AuthorizationRecord> =>
    serial(async () => {
      const authorizations = await storage.authorizations.get();
      const existing = authorizations[downloadKey];
      if (existing && existing.state !== 'released') return existing;
      // Released (or legacy) tasks reserve again under the same downloadKey so
      // the Worker can idempotently resume the same authorization.
      const verdict = await authorizeUnlocked({ downloadKey, kind });
      const record = (await storage.authorizations.get())[downloadKey];
      if (!record) throw new PaymentRequiredError(verdict);
      return record;
    });

  const getLocalStatus = async (): Promise<LocalLicenseStatus> => {
    const { usage, day } = await readUsage(storage, now);
    const { snapshot, entitled } = await resolveSubscription();
    const subscription = lastSubscription ?? subscriptionSummary(snapshot);
    const plan: Plan =
      entitled ||
      (subscription !== null &&
        isSubscriptionEntitled(
          { plan: 'pro', subscriptionStatus: subscription.status, subscriptionEnd: subscription.currentPeriodEnd },
          now(),
        ))
        ? 'pro'
        : 'free';
    const pending = await storage.pendingReports.get();
    let deviceId: string | null = null;
    if (options.deviceId) {
      try {
        deviceId = await options.deviceId();
      } catch {
        deviceId = null;
      }
    }
    return {
      free: toFreeQuota(usage, day),
      credits: usage.credits,
      subscription,
      plan,
      offline: Boolean(remote) && lastRemoteFailure,
      deviceId,
      pendingReports: pending.length,
    };
  };

  const syncEntitlement = (): Promise<LicenseSyncResult> =>
    serial(async () => {
      if (!remote) return { ok: false, error: 'Billing is not configured', status: await getLocalStatus() };
      try {
        const entitlement = await remote.fetchEntitlement();
        await rememberEntitlement(entitlement);
        return { ok: true, status: await getLocalStatus() };
      } catch (error) {
        lastRemoteFailure = true;
        return { ok: false, error: errorMessage(error), status: await getLocalStatus() };
      }
    });

  const startCheckout = async (productKey: string): Promise<CheckoutResult> => {
    if (!remote) return { ok: false, error: 'Billing is not configured', code: 'billing_unavailable' };
    try {
      const result = await remote.checkout(productKey);
      lastRemoteFailure = false;
      return { ok: true, checkoutUrl: result.checkoutUrl };
    } catch (error) {
      if (error instanceof BillingUnavailableError) lastRemoteFailure = true;
      return { ok: false, error: errorMessage(error), code: errorCode(error) };
    }
  };

  const openPortal = async (): Promise<PortalResult> => {
    if (!remote) return { ok: false, error: 'Billing is not configured', code: 'billing_unavailable' };
    try {
      const result = await remote.portal();
      lastRemoteFailure = false;
      return { ok: true, portalUrl: result.portalUrl };
    } catch (error) {
      if (error instanceof BillingUnavailableError) lastRemoteFailure = true;
      return { ok: false, error: errorMessage(error), code: errorCode(error) };
    }
  };

  const activateLicense = async (licenseKey: string): Promise<ActivationResult> => {
    if (!remote) return { ok: false, error: 'Billing is not configured', code: 'billing_unavailable' };
    try {
      const entitlement = await remote.activate(licenseKey);
      await rememberEntitlement(entitlement);
      return { ok: true, status: await getLocalStatus() };
    } catch (error) {
      if (error instanceof BillingUnavailableError) lastRemoteFailure = true;
      return { ok: false, error: errorMessage(error), code: errorCode(error) };
    }
  };

  const flushPendingReports = async (): Promise<number> => {
    if (!remote) return 0;
    const pending = await storage.pendingReports.get();
    if (pending.length === 0) return 0;
    let index = 0;
    for (; index < pending.length; index += 1) {
      const report = pending[index];
      try {
        await remote.report({
          downloadKey: report.downloadKey,
          outcome: report.outcome,
          bytesDownloaded: report.bytesDownloaded,
          ...(report.offline ? { offline: report.offline } : {}),
        });
      } catch {
        break;
      }
    }
    if (index > 0) {
      lastRemoteFailure = false;
      await storage.pendingReports.set(pending.slice(index));
    }
    return index;
  };

  /**
   * Local half of reconciliation: mirror the Worker's 24h conservative sweep
   * and surface the pending-report backlog so startup/6h syncs can log it.
   */
  const reconcileLocalState = (): Promise<ReconcileResult> =>
    serial(async () => {
      const authorizations = await storage.authorizations.get();
      const cutoff = now() - STALE_RESERVATION_MS;
      let staleCommitted = 0;
      let changed = false;
      for (const record of Object.values(authorizations)) {
        if (record.state !== 'reserved' || record.updatedAt >= cutoff) continue;
        record.state = 'committed';
        record.updatedAt = now();
        staleCommitted += 1;
        changed = true;
      }
      if (changed) await storage.authorizations.set(authorizations);
      const pending = await storage.pendingReports.get();
      return { pendingReports: pending.length, staleCommitted };
    });

  return {
    authorizeDownload,
    reportDownloadOutcome,
    getAuthorization,
    ensureRetryAuthorization,
    getLocalStatus,
    syncEntitlement,
    startCheckout,
    openPortal,
    activateLicense,
    flushPendingReports,
    reconcileLocalState,
  };
};

let deviceIdentity: Promise<LicenseDeviceRecord> | undefined;

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Creates the installation's device credentials once. The raw token never
 * leaves local storage except as a Bearer header to the billing Worker.
 */
export const ensureDeviceIdentity = (): Promise<LicenseDeviceRecord> =>
  (deviceIdentity ??= (async () => {
    const existing = await licenseDeviceStorage.get();
    if (existing?.deviceId && existing.deviceToken) return existing;
    const record: LicenseDeviceRecord = {
      deviceId: `dev_${crypto.randomUUID()}`,
      deviceToken: base64Url(crypto.getRandomValues(new Uint8Array(32))),
      createdAt: Date.now(),
    };
    await licenseDeviceStorage.set(record);
    return record;
  })().catch(error => {
    deviceIdentity = undefined;
    throw error;
  }));

const readEnv = (): Record<string, string | undefined> => {
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  } catch {
    return {};
  }
};

/** Public JWK embedded at build time; absent keys mean "no offline snapshot". */
const snapshotPublicKey = (): JsonWebKey | null => {
  const env = readEnv();
  return parseSnapshotPublicKey(env.WXT_SNAPSHOT_PUBLIC_KEY ?? env.VITE_SNAPSHOT_PUBLIC_KEY);
};

const manager = createLicenseManager({
  remote: createBillingRemote(() => ensureDeviceIdentity()),
  deviceId: async () => (await ensureDeviceIdentity()).deviceId,
  resolveSnapshot: createSnapshotResolver({
    storage: licenseEntitlementStorage,
    publicKey: snapshotPublicKey,
    deviceId: async () => (await ensureDeviceIdentity()).deviceId,
  }),
});

export const authorizeDownload = manager.authorizeDownload;
export const reportDownloadOutcome = manager.reportDownloadOutcome;
export const getAuthorization = manager.getAuthorization;
export const ensureRetryAuthorization = manager.ensureRetryAuthorization;
export const getLocalStatus = manager.getLocalStatus;
export const syncEntitlement = manager.syncEntitlement;
export const startCheckout = manager.startCheckout;
export const openPortal = manager.openPortal;
export const activateLicense = manager.activateLicense;
export const flushPendingReports = manager.flushPendingReports;
export const reconcileLocalState = manager.reconcileLocalState;
