import { describeDownloadDetails } from './download-details';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaDownloadProgress } from '@extension/shared';

const failed = (error?: string): MediaDownloadProgress => ({
  key: 'task',
  stage: 'failed',
  downloadedBytes: 96,
  estimatedBytes: 100,
  error,
});

test('failure details classify permission, network, processing, storage and saving errors', () => {
  for (const [error, category] of [
    ['Failed to fetch HLS playlist: 403', 'Permission denied (403)'],
    ['Failed to fetch', 'Network problem'],
    ['Failed to fetch HLS playlist: 503', 'Server response'],
    ['Browser download interrupted: NETWORK_FAILED', 'Network problem'],
    ['Media processing stalled: no output for 120 seconds', 'Video processing'],
    ['Output artifact is missing required audio track aac', 'Video processing'],
    ['Insufficient temporary storage', 'Storage problem'],
    ['Browser download interrupted: FILE_FAILED', 'Saving problem'],
  ]) {
    const details = describeDownloadDetails(failed(error));
    assert.ok(details.title.includes(category), details.title);
    assert.equal(details.error, error);
  }
});

test('keeps unknown and missing errors honest and redacts credentials in error URLs', () => {
  assert.equal(describeDownloadDetails(failed('Unexpected failure')).title, 'Failed');
  assert.match(describeDownloadDetails(failed()).description, /no error details/);
  const details = describeDownloadDetails(failed('Failed to fetch https://cdn.test/403?token=secret#private'));
  assert.match(details.title, /Network problem/);
  assert.equal(details.error, 'Failed to fetch https://cdn.test/403');
});

test('waiting and verification describe actual activity, while terminal states win', () => {
  const progress: MediaDownloadProgress = { key: 'task', stage: 'mux', downloadedBytes: 96, activity: 'waiting-mux' };
  assert.equal(describeDownloadDetails(progress).title, 'Waiting to merge');
  assert.equal(describeDownloadDetails({ ...progress, activity: 'verifying' }).title, 'Checking video');
  assert.equal(describeDownloadDetails({ ...progress, stage: 'success' }).title, 'Download complete');
  assert.equal(describeDownloadDetails(null).title, 'Ready to download');
});
