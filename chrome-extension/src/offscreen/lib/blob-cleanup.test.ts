import { cleanupBlob, registerOutputForCleanup } from './blob-cleanup';
import assert from 'node:assert/strict';
import test from 'node:test';

test('delayed cleanup removes an output exactly once and duplicate messages are harmless', async () => {
  const blobUrl = 'blob:fixture/delayed';
  const revoked: string[] = [];
  const removed: string[] = [];
  const dependencies = {
    revokeObjectUrl: (url: string) => revoked.push(url),
    removeOutput: async (name: string) => {
      removed.push(name);
    },
  };
  registerOutputForCleanup(blobUrl, 'output.mp4');

  await cleanupBlob(blobUrl, dependencies);
  await cleanupBlob(blobUrl, dependencies);

  assert.deepEqual(revoked, [blobUrl]);
  assert.deepEqual(removed, ['output.mp4']);
});

test('native interruption revokes the old blob while retaining the verified file', async () => {
  let removed = 0;
  const revoked: string[] = [];
  registerOutputForCleanup('blob:interrupted', 'saved.mp4');
  await cleanupBlob('blob:interrupted', {
    preserveOutput: true,
    revokeObjectUrl: url => revoked.push(url),
    removeOutput: async () => {
      removed++;
    },
  });
  assert.deepEqual(revoked, ['blob:interrupted']);
  assert.equal(removed, 0);
});
