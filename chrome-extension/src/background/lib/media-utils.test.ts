import { deriveKind } from './media-utils';
import assert from 'node:assert/strict';
import test from 'node:test';

test('deriveKind recognises query-string video MIME hints', () => {
  assert.equal(deriveKind('https://example.com/videoplayback?mime=video%2Fmp4&itag=137'), 'video');
});

test('deriveKind recognises query-string audio MIME hints', () => {
  assert.equal(deriveKind('https://example.com/videoplayback?mime=audio%2Fmp4&itag=140'), 'audio');
});
