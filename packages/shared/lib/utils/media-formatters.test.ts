import { qualityLabel } from './media-formatters.js';
import assert from 'node:assert/strict';
import test from 'node:test';

test('quality labels map cropped delivery dimensions to the conventional rendition tier', () => {
  assert.equal(qualityLabel({ width: 1920, height: 1018 }), '1080p');
  assert.equal(qualityLabel({ width: 1018, height: 1920 }), '1080p');
  assert.equal(qualityLabel({ width: 854, height: 452 }), '480p');
  assert.equal(qualityLabel({ width: 1920, height: 1080 }), '1080p');
});
