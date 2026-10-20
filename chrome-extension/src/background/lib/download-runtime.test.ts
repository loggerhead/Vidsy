import { createDownloadRuntime } from './download-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DownloadRuntimeStore, ExecutorInventory, RuntimeSnapshot } from './download-runtime';

const spec = (requestId: string, title = requestId) => ({
  requestId,
  execution: {
    url: `https://fixtures.test/${requestId}.mp4`,
    kind: 'video' as const,
    outputFormat: 'mp4' as const,
  },
  display: { title },
});

const memoryStore = (initial?: Awaited<ReturnType<DownloadRuntimeStore['read']>>): DownloadRuntimeStore => {
  let state = initial;
  return {
    read: async () => state,
    write: async next => {
      state = next;
    },
  };
};

const inventory = (...executions: ExecutorInventory['executions']): ExecutorInventory => ({ executions });

const active = (snapshot: RuntimeSnapshot, requestId: string) =>
  snapshot.jobs.find(job => job.requestId === requestId)!;

test('DownloadRuntime submits idempotently and derives one-based queue positions from durable jobs', async () => {
  const runtime = createDownloadRuntime({ store: memoryStore(), concurrency: 1 });

  const first = await runtime.submit(spec('one'));
  const duplicate = await runtime.submit(spec('one', 'changed display title'));
  await runtime.submit(spec('two'));

  assert.equal(duplicate.jobId, first.jobId);
  assert.deepEqual(
    (await runtime.snapshot()).jobs.map(job => [job.requestId, job.queuePosition]),
    [
      ['one', 1],
      ['two', 2],
    ],
  );
  assert.equal(active(await runtime.snapshot(), 'one').display.title, 'one');
});

test('DownloadRuntime persists a claim before emitting a uniquely addressable start command', async () => {
  const starts: string[] = [];
  const runtime = createDownloadRuntime({
    store: memoryStore(),
    concurrency: 1,
    executor: {
      start: async command => {
        starts.push(`${command.jobId}:${command.attempt}:${command.executionId}`);
      },
    },
  });

  await runtime.submit(spec('one'));
  await runtime.bootstrap(inventory());
  const job = active(await runtime.snapshot(), 'one');

  assert.equal(job.state, 'starting');
  assert.equal(job.attempt, 1);
  assert.ok(job.executionId);
  assert.deepEqual(starts, [`${job.jobId}:1:${job.executionId}`]);
});

test('DownloadRuntime commits the claim before a long-running executor starts', async () => {
  const store = memoryStore();
  let stateAtDispatch: string | undefined;
  const runtime = createDownloadRuntime({
    store,
    concurrency: 1,
    executor: {
      start: async command => {
        stateAtDispatch = (await store.read())?.jobs[command.jobId].state;
      },
    },
  });

  await runtime.submit(spec('one'));
  await runtime.bootstrap(inventory());

  assert.equal(stateAtDispatch, 'starting');
});

test('DownloadRuntime recreates around the same store without duplicating an active execution', async () => {
  const store = memoryStore();
  const starts: string[] = [];
  const options = {
    store,
    concurrency: 1,
    executor: {
      start: async (command: { executionId: string }) => {
        starts.push(command.executionId);
      },
    },
  };
  const first = createDownloadRuntime(options);
  await first.submit(spec('one'));
  await first.bootstrap(inventory());
  const claimed = active(await first.snapshot(), 'one');

  const recreated = createDownloadRuntime(options);
  await recreated.bootstrap(
    inventory({
      jobId: claimed.jobId,
      requestId: claimed.requestId,
      attempt: claimed.attempt,
      executionId: claimed.executionId!,
      acknowledged: true,
    }),
  );

  assert.equal(active(await recreated.snapshot(), 'one').state, 'running');
  assert.equal(starts.length, 1);
});

test('DownloadRuntime rejects delayed events from a superseded execution without mutating the current attempt', async () => {
  const runtime = createDownloadRuntime({ store: memoryStore(), concurrency: 1 });
  await runtime.submit(spec('one'));
  await runtime.bootstrap(inventory());
  const first = active(await runtime.snapshot(), 'one');
  await runtime.command(first.jobId, { type: 'pause' });
  await runtime.executorEvent({
    type: 'cancelled',
    jobId: first.jobId,
    attempt: first.attempt,
    executionId: first.executionId!,
  });
  await runtime.command(first.jobId, { type: 'resume' });
  await runtime.bootstrap(inventory());
  const second = active(await runtime.snapshot(), 'one');

  await runtime.executorEvent({
    type: 'failed',
    jobId: first.jobId,
    attempt: first.attempt,
    executionId: first.executionId!,
    reason: 'late failure',
  });
  const current = active(await runtime.snapshot(), 'one');
  assert.notEqual(second.executionId, first.executionId);
  assert.equal(current.state, 'starting');
  assert.equal(current.diagnostics.at(-1)?.event, 'executor-event-rejected');
});

