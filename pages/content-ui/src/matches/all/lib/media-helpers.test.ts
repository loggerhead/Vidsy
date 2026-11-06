import { buildRows, describeProgress, qLabel } from './media-helpers';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaItem, MediaVariant } from '@extension/shared';

test('distinguishes high-frame-rate variants in quality options', () => {
  const variant: MediaVariant = {
    url: 'https://media.example/video-720p60.webm',
    resolution: { width: 1280, height: 720 },
    frameRate: 60,
  };
  const item: MediaItem = {
    id: 'youtube',
    url: variant.url,
    kind: 'video',
    source: 'element',
    detectedAt: 1,
    variants: [variant],
  };

  assert.equal(qLabel(variant), '720p60');
  assert.match(buildRows([item])[0].sub, /720p60/);
});

test('describes overlay download progress without falling back to idle download state', () => {
  assert.equal(describeProgress(), 'Starting');
  assert.equal(describeProgress({ stage: 'queued', downloadedBytes: 0, queuePosition: 2 }), 'Queued #2');
  assert.equal(describeProgress({ stage: 'fetch-manifest', downloadedBytes: 0 }), 'Manifest');
  assert.equal(describeProgress({ stage: 'download-video', downloadedBytes: 40, estimatedBytes: 100 }), '40%');
  assert.equal(describeProgress({ stage: 'download-video', downloadedBytes: 2 * 1024 * 1024 }), '2.0 MB');
  assert.equal(describeProgress({ stage: 'mux', downloadedBytes: 0, muxPercent: 61 }), 'Mux 61%');
  assert.equal(describeProgress({ stage: 'finalize', downloadedBytes: 0 }), 'Saving');
});

test('terminal and waiting states take precedence over a stale byte percentage', () => {
  assert.equal(describeProgress({ stage: 'failed', downloadedBytes: 96, estimatedBytes: 100 }), 'Failed');
  assert.equal(
    describeProgress({ stage: 'mux', activity: 'waiting-mux', downloadedBytes: 96, estimatedBytes: 100 }),
    'Mux queued',
  );
  assert.equal(describeProgress({ stage: 'mux', activity: 'verifying', downloadedBytes: 96 }), 'Checking');
});
