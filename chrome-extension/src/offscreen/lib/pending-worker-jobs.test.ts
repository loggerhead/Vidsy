import { rejectPendingWorkerJobs } from './pending-worker-jobs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('worker termination rejects and clears every pending RPC category', () => {
  const rejected: string[] = [];
  const pendingFetch = new Map([
    ['fetch-a', { reject: (error: Error) => rejected.push(`fetch-a:${error.message}`) }],
    ['fetch-b', { reject: (error: Error) => rejected.push(`fetch-b:${error.message}`) }],
  ]);
  const pendingFile = new Map([['file', { reject: (error: Error) => rejected.push(`file:${error.message}`) }]]);
  const pendingMux = new Map([['mux', { reject: (error: Error) => rejected.push(`mux:${error.message}`) }]]);

  rejectPendingWorkerJobs(new Error('Download worker terminated unexpectedly'), [
    pendingFetch,
    pendingFile,
    pendingMux,
  ]);

  assert.deepEqual(rejected.sort(), [
    'fetch-a:Download worker terminated unexpectedly',
    'fetch-b:Download worker terminated unexpectedly',
    'file:Download worker terminated unexpectedly',
    'mux:Download worker terminated unexpectedly',
  ]);
  assert.equal(pendingFetch.size, 0);
  assert.equal(pendingFile.size, 0);
  assert.equal(pendingMux.size, 0);
});
