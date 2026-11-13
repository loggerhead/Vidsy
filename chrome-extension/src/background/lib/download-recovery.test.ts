import { AUTO_RECOVERY_DELAYS_MS } from './download-recovery';
import { createDownloadRuntime } from './download-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DownloadRuntimeStore } from './download-runtime';

const setup = async () => {
  let now = 1_000;
  let state: Awaited<ReturnType<DownloadRuntimeStore['read']>>;
  const store: DownloadRuntimeStore = {
    read: async () => state,
    write: async value => {
      state = value;
    },
  };
  const make = () => createDownloadRuntime({ store, now: () => now, concurrency: 1 });
  let runtime = make();
  const { jobId } = await runtime.submit({
    requestId: 'recover',
    execution: { url: 'https://fixture.test/video.mp4', kind: 'video', outputFormat: 'mp4' },
  });
  await runtime.schedule();
  const job = async () => (await runtime.snapshot()).jobs[0];
  const fail = async (recoverable = true) => {
    const current = await job();
    await runtime.executorEvent({
      jobId,
      attempt: current.attempt,
      executionId: current.executionId!,
      type: 'failed',
      reason: 'connection reset',
      recoverable,
    });
  };
  return {
    get runtime() {
      return runtime;
    },
    jobId,
    job,
    fail,
    advance: (ms: number) => {
      now += ms;
    },
    recreate: () => {
      runtime = make();
    },
  };
};

test('automatic recovery persists paused bytes and deadline across worker suspension and resumes after wake', async () => {
  const f = await setup();
  let job = await f.job();
  await f.runtime.executorEvent({
    jobId: job.jobId,
    attempt: job.attempt,
    executionId: job.executionId!,
    type: 'acknowledged',
  });
  await f.runtime.executorEvent({
    jobId: job.jobId,
    attempt: job.attempt,
    executionId: job.executionId!,
    type: 'progress',
    downloadedBytes: 500,
    estimatedBytes: 1000,
    phase: 'fetching',
  });
  await f.fail();
  job = await f.job();
  assert.equal(job.state, 'paused');
  assert.equal(job.progress.downloadedBytes, 500);
  assert.equal(await f.runtime.command(job.jobId, { type: 'recovery-check', online: true }), false);
  f.recreate();
  f.advance(60_000); // The machine slept past its alarm; an overdue alarm must still recover.
  assert.equal(await f.runtime.command(job.jobId, { type: 'recovery-check', online: true }), true);
  await f.runtime.schedule();
  assert.equal((await f.job()).state, 'starting');
  assert.equal((await f.job()).progress.downloadedBytes, 500);
  assert.equal((await f.job()).recovery?.attempts, 1);
});

test('automatic failures exhaust five increasing delays without losing checkpoints; manual Retry resets the budget', async () => {
  const f = await setup();
  for (let attempt = 0; attempt < AUTO_RECOVERY_DELAYS_MS.length; attempt++) {
    await f.fail();
    const job = await f.job();
    assert.equal(job.state, 'paused');
    assert.equal(job.recovery?.attempts, attempt);
    f.advance(AUTO_RECOVERY_DELAYS_MS[attempt]);
    await f.runtime.command(job.jobId, { type: 'recovery-check', online: true });
    await f.runtime.schedule();
  }
  await f.fail();
  assert.equal((await f.job()).state, 'failed');
  assert.match((await f.job()).terminal!.reason!, /exhausted.*cached progress/);
  assert.equal(await f.runtime.command(f.jobId, { type: 'recovery-check', online: true, immediate: true }), false);
  await f.runtime.command(f.jobId, { type: 'retry' });
  await f.runtime.schedule();
  await f.fail();
  assert.equal((await f.job()).recovery?.attempts, 0);
});

test('user pause and cancel fence automatic and stale recovery; offline checks cannot retry forever', async () => {
  for (const intent of ['pause', 'cancel'] as const) {
    const f = await setup();
    await f.fail();
    await f.runtime.command(f.jobId, { type: intent });
    f.advance(1_000_000);
    assert.equal(await f.runtime.command(f.jobId, { type: 'recovery-check', online: true, immediate: true }), false);
    assert.equal((await f.job()).state, intent === 'pause' ? 'paused' : 'cancelled');
    assert.equal((await f.job()).recovery, undefined);
  }
  const f = await setup();
  await f.fail();
  for (const delay of AUTO_RECOVERY_DELAYS_MS) {
    f.advance(delay);
    await f.runtime.command(f.jobId, { type: 'recovery-check', online: false });
  }
  assert.equal((await f.job()).state, 'failed');
  assert.equal((await f.job()).attempt, 1); // No executor is started while offline.
});

test('nontransient failures remain manual and a failure after user cancellation cannot revive the task', async () => {
  const f = await setup();
  await f.fail(false);
  assert.equal((await f.job()).state, 'failed');
  assert.equal((await f.job()).recovery, undefined);
  const cancelled = await setup();
  await cancelled.runtime.command(cancelled.jobId, { type: 'cancel' });
  await cancelled.fail();
  assert.equal((await cancelled.job()).state, 'cancelled');
});

test('going offline during the final automatic attempt remains exhausted after stop or executor restart', async () => {
  for (const mode of ['stopped', 'restarted']) {
    const f = await setup();
    for (const delay of AUTO_RECOVERY_DELAYS_MS) {
      await f.fail();
      f.advance(delay);
      await f.runtime.command(f.jobId, { type: 'recovery-check', online: true });
      await f.runtime.schedule();
    }
    await f.runtime.command(f.jobId, { type: 'pause', automatic: true });
    const job = await f.job();
    if (mode === 'stopped') {
      await f.runtime.executorEvent({
        jobId: job.jobId,
        attempt: job.attempt,
        executionId: job.executionId!,
        type: 'cancelled',
      });
    } else {
      f.recreate();
      await f.runtime.bootstrap({ executions: [] });
      await f.runtime.command(f.jobId, { type: 'recovery-check', online: true, immediate: true });
    }
    assert.equal((await f.job()).state, 'failed');
    assert.equal((await f.job()).recovery, undefined);
    assert.match((await f.job()).terminal!.reason!, /exhausted.*retained/);
  }
});
