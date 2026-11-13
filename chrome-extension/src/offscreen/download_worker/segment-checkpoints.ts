import { fetchCheckpointedRange, verifyRangeCache } from './range-fetch';
import { RangeResumeRegistry } from './range-resume';
import { RangeResponseError, assertRangeResponse } from './response-validation';
import { cacheFingerprint } from '../lib/cache-protocol';
import { DownloadFailure } from '../lib/download-failure';
import { responseValidator } from '../lib/http-validator';
import { HttpRequestError } from '../lib/network-request';
import type { RangeIo, RangeOpen } from './range-fetch';
import type { CacheCommand, CacheResponse } from '../lib/cache-protocol';

// Remote coordinates can refer to a manifest byte range inside a larger file.
// The caller maps these coordinates to a separate local atomic segment file.
export const checkpointSegment = async (args: {
  name: string;
  jobKey: string;
  url: string;
  identity: string;
  range?: { start: number; end: number };
  signal: AbortSignal;
  open: (start: number, end: number, signal: AbortSignal, version?: string) => ReturnType<RangeOpen>;
  cache: (command: CacheCommand) => Promise<CacheResponse>;
  disk: { open: () => Promise<void>; size: () => number; truncate: () => void; io: RangeIo };
  progress?: (bytes: number) => void;
  activity?: (activity: 'receiving' | 'retrying') => void;
}): Promise<boolean> => {
  const base = args.range?.start ?? 0;
  const { record } = await args.cache({ operation: 'read', name: args.name });
  if (record?.ranges && record.segmentIdentity !== args.identity)
    throw new DownloadFailure('integrity', 'Partial segment manifest or track identity changed');
  const probe = await args.open(base, base, args.signal);
  let total: number, end: number, validator: ReturnType<typeof responseValidator>;
  try {
    if (!probe.response.ok) throw new HttpRequestError(probe.response.status, args.url);
    if (probe.response.status !== 206) {
      if (record?.ranges) throw new RangeResponseError('Segment no longer accepts checkpoint byte ranges');
      return false;
    }
    const match = probe.response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    total = match ? Number(match[3]) : NaN;
    if (!Number.isSafeInteger(total) || total <= base) throw new RangeResponseError('Invalid segment Range length');
    assertRangeResponse(probe.response, { start: base, end: base, total });
    end = args.range?.end ?? total - 1;
    if (!Number.isSafeInteger(end) || end < base || end >= total)
      throw new RangeResponseError('Segment manifest byte range exceeds the source');
    validator = responseValidator(probe.response.headers);
  } finally {
    await probe.response.body?.cancel().catch(() => undefined);
    probe.dispose();
  }
  const source = { url: args.url, totalBytes: total, ranges: [{ start: base, end }], ...validator };
  if (record?.ranges && record.fingerprint !== (await cacheFingerprint(record.ranges.source)))
    throw new DownloadFailure('integrity', 'Partial segment fingerprint changed');
  const registry = new RangeResumeRegistry();
  registry.restore(args.name, record?.ranges);
  await args.disk.open();
  const expected = { start: base, end, total, ...validator };
  const open: RangeOpen = (start, end, signal) => args.open(start, end, signal, validator.resourceVersion);
  const samples = await verifyRangeCache({
    record: record?.ranges,
    range: expected,
    io: args.disk.io,
    open,
    signal: args.signal,
  });
  const restored = registry.begin(args.name, source, args.disk.size() + base, samples);
  if (!restored) args.disk.truncate();
  const checkpoint = registry.snapshot(args.name)?.checkpoints?.[0];
  await fetchCheckpointedRange({
    i: 0,
    range: expected,
    checkpoint,
    io: args.disk.io,
    open,
    signal: args.signal,
    progress: args.progress,
    activity: args.activity,
    commit: async (checkpoint, done) => {
      registry.checkpoint(args.name, checkpoint);
      if (done) registry.completed(args.name, { i: 0, start: base, end, downloaded: end - base + 1, status: 'done' });
      const ranges = registry.snapshot(args.name)!;
      const response = await args.cache({
        operation: 'write',
        name: args.name,
        jobKey: args.jobKey,
        patch: {
          size: args.disk.size(),
          ranges,
          fingerprint: await cacheFingerprint(ranges.source),
          segmentIdentity: args.identity,
        },
      });
      if (!response.ok) throw new Error(response.error ?? 'Segment checkpoint persistence failed');
    },
  });
  return true;
};
