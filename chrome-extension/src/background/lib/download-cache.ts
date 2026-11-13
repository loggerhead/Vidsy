import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_BYTES,
  canonicalCacheSource,
} from '../../offscreen/lib/cache-protocol';
import type { CacheCommand, CacheRecord, CacheResponse } from '../../offscreen/lib/cache-protocol';

export type CacheLedger = { schemaVersion: 1; records: Record<string, CacheRecord> };
export const emptyCacheLedger = (): CacheLedger => ({ schemaVersion: 1, records: {} });
export const cachedDownloadBytes = (files: CacheRecord[]): number => {
  const parents = new Set(files.filter(file => file.complete).map(file => file.name));
  let bytes = 0;
  for (const file of files) {
    const parent = file.name.replace(/(?:\.part-\d+|\.init)$/, '');
    if (parent !== file.name && parents.has(parent)) continue;
    if (file.complete) bytes += file.complete.size;
    else if (file.ranges) {
      bytes += file.ranges.done.reduce((sum, chunk) => sum + chunk.downloaded, 0);
      const done = new Set(file.ranges.done.map(chunk => chunk.i));
      bytes += (file.ranges.checkpoints ?? [])
        .filter(checkpoint => !done.has(checkpoint.i))
        .reduce((sum, checkpoint) => sum + checkpoint.downloaded, 0);
    }
  }
  return bytes;
};

export const describeCachedProgress = (files: CacheRecord[], estimatedBytes?: number, artifactReady = false) => {
  const cachedBytes =
    cachedDownloadBytes(files) ||
    (artifactReady ? (files.find(file => file.artifact)?.artifact?.metadata.size ?? 0) : 0);
  const ranges = files.filter(file => file.ranges && !file.segmentIdentity);
  let nextRangeOffset: number | undefined;
  if (ranges.length === 1) {
    const record = ranges[0].ranges!;
    const done = new Set(record.done.map(chunk => chunk.i));
    const index = record.source.ranges.findIndex((_range, i) => !done.has(i));
    if (index >= 0)
      nextRangeOffset =
        record.source.ranges[index].start +
        (record.checkpoints?.find(checkpoint => checkpoint.i === index)?.downloaded ?? 0);
  }
  return {
    cachedBytes,
    resumeFromBytes: cachedBytes,
    nextRangeOffset,
    remainingDownloadBytes: artifactReady
      ? 0
      : estimatedBytes === undefined
        ? undefined
        : Math.max(0, estimatedBytes - cachedBytes),
  };
};

export const validateCacheLedger = (value: unknown): CacheLedger => {
  if (value === undefined) return emptyCacheLedger();
  const ledger = value as CacheLedger;
  if (
    ledger.schemaVersion !== CACHE_SCHEMA_VERSION ||
    !ledger.records ||
    typeof ledger.records !== 'object' ||
    Array.isArray(ledger.records)
  )
    throw new Error('Unsupported or corrupt download cache schema');
  for (const [name, record] of Object.entries(ledger.records)) {
    if (
      record.schemaVersion !== 1 ||
      record.name !== name ||
      !record.jobKey ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0 ||
      !Number.isFinite(record.createdAt) ||
      !Number.isFinite(record.updatedAt) ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= record.createdAt ||
      (record.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(record.fingerprint))
    )
      throw new Error('Corrupt download cache file record');
  }
  return ledger;
};

