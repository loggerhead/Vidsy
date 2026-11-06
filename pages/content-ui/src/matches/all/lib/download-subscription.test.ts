import { createDownloadSubscription } from './download-subscription';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaDownloadProgress } from '@extension/shared';

test('another tab updating does not publish a new snapshot', () => {
  let notify!: () => void;
  let data: Record<string, MediaDownloadProgress> = {
    a: {
      key: 'a',
      stage: 'download-video',
      downloadedBytes: 10,
      item: { id: 'a', url: '', kind: 'video', source: 'network', detectedAt: 1, tabId: 1 },
    },
  };
  const selected = createDownloadSubscription(
    {
      getSnapshot: () => data,
      subscribe: handler => {
        notify = handler;
        return () => {};
      },
    },
    1,
  );
  let renders = 0;
  const stop = selected.subscribe(() => renders++);
  const before = selected.getSnapshot();
  data = { ...data, b: { ...data.a, key: 'b', item: { ...data.a.item!, tabId: 2 } } };
  notify();
  assert.equal(selected.getSnapshot(), before);
  assert.equal(renders, 0);
  data = { ...data, a: { ...data.a, downloadedBytes: 20 } };
  notify();
  assert.equal(renders, 1);
  stop();
});
