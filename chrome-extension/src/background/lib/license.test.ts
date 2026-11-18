import { BillingUnavailableError } from './billing-api';
import { STALE_RESERVATION_MS, createLicenseManager, createSnapshotResolver, PaymentRequiredError } from './license';
import {
  FREE_DAILY_LIMIT,
  canUseCachedEntitlement,
  canonicalSnapshotJson,
  freeRemaining,
  isSubscriptionEntitled,
  normalizeLicenseKey,
  utcDate,
  verifySnapshotSignature,
} from '@extension/shared';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import type { BillingRemote } from './billing-api';
import type { LicenseStorageArea } from './license';
import type {
  EntitlementCacheRecord,
  EntitlementSnapshot,
  LicenseAuthorizations,
  LicenseLocalUsage,
  PendingReport,
} from '@extension/shared';

const memory = <T>(initial: T): LicenseStorageArea<T> => {
  let value = structuredClone(initial);
  return {
    get: async () => structuredClone(value),
    set: async next => {
      value = structuredClone(next);
    },
  };
};

const setup = (initialUsage: Partial<LicenseLocalUsage> = {}) => {
  let clock = Date.parse('2026-11-18T10:00:00.000Z');
  const usage = memory<LicenseLocalUsage>({ utcDate: '2026-11-18', used: 0, credits: 0, ...initialUsage });
  const authorizations = memory<LicenseAuthorizations>({});
  const pendingReports = memory<PendingReport[]>([]);
  const manager = createLicenseManager({
    storage: { usage, authorizations, pendingReports },
    now: () => clock,
    upgrade: () => ({ optionsUrl: 'options.html#license', pricingUrl: 'https://uu0uu.com/pricing' }),
  });
  return {
    manager,
    usage,
    authorizations,
    pendingReports,
    advance: (iso: string) => {
      clock = Date.parse(iso);
    },
    now: () => clock,
  };
};

test('free quota allows two downloads per UTC day and rejects the third', async () => {
  const { manager, usage } = setup();

  const first = await manager.authorizeDownload({ downloadKey: 'a' });
  const second = await manager.authorizeDownload({ downloadKey: 'b' });
  assert.equal(first.allowed, true);
  assert.equal(first.source, 'free');
  assert.equal(first.free.used, 1);
  assert.equal(second.free.used, FREE_DAILY_LIMIT);
  assert.equal((await usage.get()).used, FREE_DAILY_LIMIT);

  await assert.rejects(
    () => manager.authorizeDownload({ downloadKey: 'c' }),
    (error: unknown) => {
      assert.ok(error instanceof PaymentRequiredError);
      assert.equal(error.code, 'PAYMENT_REQUIRED');
      assert.equal(error.verdict.allowed, false);
      assert.equal(error.verdict.error, 'payment_required');
      assert.equal(error.verdict.free.used, FREE_DAILY_LIMIT);
      assert.equal(error.verdict.upgrade?.pricingUrl, 'https://uu0uu.com/pricing');
      return true;
    },
  );
  assert.equal((await usage.get()).used, FREE_DAILY_LIMIT);
});

test('the free allowance resets on the next UTC day', async () => {
  const { manager, advance } = setup({ used: FREE_DAILY_LIMIT });
  await assert.rejects(() => manager.authorizeDownload({ downloadKey: 'blocked' }), PaymentRequiredError);

  advance('2026-11-19T00:00:01.000Z');
  const verdict = await manager.authorizeDownload({ downloadKey: 'tomorrow' });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.free.utcDate, '2026-11-19');
  assert.equal(verdict.free.used, 1);
});

test('duplicate authorize for the same key reserves exactly once', async () => {
  const { manager, usage, authorizations } = setup();

  const first = await manager.authorizeDownload({ downloadKey: 'same' });
  const duplicate = await manager.authorizeDownload({ downloadKey: 'same' });

  assert.equal(duplicate.authorizationId, first.authorizationId);
  assert.equal(duplicate.free.used, 1);
  assert.equal((await usage.get()).used, 1);
  assert.equal(Object.keys(await authorizations.get()).length, 1);
});

