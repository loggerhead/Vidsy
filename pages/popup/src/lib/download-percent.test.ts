import { downloadPercent } from './download-percent';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaDownloadProgress } from '@extension/shared';

const entry: MediaDownloadProgress = {
  key: 'task',
  stage: 'download-video',
  downloadedBytes: 100,
  estimatedBytes: 100,
};

test('byte completion is not processing completion', () => {
  assert.equal(downloadPercent(entry), 100);
  assert.equal(downloadPercent({ ...entry, stage: 'mux' }), null);
  assert.equal(downloadPercent({ ...entry, stage: 'mux', muxPercent: 40 }), 40);
  assert.equal(downloadPercent({ ...entry, stage: 'mux', muxPercent: 100 }), 99);
  assert.equal(downloadPercent({ ...entry, stage: 'finalize', muxPercent: 100 }), null);
  assert.equal(downloadPercent({ ...entry, stage: 'success' }), 100);
});

test('waiting, validation and failure do not show a stale percentage', () => {
  for (const activity of ['waiting-mux', 'verifying'] as const)
    assert.equal(downloadPercent({ ...entry, stage: 'mux', activity, muxPercent: 99 }), null);
  assert.equal(downloadPercent({ ...entry, stage: 'failed' }), null);
  assert.equal(downloadPercent({ ...entry, stage: 'mux', muxPercent: NaN }), null);
});
