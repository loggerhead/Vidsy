import { reconcilePlayerEvidence } from './detection-evidence';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaItem } from '@extension/shared';

const item = (overrides: Partial<MediaItem>): MediaItem => ({
  id: crypto.randomUUID(),
  url: 'https://example.com/video',
  kind: 'video',
  source: 'element',
  pageUrl: 'https://example.com/watch',
  detectedAt: 1,
  ...overrides,
});

test('structured progressive variants replace the MSE placeholder without requiring a separate audio track', () => {
  const mse = item({
    id: 'mse',
    url: 'mse:https://example.com/watch',
    kind: 'mse',
    duration: 120,
  });
  const fetchable = item({
    id: 'fetchable',
    url: 'https://cdn.example/video-1080.mp4',
    duration: 120,
    variants: [
      {
        url: 'https://cdn.example/video-1080.mp4',
        resolution: { width: 1920, height: 1080 },
      },
      {
        url: 'https://cdn.example/video-720.mp4',
        resolution: { width: 1280, height: 720 },
      },
    ],
  });

  const result = reconcilePlayerEvidence([mse], fetchable);

  assert.equal(result.consumed, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, 'video');
  assert.equal(result.items[0].url, fetchable.url);
  assert.deepEqual(result.items[0].variants, fetchable.variants);
});

test('an MSE observation cannot replace an existing structured variant authority', () => {
  const authority = item({
    id: 'fetchable',
    url: 'https://cdn.example/video-1080.mp4',
    variants: [{ url: 'https://cdn.example/video-1080.mp4' }, { url: 'https://cdn.example/video-720.mp4' }],
  });
  const mse = item({
    id: 'mse',
    url: 'mse:https://example.com/watch',
    kind: 'mse',
  });

  const result = reconcilePlayerEvidence([authority], mse);

  assert.equal(result.consumed, true);
  assert.deepEqual(result.items, [authority]);
});

test('HLS children collapse into their master in either arrival order without swallowing another video', async () => {
  const { reconcileHlsPlaylistEvidence } = await import('./detection-evidence');
  const master = {
    id: 'master',
    url: 'https://cdn.example/master.m3u8',
    kind: 'hls',
    source: 'network',
    detectedAt: 1,
    hlsChildUrls: ['https://cdn.example/video.m3u8', 'https://audio.example/audio.m3u8'],
  } as MediaItem;
  const audio = { ...master, id: 'audio', url: master.hlsChildUrls![1], hlsChildUrls: undefined };
  const video = { ...audio, id: 'video', url: master.hlsChildUrls![0] };
  const unrelated = { ...audio, id: 'other', url: 'https://cdn.example/other.m3u8' };
  assert.deepEqual(reconcileHlsPlaylistEvidence([audio, video, unrelated], master).items, [unrelated]);
  assert.equal(reconcileHlsPlaylistEvidence([master, unrelated], audio).consumed, true);
  assert.equal(reconcileHlsPlaylistEvidence([master, unrelated], video).consumed, true);
  assert.equal(reconcileHlsPlaylistEvidence([master], unrelated).consumed, false);
});
