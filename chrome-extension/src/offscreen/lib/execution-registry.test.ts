import { createExecutionRegistry } from './execution-registry';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionOutput } from './execution-registry';
import type { ExecutorCommand } from '../../background/lib/download-runtime';

const command: ExecutorCommand = {
  jobId: 'job-1',
  requestId: 'request-1',
  executionId: 'execution-1',
  attempt: 1,
  execution: { url: 'https://example.test/video', kind: 'video', outputFormat: 'mp4' },
  display: {},
};
const output: ExecutionOutput = {
  blobUrl: 'blob:fixture',
  artifact: {
    opfsName: 'out.mp4',
    size: 16,
    container: 'mp4',
    extension: '.mp4',
    mime: 'video/mp4',
    tracks: [],
    planType: 'copy-to-mp4',
  },
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('offscreen inventory fences replays and retains results when the background is unavailable', async () => {
  let starts = 0;
  let complete!: (output: ExecutionOutput) => void;
  const registry = createExecutionRegistry({
    execute: async () => {
      starts++;
      return new Promise(resolve => {
        complete = resolve;
      });
    },
    stop: async () => {},
    publish: async () => {
      throw new Error('Background suspended');
    },
  });
  registry.start(command);
  registry.start(command);
  await settle();
  assert.equal(starts, 1);
  assert.equal(registry.inventory()[0].report.type, 'acknowledged');
  assert.throws(() => registry.start({ ...command, executionId: 'duplicate-attempt' }), /already exists/);
  complete(output);
  await settle();
  assert.deepEqual(registry.inventory()[0].report, { command, type: 'output', output });
  registry.forget(command.executionId);
  registry.start({ ...command, attempt: 2, executionId: 'execution-2' });
  await settle();
  assert.equal(starts, 2);
});

test('cancel intent survives a stop before asynchronous execution starts', async () => {
  let starts = 0;
  const registry = createExecutionRegistry({
    execute: async () => {
      starts++;
      return output;
    },
    stop: async () => {},
    publish: async () => {},
  });
  registry.start(command);
  await registry.stop(command.executionId, 'pause');
  await settle();
  assert.equal(starts, 0);
  assert.equal(registry.inventory()[0].report.type, 'cancelled');
  registry.progress(command.requestId, { stage: 'download-video', downloadedBytes: 100 });
  assert.equal(registry.inventory()[0].report.type, 'cancelled');
});

test('retries an unacknowledged terminal report without re-executing the download', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let executions = 0,
    terminalAttempts = 0;
  const registry = createExecutionRegistry({
    execute: async () => {
      executions++;
      return output;
    },
    stop: async () => {},
    publish: async report => {
      if (report.type === 'output' && ++terminalAttempts === 1) throw new Error('Background unavailable');
    },
  });
  registry.start(command);
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  await drain();
  t.mock.timers.tick(0);
  await drain();
  assert.equal(terminalAttempts, 1);
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(terminalAttempts, 2);
  assert.equal(executions, 1);
  registry.forget(command.executionId);
});
