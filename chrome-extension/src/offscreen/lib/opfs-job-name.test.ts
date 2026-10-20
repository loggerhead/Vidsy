import { opfsJobName } from './opfs-job-name';
import assert from 'node:assert/strict';
import test from 'node:test';

test('resumable OPFS names are stable, bounded and do not alias punctuation in request IDs', async () => {
  const name = await opfsJobName('http', 'a/b', 'in', '.bin');
  assert.equal(name, await opfsJobName('http', 'a/b', 'in', 'bin'));
  assert.notEqual(name, await opfsJobName('http', 'a?b', 'in', 'bin'));
  assert.equal(
    (await opfsJobName('http', 'https://source.test/' + 'x'.repeat(10000), 'in', 'bin')).length,
    name.length,
  );
});
