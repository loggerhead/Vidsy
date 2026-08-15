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
