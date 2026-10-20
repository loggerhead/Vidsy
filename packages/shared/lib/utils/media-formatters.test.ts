import { buildFilenameContext, qualityLabel } from './media-formatters.js';
import assert from 'node:assert/strict';
import test from 'node:test';

test('quality labels map cropped delivery dimensions to the conventional rendition tier', () => {
  assert.equal(qualityLabel({ width: 1920, height: 1018 }), '1080p');
  assert.equal(qualityLabel({ width: 1018, height: 1920 }), '1080p');
  assert.equal(qualityLabel({ width: 854, height: 452 }), '480p');
  assert.equal(qualityLabel({ width: 1920, height: 1080 }), '1080p');
});

test('filename resolution uses the selected source instead of the highest available variant', () => {
  const context = buildFilenameContext({
    title: 'Selected',
    kind: 'video',
    url: 'https://example.test/720.mp4',
    resolution: { width: 1280, height: 720 },
    variants: [{ url: 'https://example.test/1080.mp4', resolution: { width: 1920, height: 1080 } }],
  });
  assert.equal(context.resolution, '720p');
});
