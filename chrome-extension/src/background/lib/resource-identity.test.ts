import { resourceLocator } from './resource-identity';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DownloadExecutionSpec } from './download-runtime';

test('resource matching ignores display choices and header order but isolates accounts, tracks and formats', async () => {
  const source: DownloadExecutionSpec = {
    url: 'https://fixture/video',
    kind: 'video',
    outputFormat: 'mp4',
    headers: { Authorization: 'account-a', Referer: 'https://fixture' },
  };
  const identity = await resourceLocator(source);
  assert.equal(
    await resourceLocator({
      ...source,
      title: 'another title',
      fileName: 'another filename',
      headers: { Referer: 'https://fixture', Authorization: 'account-a' },
    }),
    identity,
  );
  for (const other of [
    { headers: { Authorization: 'account-b' } },
    { outputFormat: 'mp3' as const },
    { audioUrl: 'https://fixture/audio' },
  ])
    assert.notEqual(await resourceLocator({ ...source, ...other }), identity);
});
