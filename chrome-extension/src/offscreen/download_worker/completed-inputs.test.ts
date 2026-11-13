import { CompletedInputRegistry } from './completed-inputs';
import { DownloadFailure } from '../lib/download-failure';
import assert from 'node:assert/strict';
import test from 'node:test';

test('processing retry reuses a complete immutable input after checking every byte', async () => {
  const registry = new CompletedInputRegistry();
  const bytes = new Uint8Array(2 * 1024 * 1024 + 1).fill(23);
  await registry.remember('file', 'source', new Blob([bytes]));
  assert.equal(await registry.reuse('file', 'source', async () => new Blob([bytes])), bytes.length);
  bytes[1024 * 1024 + 17] = 99;
  await assert.rejects(
    registry.reuse('file', 'source', async () => new Blob([bytes])),
    error => error instanceof DownloadFailure && error.kind === 'integrity',
  );
  assert.equal(registry.has('file'), false);
});

test('source change, length change and cache eviction cannot silently reuse a complete input', async () => {
  for (const variant of ['identity', 'length', 'missing']) {
    const registry = new CompletedInputRegistry();
    await registry.remember('file', 'source', new Blob(['abc']));
    await assert.rejects(
      registry.reuse('file', variant === 'identity' ? 'other' : 'source', async () => {
        if (variant === 'missing') throw new Error('NotFound');
        return new Blob([variant === 'length' ? 'abcd' : 'abc']);
      }),
      error => error instanceof DownloadFailure && error.kind === 'integrity',
    );
  }
});

test('cancel removes part and init records along with their files', async () => {
  const registry = new CompletedInputRegistry();
  for (const name of ['video.part-0', 'video.part-1', 'video.init', 'other.part-0'])
    await registry.remember(name, 'manifest', new Blob(['abc']));
  const removed: string[] = [];
  await registry.removeRelated('video', async name => {
    removed.push(name);
  });
  assert.deepEqual(removed, ['video.part-0', 'video.part-1', 'video.init']);
  assert.equal(registry.has('other.part-0'), true);
});
