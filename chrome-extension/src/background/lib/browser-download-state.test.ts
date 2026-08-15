import { browserDownloadTerminal } from './browser-download-state';
import assert from 'node:assert/strict';
import test from 'node:test';

test('browser download acceptance is not a success terminal', () => {
  assert.equal(browserDownloadTerminal('in_progress'), undefined);
});

test('browser complete is the only success terminal', () => {
  assert.deepEqual(browserDownloadTerminal('complete'), { stage: 'success' });
});

test('browser interruption produces a stable failure diagnostic', () => {
  assert.deepEqual(browserDownloadTerminal('interrupted', 'NETWORK_FAILED'), {
    stage: 'failed',
    error: 'Browser download interrupted: NETWORK_FAILED',
  });
});
