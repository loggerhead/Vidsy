import { createProgressPublisher } from './progress-publisher';
import assert from 'node:assert/strict';
import test from 'node:test';

test('coalesces byte reports and flushes them before terminal delivery', async () => {
  const received: number[] = [];
  const publisher = createProgressPublisher<number>(async value => {
    received.push(value);
  }, 1000);
  await publisher.publish('job', 'download', 1);
  const a = publisher.publish('job', 'download', 2);
  const b = publisher.publish('job', 'download', 3);
  await publisher.publish('job', 'failed', 4, true);
  await Promise.all([a, b]);
  assert.deepEqual(received, [1, 3, 4]);
});
