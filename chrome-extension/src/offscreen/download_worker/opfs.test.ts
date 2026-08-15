import { OpfsWritableMap } from './opfs';
import assert from 'node:assert/strict';
import test from 'node:test';

type SyncDouble = {
  write: (buffer: ArrayBufferView, options?: { at?: number }) => number;
  truncate: (newSize: number) => void;
  getSize: () => number;
  flush: () => void;
  close: () => void;
  read: () => number;
};

const installOpfsDouble = (write: SyncDouble['write']) => {
  const originalNavigator = globalThis.navigator;
  const removed: string[] = [];
  const sync: SyncDouble = {
    write,
    truncate: () => undefined,
    getSize: () => 0,
    flush: () => undefined,
    close: () => undefined,
    read: () => 0,
  };
  const handle = {
    createSyncAccessHandle: async () => sync,
    getFile: async () => new File([], 'test.bin'),
  };
  const root = {
    getFileHandle: async () => handle,
    removeEntry: async (name: string) => {
      removed.push(name);
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  });
  return {
    removed,
    restore: () => Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator }),
  };
};

test('writeAt completes partial writes and preserves random offsets', async () => {
  const positions: number[] = [];
  const opfsDouble = installOpfsDouble((buffer, options) => {
    positions.push(options?.at ?? -1);
    return Math.min(2, buffer.byteLength);
  });
  try {
    const map = new OpfsWritableMap();
    await map.open('partial.bin');
    assert.equal(map.writeAt('partial.bin', 7, new Uint8Array([1, 2, 3, 4, 5])), 5);
    assert.deepEqual(positions, [7, 9, 11]);
    assert.equal(map.size('partial.bin'), 12);
  } finally {
    opfsDouble.restore();
  }
});

test('writeAt rejects a stalled write and a quota failure without advancing size', async () => {
  const stalled = installOpfsDouble(() => 0);
  try {
    const map = new OpfsWritableMap();
    await map.open('stalled.bin');
    assert.throws(() => map.writeAt('stalled.bin', 0, new Uint8Array([1])), /write stalled/);
    assert.equal(map.size('stalled.bin'), 0);
  } finally {
    stalled.restore();
  }

  const quota = installOpfsDouble(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  try {
    const map = new OpfsWritableMap();
    await map.open('quota.bin');
    assert.throws(
      () => map.writeAt('quota.bin', 0, new Uint8Array([1])),
      (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError',
    );
    assert.equal(map.size('quota.bin'), 0);
  } finally {
    quota.restore();
  }
});