test('a zero-byte failure releases the quota and a retry re-reserves the same key once', async () => {
  const { manager, usage, authorizations } = setup();

  const authorized = await manager.authorizeDownload({ downloadKey: 'retryable' });
  const released = await manager.reportDownloadOutcome({
    downloadKey: 'retryable',
    outcome: 'failed',
    bytesDownloaded: 0,
  });
  assert.deepEqual(released, { state: 'released', released: true });
  assert.equal((await usage.get()).used, 0);

  const retried = await manager.ensureRetryAuthorization('retryable');
  assert.equal(retried.state, 'reserved');
  assert.equal(retried.authorizationId, authorized.authorizationId);
  assert.equal((await usage.get()).used, 1);

  const committed = await manager.reportDownloadOutcome({
    downloadKey: 'retryable',
    outcome: 'success',
    bytesDownloaded: 1024,
  });
  assert.deepEqual(committed, { state: 'committed', released: false });
  assert.equal((await usage.get()).used, 1);

  // Committed retries are already paid for and never re-reserve.
  const stillCommitted = await manager.ensureRetryAuthorization('retryable');
  assert.equal(stillCommitted.state, 'committed');
  assert.equal((await usage.get()).used, 1);
  assert.equal((await authorizations.get()).retryable.state, 'committed');
});

test('failed or cancelled attempts with transferred bytes are committed', async () => {
  const { manager, usage } = setup();

  await manager.authorizeDownload({ downloadKey: 'partial-failure' });
  const failed = await manager.reportDownloadOutcome({
    downloadKey: 'partial-failure',
    outcome: 'failed',
    bytesDownloaded: 512,
  });
  assert.deepEqual(failed, { state: 'committed', released: false });
  assert.equal((await usage.get()).used, 1);

  await manager.authorizeDownload({ downloadKey: 'partial-cancel' });
  const cancelled = await manager.reportDownloadOutcome({
    downloadKey: 'partial-cancel',
    outcome: 'cancelled',
    bytesDownloaded: 1,
  });
  assert.deepEqual(cancelled, { state: 'committed', released: false });
  assert.equal((await usage.get()).used, 2);
});

test('credits are reserved only after the free quota is exhausted and released on zero-byte failure', async () => {
  const { manager, usage } = setup({ used: FREE_DAILY_LIMIT, credits: 3 });

  const verdict = await manager.authorizeDownload({ downloadKey: 'paid' });
  assert.equal(verdict.source, 'credits');
  assert.equal(verdict.credits, 2);
  assert.equal((await usage.get()).credits, 2);

  await manager.reportDownloadOutcome({ downloadKey: 'paid', outcome: 'cancelled', bytesDownloaded: 0 });
  assert.equal((await usage.get()).credits, 3);

  const retried = await manager.ensureRetryAuthorization('paid');
  assert.equal(retried.source, 'credits');
  assert.equal((await usage.get()).credits, 2);

  await manager.reportDownloadOutcome({ downloadKey: 'paid', outcome: 'success', bytesDownloaded: 10 });
  assert.equal((await usage.get()).credits, 2);
});

test('duplicate reports are absorbed without double refunds', async () => {
  const { manager, usage, pendingReports } = setup();

  await manager.authorizeDownload({ downloadKey: 'report-once' });
  await manager.reportDownloadOutcome({ downloadKey: 'report-once', outcome: 'failed', bytesDownloaded: 0 });
  const duplicate = await manager.reportDownloadOutcome({
    downloadKey: 'report-once',
    outcome: 'failed',
    bytesDownloaded: 0,
  });

  assert.deepEqual(duplicate, { state: 'released', released: false });
  assert.equal((await usage.get()).used, 0);
  assert.equal((await pendingReports.get()).length, 1);
});

test('unknown download keys never move the ledger', async () => {
  const { manager, usage, pendingReports } = setup({ used: 1 });

  const result = await manager.reportDownloadOutcome({ downloadKey: 'never-authorized', outcome: 'success' });
  assert.deepEqual(result, { state: 'unknown', released: false });
  assert.equal((await usage.get()).used, 1);
  assert.equal((await pendingReports.get()).length, 0);
});

