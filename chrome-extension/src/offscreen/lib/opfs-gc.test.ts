import { purgeOpfsOrphans } from './opfs-gc';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CacheRecord } from './cache-protocol';

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

test('expired output files are collected while shared immutable inputs retain their original lease', async () => {
  const originalNavigator = globalThis.navigator;
  const removed: string[] = [],
    expired: string[] = [],
    invalidated: string[] = [];
  const root = {
    async *keys() {
      yield 'output';
      yield 'shared';
    },
    removeEntry: async (name: string) => {
      removed.push(name);
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  });
  const record = (name: string): CacheRecord => ({
    schemaVersion: 1,
    name,
    jobKey: 'job',
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 7 * 86400000,
    size: 3,
    artifact: {
      metadata: {
        opfsName: name,
        size: 3,
        container: 'mp4',
        extension: '.mp4',
        mime: 'video/mp4',
        tracks: [],
        planType: 'passthrough',
      },
      checksums: { source: 'source', size: 3, hashes: ['a'.repeat(64)] },
      expiresAt: 86400000,
    },
  });
  const shared = record('shared');
  shared.complete = { source: 'input', size: 3, hashes: ['b'.repeat(64)] };
  try {
    await purgeOpfsOrphans({
      records: [record('output'), shared],
      liveJobs: new Set(['job']),
      now: 86400001,
      removeRecord: async () => {},
      removeArtifact: async record => {
        expired.push(record.name);
      },
      invalidated: async (_key, reason) => {
        invalidated.push(reason);
      },
    });
    assert.deepEqual(removed, ['output']);
    assert.deepEqual(expired, ['shared']);
    assert.equal(invalidated.length, 2);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  }
});
