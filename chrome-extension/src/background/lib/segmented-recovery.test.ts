import { createDownloadRuntime } from './download-runtime';
import { isLiveHls, isLiveDash } from '../../offscreen/lib/segment-policy';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DownloadRuntimeStore } from './download-runtime';

const fixture = async () => {
  let state: Awaited<ReturnType<DownloadRuntimeStore['read']>>;
  const stopped: string[] = [];
  const store: DownloadRuntimeStore = {
    read: async () => state,
    write: async value => {
      state = value;
    },
  };
  const runtime = createDownloadRuntime({
    store,
    concurrency: 1,
    executor: {
      cancel: async identity => {
        stopped.push(identity.intent);
      },
    },
  });
  const { jobId } = await runtime.submit({
    requestId: 'vod',
    execution: { url: 'https://fixture.test/playlist.m3u8', kind: 'hls', outputFormat: 'mp4' },
  });
  await runtime.schedule();
  const job = (await runtime.snapshot()).jobs[0];
  const identity = { jobId, attempt: job.attempt, executionId: job.executionId! };
  await runtime.executorEvent({ ...identity, type: 'acknowledged' });
  await runtime.executorEvent({
    ...identity,
    type: 'progress',
    phase: 'fetching',
    downloadedBytes: 50,
    estimatedBytes: 100,
  });
  return { runtime, store, jobId, identity, stopped };
};
test('VOD/live classification requires a closed HLS playlist or static DASH MPD', () => {
  assert.equal(isLiveHls('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\nsegment.ts'), true);
  assert.equal(isLiveHls('#EXTM3U\r\n #EXT-X-ENDLIST\r\n'), false);
  assert.equal(isLiveDash('<MPD\n type="dynamic">'), true);
  assert.equal(isLiveDash("<MPD type='static'>"), false);
});
test('manifest drift clears old progress only with an explicit source-restart diagnostic', async () => {
  const f = await fixture();
  await f.runtime.command(f.jobId, { type: 'segmented-source', source: { fingerprint: 'a'.repeat(64), live: false } });
  assert.equal((await f.runtime.snapshot()).jobs[0].progress.downloadedBytes, 50);
  await f.runtime.command(f.jobId, {
    type: 'segmented-source',
    source: { fingerprint: 'b'.repeat(64), live: false },
    restartReason: 'Playlist changed; downloading new segments',
  });
  const job = (await f.runtime.snapshot()).jobs[0];
  assert.equal(job.progress.downloadedBytes, 0);
  assert.equal(job.progress.fetchBytes, undefined);
  assert.match(job.diagnostics.at(-1)!.reason!, /Playlist changed/);
});
test('processing progress cannot erase the fetched byte count', async () => {
  const f = await fixture();
  await f.runtime.executorEvent({ ...f.identity, type: 'progress', phase: 'processing', downloadedBytes: 0 });
  assert.equal((await f.runtime.snapshot()).jobs[0].progress.downloadedBytes, 50);
});
test('a live pause request means stop and an interrupted live snapshot never restores as resumable', async () => {
  const f = await fixture();
  await f.runtime.command(f.jobId, { type: 'segmented-source', source: { fingerprint: 'a'.repeat(64), live: true } });
  await f.runtime.command(f.jobId, { type: 'pause' });
  assert.deepEqual(f.stopped, ['cancel']);
  await f.runtime.executorEvent({ ...f.identity, type: 'cancelled' });
  assert.equal((await f.runtime.snapshot()).jobs[0].state, 'cancelled');
  const g = await fixture();
  await g.runtime.command(g.jobId, { type: 'segmented-source', source: { fingerprint: 'a'.repeat(64), live: true } });
  const restored = createDownloadRuntime({
    store: g.store,
    concurrency: 1,
    recoverCheckpoint: async () => ({ downloadedBytes: 50 }),
  });
  await restored.bootstrap({ executions: [] });
  const job = (await restored.snapshot()).jobs[0];
  assert.equal(job.state, 'failed');
  assert.equal(job.recovery, undefined);
  assert.match(job.terminal!.reason!, /Live streams cannot resume/);
});

test('completed live processing Retry freezes its original manifest and remains valid across pause and restart', async () => {
  const f = await fixture();
  await f.runtime.command(f.jobId, {
    type: 'segmented-source',
    source: {
      fingerprint: 'a'.repeat(64),
      live: true,
      snapshot: {
        kind: 'hls',
        video: { url: 'https://fixture.test/playlist.m3u8', manifestText: '#EXTM3U\nold-window.ts' },
      },
    },
  });
  await f.runtime.executorEvent({ ...f.identity, type: 'progress', phase: 'processing', downloadedBytes: 0 });
  await f.runtime.executorEvent({ ...f.identity, type: 'failed', reason: 'mux failed', failureKind: 'processing' });
  await f.runtime.command(f.jobId, { type: 'retry' });
  assert.equal((await f.runtime.snapshot()).jobs[0].execution.reuseSegmentedSnapshot, true);
  await f.runtime.schedule();
  const job = (await f.runtime.snapshot()).jobs[0];
  await f.runtime.command(f.jobId, { type: 'pause' });
  assert.deepEqual(f.stopped, ['pause']);
  await f.runtime.executorEvent({
    jobId: job.jobId,
    attempt: job.attempt,
    executionId: job.executionId!,
    type: 'cancelled',
  });
  const restored = createDownloadRuntime({ store: f.store, concurrency: 1 });
  await restored.bootstrap({ executions: [] });
  assert.equal((await restored.snapshot()).jobs[0].state, 'paused');
  await restored.command(f.jobId, { type: 'resume' });
  assert.equal((await restored.snapshot()).jobs[0].execution.reuseSegmentedSnapshot, true);
});

test('a transient live transfer failure never schedules automatic stream resume', async () => {
  const f = await fixture();
  await f.runtime.command(f.jobId, { type: 'segmented-source', source: { fingerprint: 'a'.repeat(64), live: true } });
  await f.runtime.executorEvent({
    ...f.identity,
    type: 'failed',
    reason: 'live reset',
    failureKind: 'transport',
    recoverable: true,
  });
  assert.equal((await f.runtime.snapshot()).jobs[0].state, 'failed');
  assert.equal((await f.runtime.snapshot()).jobs[0].recovery, undefined);
});

test('expired live processing cache invalidates frozen Retry instead of fetching an obsolete playlist snapshot', async () => {
  const f = await fixture();
  await f.runtime.command(f.jobId, {
    type: 'segmented-source',
    source: {
      fingerprint: 'a'.repeat(64),
      live: true,
      snapshot: {
        kind: 'hls',
        video: { url: 'https://fixture.test/playlist.m3u8', manifestText: '#EXTM3U\nold-window.ts' },
      },
    },
  });
  await f.runtime.executorEvent({ ...f.identity, type: 'failed', reason: 'mux failed', failureKind: 'processing' });
  await f.runtime.command(f.jobId, { type: 'cache-invalidated', reason: 'Partial cache expired' });
  await f.runtime.command(f.jobId, { type: 'retry' });
  assert.equal((await f.runtime.snapshot()).jobs[0].execution.reuseSegmentedSnapshot, false);
});