test('a verified subscription snapshot allows downloads without spending quota or credits', async () => {
  const { usage } = setup({ used: FREE_DAILY_LIMIT, credits: 2 });
  const snapshot: EntitlementSnapshot = {
    v: 1,
    deviceId: 'dev_test',
    plan: 'pro',
    subscriptionStatus: 'active',
    subscriptionEnd: null,
    creditBalance: 2,
    freeUsed: FREE_DAILY_LIMIT,
    utcDay: '2026-11-18',
    issuedAt: Date.parse('2026-11-18T09:00:00.000Z'),
    expiresAt: Date.parse('2026-11-21T09:00:00.000Z'),
  };
  const subscribed = createLicenseManager({
    storage: {
      usage,
      authorizations: memory<LicenseAuthorizations>({}),
      pendingReports: memory<PendingReport[]>([]),
    },
    now: () => Date.parse('2026-11-18T10:00:00.000Z'),
    resolveSnapshot: async () => snapshot,
  });

  const verdict = await subscribed.authorizeDownload({ downloadKey: 'pro' });
  assert.equal(verdict.source, 'subscription');
  assert.equal(verdict.offline, true);
  assert.equal((await usage.get()).used, FREE_DAILY_LIMIT);
  assert.equal((await usage.get()).credits, 2);
});

test('subscription and snapshot helpers implement the documented entitlement windows', () => {
  const now = Date.parse('2026-11-18T10:00:00.000Z');
  assert.equal(utcDate(new Date(now)), '2026-11-18');
  assert.equal(freeRemaining({ utcDate: '2026-11-17', used: 99 }), FREE_DAILY_LIMIT);
  assert.equal(freeRemaining({ utcDate: '2026-11-18', used: 1 }, '2026-11-18'), 1);

  assert.equal(isSubscriptionEntitled({ plan: 'pro', subscriptionStatus: 'active', subscriptionEnd: null }, now), true);
  assert.equal(
    isSubscriptionEntitled({ plan: 'pro', subscriptionStatus: 'canceled', subscriptionEnd: now + 1 }, now),
    true,
  );
  assert.equal(
    isSubscriptionEntitled({ plan: 'pro', subscriptionStatus: 'canceled', subscriptionEnd: now - 1 }, now),
    false,
  );
  assert.equal(
    isSubscriptionEntitled({ plan: 'pro', subscriptionStatus: 'expired', subscriptionEnd: null }, now),
    false,
  );
  assert.equal(
    isSubscriptionEntitled({ plan: 'free', subscriptionStatus: 'active', subscriptionEnd: null }, now),
    false,
  );

  assert.equal(canUseCachedEntitlement({ v: 1, issuedAt: now - 1000, expiresAt: now + 1000 }, now), true);
  assert.equal(canUseCachedEntitlement({ v: 1, issuedAt: now - 1000, expiresAt: now }, now), false);

  assert.equal(normalizeLicenseKey('  abcd-1234  '), 'ABCD-1234');
});

const remoteStub = (overrides: Partial<BillingRemote> = {}): BillingRemote => ({
  authorize: async () => ({
    allowed: true,
    source: 'free',
    authorizationId: 'auth_server',
    free: { used: 1, limit: 2, utcDate: '2026-11-18' },
    credits: 0,
    subscription: null,
  }),
  report: async () => ({ state: 'committed' }),
  fetchEntitlement: async () => ({
    plan: 'free',
    free: { used: 0, limit: 2, utcDate: '2026-11-18' },
    credits: 0,
    subscription: null,
    snapshot: null,
    signature: null,
    keyId: null,
  }),
  checkout: async () => ({ checkoutUrl: 'https://checkout.test/session' }),
  portal: async () => ({ portalUrl: 'https://portal.test/session' }),
  activate: async () => ({
    plan: 'pro',
    free: { used: 0, limit: 2, utcDate: '2026-11-18' },
    credits: 0,
    subscription: { status: 'active', currentPeriodEnd: null },
    snapshot: null,
    signature: null,
    keyId: null,
  }),
  ...overrides,
});

