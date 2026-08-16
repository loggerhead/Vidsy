import { configureSessionAccessLevel } from './base.js';
import assert from 'node:assert/strict';
import test from 'node:test';

test('configureSessionAccessLevel delegates session access configuration to the extension context', async () => {
  const calls: unknown[] = [];
  await configureSessionAccessLevel({
    setAccessLevel: async (options: Parameters<chrome.storage.StorageArea['setAccessLevel']>[0]) => {
      calls.push(options);
    },
  });

  assert.deepEqual(calls, [{ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }]);
});
