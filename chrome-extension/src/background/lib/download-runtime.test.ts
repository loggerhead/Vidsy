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