const remoteSetup = (remote: BillingRemote, initialUsage: Partial<LicenseLocalUsage> = {}) => {
  const clock = Date.parse('2026-11-18T10:00:00.000Z');
  const usage = memory<LicenseLocalUsage>({ utcDate: '2026-11-18', used: 0, credits: 0, ...initialUsage });
  const authorizations = memory<LicenseAuthorizations>({});
  const pendingReports = memory<PendingReport[]>([]);
  const entitlement = memory<EntitlementCacheRecord>({ snapshot: null, signature: null, verifiedAt: null });
  const manager = createLicenseManager({
    storage: { usage, authorizations, pendingReports, entitlement },
    now: () => clock,
    remote,
    deviceId: async () => 'dev_test',
  });
  return { manager, usage, authorizations, pendingReports, entitlement };
};

test('remote authorize is authoritative and mirrors free/credits locally', async () => {
  const { manager, usage, authorizations } = remoteSetup(
    remoteStub({
      authorize: async () => ({
        allowed: true,
        source: 'credits',
        authorizationId: 'auth_server',
        free: { used: 2, limit: 2, utcDate: '2026-11-18' },
        credits: 4,
        subscription: null,
      }),
    }),
    { credits: 5 },
  );

  const verdict = await manager.authorizeDownload({ downloadKey: 'server' });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.source, 'credits');
  assert.equal(verdict.authorizationId, 'auth_server');
  assert.deepEqual(await usage.get(), { utcDate: '2026-11-18', used: 2, credits: 4 });
  assert.equal((await authorizations.get()).server.authorizationId, 'auth_server');
  assert.equal((await authorizations.get()).server.state, 'reserved');
});

test('remote 402 surfaces the Worker quota and never reserves locally', async () => {
  const { manager, usage, authorizations } = remoteSetup(
    remoteStub({
      authorize: async () => ({
        allowed: false,
        error: 'payment_required',
        free: { used: 2, limit: 2, utcDate: '2026-11-18' },
        credits: 0,
        subscription: null,
      }),
    }),
    { used: 1, credits: 2 },
  );

  await assert.rejects(
    () => manager.authorizeDownload({ downloadKey: 'blocked' }),
    (error: unknown) => {
      assert.ok(error instanceof PaymentRequiredError);
      assert.equal(error.verdict.free.used, 2);
      assert.equal(error.verdict.credits, 0);
      return true;
    },
  );
  assert.equal((await authorizations.get()).blocked, undefined);
  assert.deepEqual(await usage.get(), { utcDate: '2026-11-18', used: 2, credits: 0 });
});

test('an unreachable Worker falls back to the local free quota and marks the status offline', async () => {
  const { manager, usage } = remoteSetup(
    remoteStub({
      authorize: async () => {
        throw new BillingUnavailableError('offline', { allowLocalFallback: true });
      },
    }),
  );

  const verdict = await manager.authorizeDownload({ downloadKey: 'offline' });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.source, 'free');
  assert.equal((await usage.get()).used, 1);

  const status = await manager.getLocalStatus();
  assert.equal(status.offline, true);
  assert.equal(status.deviceId, 'dev_test');
});

test('a reachable Worker rejection never falls back to the local quota', async () => {
  const { manager, usage } = remoteSetup(
    remoteStub({
      authorize: async () => {
        throw new BillingUnavailableError('invalid authorization', { allowLocalFallback: false });
      },
    }),
  );

  await assert.rejects(() => manager.authorizeDownload({ downloadKey: 'rejected' }), BillingUnavailableError);
  assert.equal((await usage.get()).used, 0);
});