export const createDownloadCache = (
  store: { read: () => Promise<unknown>; write: (ledger: CacheLedger) => Promise<void>; ttlMs?: () => Promise<number> },
  now = Date.now,
) => {
  let tail = Promise.resolve();
  return {
    command(command: CacheCommand): Promise<CacheResponse> {
      const pending = tail.then(async () => {
        const ledger = structuredClone(validateCacheLedger(await store.read()));
        let record: CacheRecord | undefined;
        if (command.operation === 'read') record = ledger.records[command.name];
        if (command.operation === 'list') return { ok: true, records: Object.values(ledger.records) };
        if (command.operation === 'write') {
          if (!command.name || command.name.includes('/') || !command.jobKey)
            throw new Error('Invalid cache file identity');
          const previous = ledger.records[command.name];
          if (previous && previous.jobKey !== command.jobKey) throw new Error('Cache file owner changed');
          record = {
            ...(previous ?? {
              schemaVersion: 1 as const,
              name: command.name,
              jobKey: command.jobKey,
              createdAt: now(),
              updatedAt: now(),
              expiresAt: now(),
              size: 0,
            }),
            ...command.patch,
          };
          if (
            previous?.ranges &&
            command.patch.ranges &&
            canonicalCacheSource(previous.ranges.source) === canonicalCacheSource(command.patch.ranges.source)
          ) {
            const done = new Map(
              [...previous.ranges.done, ...command.patch.ranges.done].map(chunk => [chunk.i, chunk]),
            );
            record.ranges = { source: command.patch.ranges.source, done: [...done.values()] };
            const checkpoints = new Map(
              (previous.ranges.checkpoints ?? []).map(checkpoint => [checkpoint.i, checkpoint]),
            );
            for (const checkpoint of command.patch.ranges.checkpoints ?? [])
              if ((checkpoints.get(checkpoint.i)?.downloaded ?? 0) <= checkpoint.downloaded)
                checkpoints.set(checkpoint.i, checkpoint);
            if (checkpoints.size) record.ranges.checkpoints = [...checkpoints.values()];
            record.size = Math.max(previous.size, record.size);
          }
          record.updatedAt = now();
          record.expiresAt = now() + ((await store.ttlMs?.()) ?? DEFAULT_CACHE_TTL_MS);
          ledger.records[command.name] = record;
        }
        if (command.operation === 'remove') delete ledger.records[command.name];
        if (command.operation === 'remove-artifact' && ledger.records[command.name])
          delete ledger.records[command.name].artifact;
        if (command.operation === 'set-retention') {
          if (!Number.isFinite(command.ttlMs) || command.ttlMs < 86400000 || command.ttlMs > 365 * 86400000)
            throw new Error('Invalid cache retention period');
          for (const entry of Object.values(ledger.records)) entry.expiresAt = entry.updatedAt + command.ttlMs;
        }
        if (command.operation === 'remove-job')
          for (const [name, entry] of Object.entries(ledger.records))
            if (entry.jobKey === command.jobKey) delete ledger.records[name];
        validateCacheLedger(ledger);
        if (command.operation !== 'read') await store.write(ledger);
        return { ok: true, record };
      });
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
};

// Whole jobs are evicted together: keeping half of a mux input set would imply
// recovery that no longer exists. Active jobs are protected during capacity GC.
export const selectCacheEvictions = (
  records: CacheRecord[],
  args: { now: number; ttlMs?: number; maxBytes?: number; activeJobs?: Set<string> },
) => {
  const ttl = args.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const limit = args.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
  const groups = new Map<string, { records: CacheRecord[]; updatedAt: number; size: number }>();
  for (const record of records) {
    const group = groups.get(record.jobKey) ?? { records: [], updatedAt: 0, size: 0 };
    group.records.push(record);
    group.updatedAt = Math.max(group.updatedAt, record.updatedAt);
    group.size += record.size;
    groups.set(record.jobKey, group);
  }
  const removed = new Set<string>();
  let bytes = records.reduce((sum, record) => sum + record.size, 0);
  for (const [job, group] of groups)
    if (!args.activeJobs?.has(job) && args.now - group.updatedAt >= ttl) {
      removed.add(job);
      bytes -= group.size;
    }
  for (const [job, group] of [...groups].sort((a, b) => a[1].updatedAt - b[1].updatedAt)) {
    if (bytes <= limit) break;
    if (!removed.has(job) && !args.activeJobs?.has(job)) {
      removed.add(job);
      bytes -= group.size;
    }
  }
  return {
    names: records.filter(record => removed.has(record.jobKey)).map(record => record.name),
    jobKeys: [...removed],
  };
};
