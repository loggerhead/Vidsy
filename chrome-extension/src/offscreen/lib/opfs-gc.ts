// Startup garbage collection for the Origin Private File System.
//
import { opfsJobName } from './opfs-job-name';
import { selectCacheEvictions } from '../../background/lib/download-cache';
import { createLogger } from '@extension/shared';
import type { CacheRecord } from './cache-protocol';

const log = createLogger('opfs');

type DirHandleWithKeys = FileSystemDirectoryHandle & {
  keys(): AsyncIterableIterator<string>;
};

export const purgeOpfsOrphans = async (policy?: {
  records: CacheRecord[];
  liveJobs: Set<string>;
  activeJobs?: Set<string>;
  now?: number;
  ttlMs?: number;
  maxBytes?: number;
  removeFile?: (name: string) => Promise<void>;
  removeRecord: (name: string) => Promise<void>;
  removeArtifact?: (record: CacheRecord) => Promise<void>;
  invalidated?: (jobKey: string, reason: string) => Promise<void>;
}): Promise<{ removed: number; failed: number }> => {
  let removed = 0;
  let failed = 0;
  try {
    const root = (await navigator.storage.getDirectory()) as DirHandleWithKeys;
    const names: string[] = [];
    // Enumerate first, then delete — avoid mutating while iterating.
    for await (const name of root.keys()) {
      names.push(name);
    }
    const records = new Map(policy?.records.map(record => [record.name, record]) ?? []);
    const eligible = policy?.records.filter(record => policy.liveJobs.has(record.jobKey)) ?? [];
    const evictions = policy
      ? selectCacheEvictions(eligible, {
          now: policy.now ?? Date.now(),
          ttlMs: policy.ttlMs,
          maxBytes: policy.maxBytes,
          activeJobs: policy.activeJobs,
        })
      : { names: [], jobKeys: [] };
    const evicted = new Set(evictions.names);
    const owners = policy
      ? await Promise.all(
          [...policy.liveJobs].map(async key => ({
            key,
            hash: (await opfsJobName('http', key, 'in', 'bin')).split('-')[1],
          })),
        )
      : [];
    for (const name of names) {
      const record = records.get(name);
      const owner = owners.find(owner => name.includes(owner.hash));
      if (owner && policy?.activeJobs?.has(owner.key)) continue;
      const expiredArtifact = record?.artifact && record.artifact.expiresAt <= (policy?.now ?? Date.now());
      if (expiredArtifact && (record.complete || record.ranges)) {
        await policy?.removeArtifact?.(record);
        await policy?.invalidated?.(
          record.jobKey,
          'Saved output delivery expired; verified inputs remain available for processing Retry',
        );
      }
      if (
        record &&
        policy?.liveJobs.has(record.jobKey) &&
        !evicted.has(name) &&
        (!expiredArtifact || record.complete || record.ranges)
      )
        continue;
      try {
        if (policy?.removeFile) await policy.removeFile(name);
        else await root.removeEntry(name, { recursive: true });
        await policy?.removeRecord(name);
        if (expiredArtifact)
          await policy?.invalidated?.(
            record!.jobKey,
            'Saved output delivery expired; Retry processing to generate it again',
          );
        if (
          !record &&
          owner &&
          !policy?.records.some(entry => entry.jobKey === owner.key && (entry.complete || entry.ranges?.done.length))
        )
          await policy?.invalidated?.(
            owner.key,
            'No verifiable byte checkpoint is available; continuing will download this input again',
          );
        removed++;
      } catch {
        failed++;
      }
    }
    if (policy) {
      for (const record of policy.records)
        if (!names.includes(record.name)) {
          await policy.removeRecord(record.name);
          await policy.invalidated?.(record.jobKey, 'Cached file is unavailable; continuing will download it again');
        }
      for (const jobKey of evictions.jobKeys)
        await policy.invalidated?.(
          jobKey,
          'Partial download cache expired or was removed to free storage; continuing will download it again',
        );
    }
  } catch (err) {
    log.warn('gc_failed', err);
  }
  return { removed, failed };
};