test('remote reports are not queued while Worker failures are queued and settled locally', async () => {
  let failReport = false;
  const { manager, usage, pendingReports } = remoteSetup(
    remoteStub({
      report: async () => {
        if (failReport) throw new BillingUnavailableError('offline', { allowLocalFallback: true });
        return { state: 'committed' };
      },
    }),
  );

  await manager.authorizeDownload({ downloadKey: 'online' });
  const online = await manager.reportDownloadOutcome({
    downloadKey: 'online',
    outcome: 'success',
    bytesDownloaded: 1024,
  });
  assert.deepEqual(online, { state: 'committed', released: false });
  assert.equal((await pendingReports.get()).length, 0);

  await manager.authorizeDownload({ downloadKey: 'offline-report' });
  failReport = true;
  const offline = await manager.reportDownloadOutcome({
    downloadKey: 'offline-report',
    outcome: 'failed',
    bytesDownloaded: 0,
  });
  assert.deepEqual(offline, { state: 'released', released: true });
  assert.equal((await usage.get()).used, 0);
  assert.equal((await pendingReports.get()).length, 1);
  assert.equal((await pendingReports.get())[0].downloadKey, 'offline-report');
});

test('flushPendingReports drains in order and keeps the failing tail', async () => {
  const calls: string[] = [];
  const { manager, pendingReports } = remoteSetup(
    remoteStub({
      report: async input => {
        calls.push(input.downloadKey);
        if (input.downloadKey === 'b') throw new BillingUnavailableError('offline', { allowLocalFallback: true });
        return { state: 'committed' };
      },
    }),
  );
  await pendingReports.set([
    { downloadKey: 'a', outcome: 'success', bytesDownloaded: 10, reportedAt: 1 },
    { downloadKey: 'b', outcome: 'failed', bytesDownloaded: 0, reportedAt: 2 },
    { downloadKey: 'c', outcome: 'success', bytesDownloaded: 5, reportedAt: 3 },
  ]);

  assert.equal(await manager.flushPendingReports(), 1);
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(
    (await pendingReports.get()).map(report => report.downloadKey),
    ['b', 'c'],
  );
});

test('syncEntitlement mirrors the Worker payload and caches the signed snapshot', async () => {
  const snapshot: EntitlementSnapshot = {
    v: 1,
    deviceId: 'dev_test',
    plan: 'pro',
    subscriptionStatus: 'active',
    subscriptionEnd: null,
    creditBalance: 7,
    freeUsed: 1,
    utcDay: '2026-11-18',
    issuedAt: Date.parse('2026-11-18T09:00:00.000Z'),
    expiresAt: Date.parse('2026-11-21T09:00:00.000Z'),
  };
  const { manager, usage, entitlement } = remoteSetup(
    remoteStub({
      fetchEntitlement: async () => ({
        plan: 'pro',
        free: { used: 1, limit: 2, utcDate: '2026-11-18' },
        credits: 7,
        subscription: { status: 'active', currentPeriodEnd: null },
        snapshot,
        signature: 'sig',
        keyId: 'key-1',
      }),
    }),
  );

  const result = await manager.syncEntitlement();
  assert.equal(result.ok, true);
  assert.equal(result.status.plan, 'pro');
  assert.equal(result.status.credits, 7);
  assert.deepEqual(await usage.get(), { utcDate: '2026-11-18', used: 1, credits: 7 });
  const cached = await entitlement.get();
  assert.deepEqual(cached.snapshot, snapshot);
  assert.equal(cached.signature, 'sig');
  assert.equal(cached.verifiedAt, null);
});

test('checkout, portal and activation return actionable results without throwing', async () => {
  const { manager } = remoteSetup(remoteStub());

  assert.deepEqual(await manager.startCheckout('credits_10'), {
    ok: true,
    checkoutUrl: 'https://checkout.test/session',
  });
  assert.deepEqual(await manager.openPortal(), { ok: true, portalUrl: 'https://portal.test/session' });

  const activated = await manager.activateLicense('ABCD-1234');
  assert.equal(activated.ok, true);
  if (activated.ok) assert.equal(activated.status.plan, 'pro');

  const failing = remoteSetup(
    remoteStub({
      checkout: async () => {
        throw new BillingUnavailableError('offline', { allowLocalFallback: true });
      },
    }),
  ).manager;
  const failed = await failing.startCheckout('credits_10');
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, 'billing_unavailable');
});

