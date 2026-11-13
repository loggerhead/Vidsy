import { selectRenewedUrl, renewalChanged, isExpiredSourceFailure, selectSourceTab } from './source-renewal';
import { LiveSnapshotFailure } from '../../offscreen/lib/download-failure';
import assert from 'node:assert/strict';
import test from 'node:test';

test('source-page binding survives changed tab IDs and never guesses between duplicate or different page URLs', () => {
  const url = 'https://site.test/watch?id=original';
  assert.equal(
    selectSourceTab(99, url, [
      { id: 1, url: 'chrome://newtab' },
      { id: 2, url },
    ]),
    2,
  );
  assert.equal(
    selectSourceTab(99, url, [
      { id: 2, url },
      { id: 3, url },
    ]),
    undefined,
  );
  assert.equal(selectSourceTab(2, url, [{ id: 2, url: 'https://site.test/watch?id=other' }]), undefined);
});

test('renewal selects one same-path player candidate and rejects ambiguous or unrelated media', () => {
  const old = 'https://media.test/video.mp4?token=old';
  const fresh = 'https://media.test/video.mp4?token=new';
  assert.equal(selectRenewedUrl(old, [old, fresh, fresh, 'https://other.test/video.mp4']), fresh);
  assert.equal(selectRenewedUrl(old, [fresh, 'https://media.test/video.mp4?token=third']), undefined);
  assert.equal(selectRenewedUrl(old, ['https://media.test/other.mp4', 'blob:abc']), undefined);
});

test('renewal detects changed headers and only triggers for expired source status', () => {
  const url = 'https://media.test/video.mp4';
  assert.equal(renewalChanged(url, { Authorization: 'old' }, url, { authorization: 'new' }), true);
  assert.equal(renewalChanged(url, { Authorization: 'same' }, url, { authorization: 'same' }), false);
  assert.equal(isExpiredSourceFailure(new Error('HTTP 403: https://media.test/video.mp4')), true);
  assert.equal(isExpiredSourceFailure(new Error('HTTP 410: https://media.test/video.mp4')), true);
  assert.equal(isExpiredSourceFailure(new Error('HTTP 500: https://media.test/video.mp4')), false);
  assert.equal(
    isExpiredSourceFailure(new Error('Failed to fetch HLS playlist: 403. Refresh the video page and retry.')),
    true,
  );
  assert.equal(isExpiredSourceFailure(new LiveSnapshotFailure(new Error('HTTP 403: https://media.test/live'))), false);
});