test('DownloadRuntime requires browser delivery completion before success and keeps terminal history isolated', async () => {
  const runtime = createDownloadRuntime({ store: memoryStore(), concurrency: 1 });
  await runtime.submit(spec('one'));
  await runtime.bootstrap(inventory());
  const claimed = active(await runtime.snapshot(), 'one');
  await runtime.executorEvent({
    type: 'acknowledged',
    jobId: claimed.jobId,
    attempt: claimed.attempt,
    executionId: claimed.executionId!,
  });
  await runtime.executorEvent({
    type: 'artifact',
    jobId: claimed.jobId,
    attempt: claimed.attempt,
    executionId: claimed.executionId!,
    downloadId: 42,
  });

  assert.equal(active(await runtime.snapshot(), 'one').state, 'finalizing');
  await runtime.browserDelivery({ jobId: claimed.jobId, downloadId: 42, state: 'complete' });
  assert.equal(active(await runtime.snapshot(), 'one').state, 'succeeded');
  assert.equal(await runtime.command(claimed.jobId, { type: 'clear-terminal' }), true);
  assert.equal((await runtime.snapshot()).jobs.length, 0);
  assert.equal(
    (await runtime.snapshot()).executorCommands.length,
    0,
    'cleared jobs must not retain execution snapshots',
  );
});

test('DownloadRuntime rejects illegal terminal transitions and preserves cancelled queue work', async () => {
  const runtime = createDownloadRuntime({ store: memoryStore(), concurrency: 1 });
  const submitted = await runtime.submit(spec('one'));
  assert.equal(await runtime.command(submitted.jobId, { type: 'resume' }), false);
  assert.equal(await runtime.command(submitted.jobId, { type: 'cancel' }), true);
  await runtime.bootstrap(inventory());
  assert.equal(active(await runtime.snapshot(), 'one').state, 'cancelled');
  assert.equal((await runtime.snapshot()).executorCommands.length, 0);
});

test('daily scheduling never requeues an active execution, even without inventory', async () => {
  const starts: string[] = [];
  const runtime = createDownloadRuntime({
    store: memoryStore(),
    concurrency: 1,
    executor: {
      start: async command => {
        starts.push(command.requestId);
      },
    },
  });
  await runtime.submit(spec('one'));
  await runtime.schedule();
  await runtime.submit(spec('two'));
  await Promise.all([runtime.schedule(), runtime.schedule(), runtime.bootstrap()]);
  assert.deepEqual(starts, ['one']);
  assert.equal(active(await runtime.snapshot(), 'one').attempt, 1);
  assert.equal(active(await runtime.snapshot(), 'two').state, 'queued');
});

test('scheduling returns before long executions and starts every available slot', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  const starts: string[] = [];
  const runtime = createDownloadRuntime({
    store: memoryStore(),
    concurrency: 2,
    executor: {
      start: async command => {
        starts.push(command.requestId);
        await pending;
      },
    },
  });
  await runtime.submit(spec('one'));
  await runtime.submit(spec('two'));
  await runtime.submit(spec('three'));
  await runtime.schedule();
  assert.deepEqual(starts, ['one', 'two']);
  finish();
});

test('failed attempts can retry and independent requests can download the same URL', async () => {
  const runtime = createDownloadRuntime({ store: memoryStore(), concurrency: 1 });
  const { jobId } = await runtime.submit(spec('one'));
  await runtime.schedule();
  const first = active(await runtime.snapshot(), 'one');
  await runtime.executorEvent({
    type: 'failed',
    jobId,
    attempt: first.attempt,
    executionId: first.executionId!,
    reason: 'network',
  });
  assert.equal(await runtime.command(jobId, { type: 'retry' }), true);
  await runtime.schedule();
  assert.equal(active(await runtime.snapshot(), 'one').attempt, 2);
  const again = await runtime.submit({ ...spec('again'), execution: spec('one').execution });
  assert.notEqual(again.jobId, jobId);
});