// ─── M4: offline grace, signed snapshots, reconciliation ───

const snapshotKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const snapshotPublicJwk = snapshotKeys.publicKey.export({ format: 'jwk' }) as JsonWebKey;
const signSnapshot = (snapshot: EntitlementSnapshot): string =>
  sign('sha256', Buffer.from(canonicalSnapshotJson(snapshot)), {
    key: snapshotKeys.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');

const validSnapshot = (overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot => ({
  v: 1,
  deviceId: 'dev_test',
  plan: 'free',
  subscriptionStatus: 'none',
  subscriptionEnd: null,
  creditBalance: 0,
  freeUsed: 0,
  utcDay: '2026-11-18',
  issuedAt: Date.parse('2026-11-18T09:00:00.000Z'),
  expiresAt: Date.parse('2026-11-21T09:00:00.000Z'),
  ...overrides,
});

test('snapshot signatures verify canonical bytes and fail closed on tampering', async () => {
  const snapshot = validSnapshot({ creditBalance: 5 });
  const signature = signSnapshot(snapshot);

  assert.equal(await verifySnapshotSignature(snapshot, signature, snapshotPublicJwk), true);
  assert.equal(await verifySnapshotSignature({ ...snapshot, creditBalance: 99 }, signature, snapshotPublicJwk), false);
  assert.equal(await verifySnapshotSignature(snapshot, signature, null), false);
  assert.equal(await verifySnapshotSignature(snapshot, 'not-base64!!', snapshotPublicJwk), false);

  const otherKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as JsonWebKey;
  assert.equal(await verifySnapshotSignature(snapshot, signature, otherKey), false);
});

test('createSnapshotResolver rejects device mismatch, missing keys and records verifiedAt', async () => {
  const snapshot = validSnapshot();
  const cache = memory<EntitlementCacheRecord>({
    snapshot,
    signature: signSnapshot(snapshot),
    verifiedAt: null,
  });
  const verifiedAt = Date.parse('2026-11-18T10:00:00.000Z');
  const resolver = createSnapshotResolver({
    storage: cache,
    publicKey: () => snapshotPublicJwk,
    deviceId: async () => 'dev_test',
    now: () => verifiedAt,
  });

  assert.deepEqual(await resolver(), snapshot);
  assert.equal((await cache.get()).verifiedAt, verifiedAt);

  const wrongDevice = createSnapshotResolver({
    storage: cache,
    publicKey: () => snapshotPublicJwk,
    deviceId: async () => 'dev_other',
  });
  assert.equal(await wrongDevice(), null);

  const missingKey = createSnapshotResolver({
    storage: cache,
    publicKey: () => null,
    deviceId: async () => 'dev_test',
  });
  assert.equal(await missingKey(), null);
});

const snapshotSetup = (snapshot: EntitlementSnapshot | null, initialUsage: Partial<LicenseLocalUsage> = {}) => {
  const clock = Date.parse('2026-11-18T10:00:00.000Z');
  const usage = memory<LicenseLocalUsage>({ utcDate: '2026-11-18', used: 0, credits: 0, ...initialUsage });
  const authorizations = memory<LicenseAuthorizations>({});
  const pendingReports = memory<PendingReport[]>([]);
  const manager = createLicenseManager({
    storage: { usage, authorizations, pendingReports },
    now: () => clock,
    remote: remoteStub({
      authorize: async () => {
        throw new BillingUnavailableError('offline', { allowLocalFallback: true });
      },
    }),
    deviceId: async () => 'dev_test',
    resolveSnapshot: async () => snapshot,
  });
  return { manager, usage, authorizations, pendingReports };
};

test('offline authorize spends signed snapshot credits and caps the free quota', async () => {
  const creditsSnapshot = validSnapshot({ creditBalance: 3, freeUsed: 2 });
  const withCredits = snapshotSetup(creditsSnapshot, { used: 2, credits: 0 });
  const verdict = await withCredits.manager.authorizeDownload({ downloadKey: 'credit-offline' });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.source, 'credits');
  assert.equal(verdict.offline, true);
  assert.deepEqual(await withCredits.usage.get(), { utcDate: '2026-11-18', used: 2, credits: 2 });

  const clamped = snapshotSetup(validSnapshot({ freeUsed: 2 }), { used: 0, credits: 0 });
  await assert.rejects(() => clamped.manager.authorizeDownload({ downloadKey: 'fresh-storage' }), PaymentRequiredError);
});

test('expired or missing snapshots never grant offline credits', async () => {
  const expired = validSnapshot({
    creditBalance: 5,
    freeUsed: 2,
    expiresAt: Date.parse('2026-11-18T09:30:00.000Z'),
  });
  const expiredSetup = snapshotSetup(expired, { used: 2, credits: 0 });
  await assert.rejects(() => expiredSetup.manager.authorizeDownload({ downloadKey: 'expired' }), PaymentRequiredError);

  const missing = snapshotSetup(null, { used: 2, credits: 0 });
  await assert.rejects(() => missing.manager.authorizeDownload({ downloadKey: 'no-snapshot' }), PaymentRequiredError);

  // The local free quota still works without any snapshot.
  const freeOnly = snapshotSetup(null, { used: 0, credits: 0 });
  const allowed = await freeOnly.manager.authorizeDownload({ downloadKey: 'free-only' });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.source, 'free');
});

test('offline authorizations queue reservation details and flush them to the Worker', async () => {
  const reports: Array<{ downloadKey: string; offline?: { source: string; freeReserved: number } }> = [];
  let reportMode: 'unknown' | 'accepted' = 'unknown';
  const remote = remoteStub({
    authorize: async () => {
      throw new BillingUnavailableError('offline', { allowLocalFallback: true });
    },
    report: async input => {
      reports.push(input);
      return reportMode === 'unknown' ? { state: 'unknown' } : { state: 'committed' };
    },
  });
  const { manager, pendingReports } = remoteSetup(remote);

  await manager.authorizeDownload({ downloadKey: 'offline-backfill' });
  await manager.reportDownloadOutcome({ downloadKey: 'offline-backfill', outcome: 'success', bytesDownloaded: 42 });

  const [queued] = await pendingReports.get();
  assert.equal(queued.downloadKey, 'offline-backfill');
  assert.deepEqual(queued.offline, {
    source: 'free',
    freeReserved: 1,
    creditsReserved: 0,
    authorizedAt: Date.parse('2026-11-18T10:00:00.000Z'),
  });

  reportMode = 'accepted';
  assert.equal(await manager.flushPendingReports(), 1);
  assert.equal(reports.at(-1)?.offline?.source, 'free');
  assert.equal(reports.at(-1)?.offline?.freeReserved, 1);
  assert.equal((await pendingReports.get()).length, 0);
});

test('reconcileLocalState commits stale reservations and surfaces the pending backlog', async () => {
  const { manager, authorizations, pendingReports } = setup();
  const now = Date.parse('2026-11-18T10:00:00.000Z');
  const staleAt = now - STALE_RESERVATION_MS - 1000;
  const freshAt = Date.parse('2026-11-18T09:00:00.000Z');
  await authorizations.set({
    stale: {
      state: 'reserved',
      source: 'free',
      authorizationId: 'auth_stale',
      createdAt: staleAt,
      updatedAt: staleAt,
      freeReserved: 1,
      creditsReserved: 0,
    },
    fresh: {
      state: 'reserved',
      source: 'free',
      authorizationId: 'auth_fresh',
      createdAt: freshAt,
      updatedAt: freshAt,
      freeReserved: 1,
      creditsReserved: 0,
    },
  });
  await pendingReports.set([{ downloadKey: 'queued', outcome: 'success', bytesDownloaded: 1, reportedAt: 1 }]);

  assert.deepEqual(await manager.reconcileLocalState(), { pendingReports: 1, staleCommitted: 1 });
  const records = await authorizations.get();
  assert.equal(records.stale.state, 'committed');
  assert.equal(records.fresh.state, 'reserved');
});
