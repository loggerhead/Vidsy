import { buildRows, qLabel } from './media-helpers';
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
