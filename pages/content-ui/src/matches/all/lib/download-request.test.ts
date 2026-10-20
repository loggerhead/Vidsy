import { buildDownloadMessage } from './download-request';
import { buildRows } from './media-helpers';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaItem, MediaVariant } from '@extension/shared';

test('preserves the selected adaptive variant when the content overlay starts a download', () => {
  const variant: MediaVariant = {
    url: 'https://media.example/video-720p60.webm',
    mimeType: 'video/webm; codecs="vp9"',
    resolution: { width: 1280, height: 720 },
    frameRate: 60,
    audioUrl: 'https://media.example/audio-opus.webm',
    audioMimeType: 'audio/webm; codecs="opus"',
  };
  const item: MediaItem = {
    id: 'youtube',
    url: 'https://media.example/progressive-720.mp4',
    kind: 'video',
    title: 'Example',
    source: 'element',
    detectedAt: 1,
    variants: [variant],
  };

  const selectedOption = buildRows([item])[0];

  const message = buildDownloadMessage(selectedOption.item, selectedOption.variant, 42, true);
  assert.notEqual(message.payload.key, item.id);
  assert.notEqual(message.payload.key, buildDownloadMessage(item, variant, 42, true).payload.key);
  assert.deepEqual(message, {
    type: 'media/download',
    payload: {
      url: 'https://media.example/video-720p60.webm',
      key: message.payload.key,
      kind: 'video',
      fileName: undefined,
      title: 'Example',
      tabId: 42,
      outputFormat: 'mp4',
      audioUrl: 'https://media.example/audio-opus.webm',
      audioMimeType: 'audio/webm; codecs="opus"',
      item: { ...item, url: variant.url, mimeType: variant.mimeType, resolution: variant.resolution },
    },
  });
});
