import {
  createDownloadCache,
  selectCacheEvictions,
  validateCacheLedger,
  describeCachedProgress,
} from './download-cache';
import { cacheFingerprint } from '../../offscreen/lib/cache-protocol';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CacheRecord } from '../../offscreen/lib/cache-protocol';

const file = (name: string, jobKey: string, size: number, updatedAt: number): CacheRecord => ({
  schemaVersion: 1,
  name,
  jobKey,
  size,
  createdAt: 0,
  updatedAt,
  expiresAt: updatedAt + 100,
});

test('paused details report durable Range offsets and full restart cost for a non-Range partial stream', () => {
  const block = 1024 * 1024;
  const record = file('input', 'job', 3 * block, 0);
  record.ranges = {
    source: {
      url: 'https://source.test/file',
      totalBytes: 3 * block,
      ranges: [
        { start: 0, end: 2 * block - 1 },
        { start: 2 * block, end: 3 * block - 1 },
      ],
    },
    done: [{ i: 1, start: 2 * block, end: 3 * block - 1, downloaded: block, status: 'done' }],
    checkpoints: [{ i: 0, start: 0, end: 2 * block - 1, downloaded: block, hashes: ['a'.repeat(64)] }],
  };
  assert.deepEqual(describeCachedProgress([record], 3 * block), {
    cachedBytes: 2 * block,
    resumeFromBytes: 2 * block,
    nextRangeOffset: block,
    remainingDownloadBytes: block,
  });
  assert.equal(
    describeCachedProgress([file('stream', 'job', 2 * block, 0)], 3 * block).remainingDownloadBytes,
    3 * block,
  );
  assert.equal(describeCachedProgress([record], 3 * block, true).remainingDownloadBytes, 0);
});
test('cache checkpoints survive recreation, keep schema and TTL, and merge concurrent range completions', async () => {
  let saved: unknown;
  const store = {
    read: async () => saved,
    write: async (value: unknown) => {
      saved = structuredClone(value);
    },
    ttlMs: async () => 100,
  };
  const cache = createDownloadCache(store, () => 10);
  const source = {
    url: 'https://fixture/video',
    resourceVersion: '"one"',
    totalBytes: 8,
    ranges: [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ],
  };
  const chunk = (i: number) => ({ i, ...source.ranges[i], downloaded: 4, status: 'done' as const });
  await Promise.all(
    [0, 1].map(i =>
      cache.command({
        operation: 'write',
        name: 'video',
        jobKey: 'job',
        patch: { size: i ? 8 : 4, ranges: { source, done: [chunk(i)] }, fingerprint: '1'.repeat(64) },
      }),
    ),
  );
  const next = createDownloadCache(store, () => 20);
  const { record } = await next.command({ operation: 'read', name: 'video' });
  assert.deepEqual(record?.ranges?.done.map(chunk => chunk.i).sort(), [0, 1]);
  assert.equal(record?.size, 8);
  assert.equal(record?.schemaVersion, 1);
  assert.equal(record?.expiresAt, 110);
  await assert.rejects(
    next.command({ operation: 'write', name: 'video', jobKey: 'another', patch: { size: 8 } }),
    /owner/,
  );
  await next.command({ operation: 'remove-job', jobKey: 'job' });
  assert.deepEqual((await next.command({ operation: 'list' })).records, []);
});

test('schema validation refuses corrupt or unsupported ledgers', () => {
  for (const value of [
    { schemaVersion: 2, records: {} },
    { schemaVersion: 1, records: { video: file('different-name', 'job', 8, 1) } },
    { schemaVersion: 1, records: { video: file('video', 'job', -1, 1) } },
  ])
    assert.throws(() => validateCacheLedger(value), /schema|record/);
});

test('TTL and capacity LRU evict whole input sets while protecting active jobs', () => {
  const records = [file('old-video', 'old', 40, 1), file('old-audio', 'old', 40, 1), file('new-video', 'new', 90, 90)];
  assert.deepEqual(selectCacheEvictions(records, { now: 100, ttlMs: 50, maxBytes: 500 }).names, [
    'old-video',
    'old-audio',
  ]);
  assert.deepEqual(selectCacheEvictions(records, { now: 100, ttlMs: 500, maxBytes: 100 }).jobKeys, ['old']);
  assert.deepEqual(
    selectCacheEvictions(records, { now: 100, ttlMs: 500, maxBytes: 100, activeJobs: new Set(['old']) }).jobKeys,
    ['new'],
  );
});

test('content fingerprint changes with validators, size and manifest', async () => {
  const source = { url: 'https://fixture/video', etag: '"one"', totalBytes: 8, manifest: 'vod-1' };
  const fingerprint = await cacheFingerprint(source);
  assert.equal(await cacheFingerprint(structuredClone(source)), fingerprint);
  assert.equal(
    await cacheFingerprint({
      manifest: source.manifest,
      totalBytes: source.totalBytes,
      etag: source.etag,
      url: source.url,
    }),
    fingerprint,
  );
  for (const change of [{ etag: '"two"' }, { totalBytes: 9 }, { manifest: 'vod-2' }, { url: 'https://other/video' }])
    assert.notEqual(await cacheFingerprint({ ...source, ...change }), fingerprint);
});