test('cancellation holds its slot until the executor has actually stopped', async () => {
  const runtime = createDownloadRuntime({ store: memoryStore(), concurrency: 1 });
  const { jobId } = await runtime.submit(spec('one'));
  await runtime.submit(spec('two'));
  await runtime.schedule();
  const first = active(await runtime.snapshot(), 'one');
  await runtime.command(jobId, { type: 'cancel' });
  await runtime.schedule();
  assert.equal(active(await runtime.snapshot(), 'two').state, 'queued');
  await runtime.executorEvent({ type: 'cancelled', jobId, attempt: first.attempt, executionId: first.executionId! });
  await runtime.schedule();
  assert.equal(active(await runtime.snapshot(), 'two').state, 'starting');
});

test('persisted execution snapshots retain selected source, audio pairing and display metadata', async () => {
  const store = memoryStore();
  const runtime = createDownloadRuntime({ store, concurrency: 1 });
  const submission = {
    ...spec('snapshot'),
    execution: {
      ...spec('snapshot').execution,
      audioUrl: 'https://fixtures.test/audio.m4a',
      audioMimeType: 'audio/mp4',
      title: 'Original title',
      item: {
        id: 'media',
        kind: 'video' as const,
        url: 'https://fixtures.test/720.mp4',
        mimeType: 'video/mp4',
        title: 'Original title',
        pageUrl: 'https://example.test/watch',
        resolution: { width: 1280, height: 720 },
        variants: [{ url: 'https://fixtures.test/1080.mp4' }],
        source: 'element' as const,
        detectedAt: 1,
      },
    },
  };
  const expected = structuredClone(submission.execution);
  await runtime.submit(submission);
  submission.execution.item.title = 'Changed after submit';
  const persisted = JSON.parse(JSON.stringify(await store.read()));
  const recovered = createDownloadRuntime({ store: memoryStore(persisted), concurrency: 1 });
  assert.deepEqual((await recovered.snapshot()).jobs[0].execution, expected);
});

test('delivery resume replaces only the browser copy and rejects the old copy terminal event', async () => {
  let starts = 0;
  const runtime = createDownloadRuntime({
    store: memoryStore(),
    concurrency: 1,
    executor: {
      start: async () => {
        starts++;
      },
      cancel: async identity => {
        await runtime.executorEvent({ ...identity, type: 'cancelled' });
      },
      resumeDelivery: async () => {
        const job = (await runtime.snapshot()).jobs[0];
        await runtime.executorEvent({
          jobId: job.jobId,
          attempt: job.attempt,
          executionId: job.executionId!,
          type: 'artifact',
          downloadId: 43,
        });
      },
    },
  });
  const { jobId } = await runtime.submit(spec('delivery'));
  await runtime.schedule();
  const first = (await runtime.snapshot()).jobs[0];
  const identity = { jobId, attempt: first.attempt, executionId: first.executionId! };
  await runtime.executorEvent({ ...identity, type: 'acknowledged' });
  await runtime.executorEvent({ ...identity, type: 'artifact', downloadId: 42 });
  await runtime.command(jobId, { type: 'pause' });
  assert.equal((await runtime.snapshot()).jobs[0].state, 'paused');
  await runtime.command(jobId, { type: 'resume' });
  await runtime.schedule();
  assert.equal(starts, 1);
  assert.equal((await runtime.snapshot()).jobs[0].downloadId, 43);
  assert.equal(await runtime.browserDelivery({ jobId, downloadId: 42, state: 'interrupted' }), false);
  assert.equal(await runtime.browserDelivery({ jobId, downloadId: 43, state: 'complete' }), true);
});

test('resuming an existing artifact still waits for a concurrency slot', async () => {
  const runtime = createDownloadRuntime({ store: memoryStore(), concurrency: 1 });
  const { jobId } = await runtime.submit(spec('cached'));
  await runtime.schedule();
  const first = (await runtime.snapshot()).jobs[0];
  const identity = { jobId, attempt: first.attempt, executionId: first.executionId! };
  await runtime.executorEvent({ ...identity, type: 'acknowledged' });
  await runtime.executorEvent({ ...identity, type: 'ready' });
  await runtime.command(jobId, { type: 'pause' });
  await runtime.executorEvent({ ...identity, type: 'cancelled' });
  await runtime.submit(spec('other'));
  await runtime.schedule();
  await runtime.command(jobId, { type: 'resume' });
  await runtime.schedule();
  assert.equal(active(await runtime.snapshot(), 'cached').state, 'queued');
  const other = active(await runtime.snapshot(), 'other');
  await runtime.executorEvent({
    jobId: other.jobId,
    attempt: other.attempt,
    executionId: other.executionId!,
    type: 'failed',
    reason: 'network',
  });
  await runtime.schedule();
  const current = active(await runtime.snapshot(), 'cached');
  assert.equal(current.state, 'finalizing');
  assert.equal(current.attempt, first.attempt);
  assert.equal(current.executionId, first.executionId);
});
