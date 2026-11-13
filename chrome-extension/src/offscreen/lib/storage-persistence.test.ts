import { requestPersistentCacheStorage } from './storage-persistence';
import assert from 'node:assert/strict';
import test from 'node:test';

test('cache explicitly requests persistent storage and reports a browser refusal without blocking downloads', async () => {
  let requests = 0;
  const result = await requestPersistentCacheStorage({
    persisted: async () => false,
    persist: async () => {
      requests++;
      return false;
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(result, { supported: true, persisted: false });
  assert.deepEqual(
    await requestPersistentCacheStorage({
      persisted: async () => true,
      persist: async () => {
        throw new Error('already granted');
      },
    }),
    { supported: true, persisted: true },
  );
});
