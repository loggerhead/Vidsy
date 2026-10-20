import assert from 'node:assert/strict';
import test from 'node:test';

const data: Record<string, unknown> = {};
const listeners: Array<(changes: object) => void> = [];
const area = {
  get: async (keys: string | string[]) =>
    Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])),
  set: async (values: Record<string, unknown>) => {
    await new Promise(resolve => setTimeout(resolve, 1));
    Object.assign(data, structuredClone(values));
    for (const listener of listeners)
      listener(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])));
  },
  onChanged: { addListener: (listener: (changes: object) => void) => listeners.push(listener) },
};
Object.assign(globalThis, { chrome: { storage: { local: area, session: area } } });
const { updateProgress, clearTerminalProgress } = await import('./progress');
const { mediaDownloadsStorage } = await import('@extension/storage');

test('concurrent progress, terminal and clear operations preserve unrelated tasks', async () => {
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => updateProgress(`job-${i}`, { stage: 'download-video', downloadedBytes: i })),
  );
  assert.equal(Object.keys(await mediaDownloadsStorage.get()).length, 12);
  await updateProgress('job-0', { stage: 'success', downloadedBytes: 10 });
  await Promise.all([
    updateProgress('job-0', { stage: 'download-video', downloadedBytes: 1 }),
    clearTerminalProgress(['job-0']),
    updateProgress('job-1', { stage: 'success', downloadedBytes: 20 }),
  ]);
  const current = await mediaDownloadsStorage.get();
  assert.equal(current['job-0'], undefined);
  assert.equal(current['job-1'].stage, 'success');
  assert.equal(Object.keys(current).length, 11);
});

test('late projections cannot regress a newer revision or recreate a cleared record', async () => {
  await updateProgress('versioned', { stage: 'download-video', downloadedBytes: 20 }, { revision: 20 });
  await updateProgress('versioned', { stage: 'queued', downloadedBytes: 0 }, { revision: 10 });
  assert.equal((await mediaDownloadsStorage.get()).versioned.stage, 'download-video');
  await updateProgress('versioned', { stage: 'success', downloadedBytes: 20 }, { revision: 30 });
  await clearTerminalProgress(['versioned']);
  await updateProgress('versioned', { stage: 'success', downloadedBytes: 20 }, { revision: 30 });
  assert.equal((await mediaDownloadsStorage.get()).versioned, undefined);
});

test('clear reads persisted state even if an old storage event regresses the local cache', async () => {
  await updateProgress('keep', { stage: 'download-video', downloadedBytes: 1 });
  await updateProgress('remove', { stage: 'success', downloadedBytes: 2 });
  for (const listener of listeners) listener({ 'media-downloads': { newValue: {} } });
  await new Promise(resolve => setTimeout(resolve, 0));
  await clearTerminalProgress(['remove']);
  const current = await mediaDownloadsStorage.get();
  assert.equal(current.remove, undefined);
  assert.equal(current.keep.downloadedBytes, 1);
});
