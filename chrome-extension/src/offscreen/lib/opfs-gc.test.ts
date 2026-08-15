import { purgeOpfsOrphans } from './opfs-gc';
import assert from 'node:assert/strict';
import test from 'node:test';

test('startup GC recovers outputs whose cleanup message was lost', async () => {
  const originalNavigator = globalThis.navigator;
  const removed: string[] = [];
  const root = {
    async *keys() {
      yield 'lost-input.ts';
      yield 'lost-output.mp4';
    },
    removeEntry: async (name: string) => {
      removed.push(name);
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  });

  try {
    assert.deepEqual(await purgeOpfsOrphans(), { removed: 2, failed: 0 });
    assert.deepEqual(removed, ['lost-input.ts', 'lost-output.mp4']);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  }
});
