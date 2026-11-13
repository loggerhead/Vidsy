import { createLocalDownloadStore, migrateDownloadRuntime } from './download-persistence';
import assert from 'node:assert/strict';
import test from 'node:test';

const area = (data: Record<string, unknown>) => ({
  get: async (key: string) => ({ [key]: data[key] }),
  set: async (values: Record<string, unknown>) => {
    Object.assign(data, values);
  },
  remove: async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
  },
});
test('session task/progress migration persists once and never resurrects cleared session state', async () => {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {
    'vidsy-download-runtime': {
      schemaVersion: 1,
      nextJobNumber: 2,
      nextQueueOrder: 2,
      jobs: { one: { jobId: 'one', requestId: 'request', execution: { url: 'https://fixture/video' }, updatedAt: 1 } },
    },
    'media-downloads': { request: { downloadedBytes: 4, stage: 'paused' } },
  };
  const store = createLocalDownloadStore(area(local), area(session));
  const migrated = await store.read();
  assert.equal(migrated?.schemaVersion, 2);
  assert.equal(migrated?.jobs.one.requestId, 'request');
  assert.deepEqual(local['media-downloads'], { request: { downloadedBytes: 4, stage: 'paused' } });
  assert.deepEqual(session, {});
  const recreated = createLocalDownloadStore(area(local), area(session));
  assert.deepEqual(await recreated.read(), migrated);
  assert.throws(() => migrateDownloadRuntime({ schemaVersion: 99, jobs: {} }), /schema/);
});
