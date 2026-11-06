import { BufferedWriter } from './buffered-writer';
import assert from 'node:assert/strict';
import test from 'node:test';

test('coalesces small chunks, flushes seeks and preserves overwritten bytes', () => {
  const file = new Uint8Array(32);
  const writes: number[] = [];
  const writer = new BufferedWriter((position, bytes) => {
    writes.push(position);
    file.set(bytes, position);
  }, 8);
  for (let i = 0; i < 10; i++) writer.writeAt(i, new Uint8Array([i + 1]));
  writer.writeAt(2, new Uint8Array([99, 100]));
  writer.flush();
  assert.deepEqual(writes, [0, 8, 2]);
  assert.deepEqual([...file.slice(0, 10)], [1, 2, 99, 100, 5, 6, 7, 8, 9, 10]);
});

test('discard prevents a cancelled partial range from becoming durable', () => {
  let writes = 0;
  const writer = new BufferedWriter(() => writes++, 8);
  writer.writeAt(0, new Uint8Array([1, 2]));
  writer.discard();
  writer.flush();
  assert.equal(writes, 0);
});
