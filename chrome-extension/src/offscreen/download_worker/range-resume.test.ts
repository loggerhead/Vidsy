import { RangeResumeRegistry } from './range-resume';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = {
  url: 'https://example.test/video',
  resourceVersion: '"v1"',
  totalBytes: 8,
  ranges: [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
  ],
};
const chunk = { i: 0, start: 0, end: 3, status: 'done' as const, downloaded: 4 };
test('resume requires matching resource identity, range layout and retained file bytes', () => {
  for (const [changed, size] of [
    [{ ...source, resourceVersion: undefined }, 4],
    [{ ...source, resourceVersion: '"v2"' }, 4],
    [{ ...source, url: 'https://other.test/video' }, 4],
    [{ ...source, totalBytes: 9 }, 4],
    [source, 0],
    [source, 3],
    [source, 99],
  ] as const) {
    const registry = new RangeResumeRegistry();
    registry.begin('file', source, 0);
    registry.completed('file', chunk);
    assert.equal(registry.begin('file', changed, size), undefined);
  }
  const registry = new RangeResumeRegistry();
  registry.begin('file', source, 0);
  registry.completed('file', chunk);
  assert.deepEqual(registry.begin('file', source, 4), [chunk]);
});
