import { applyPresentationMetadata, reconcilePlayerEvidence, selectRicherVariants } from './detection-evidence';
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

test('unresolved MSE metadata cannot become fetchable presentation metadata', () => {
  const mse = item({
    id: 'mse',
    url: 'mse:https://example.com/feed',
    kind: 'mse',
    thumbnail: 'data:image/jpeg;base64,unresolved-player',
    duration: 158,
  });
  const fetchable = item({
    id: 'fetchable',
    url: 'https://cdn.example/video.mp4',
    duration: 158,
    variants: [{ url: 'https://cdn.example/video.mp4' }],
  });

  const result = reconcilePlayerEvidence([mse], fetchable);

  assert.equal(result.items[0].thumbnail, undefined);
  assert.equal(result.items[0].duration, 158);
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

test('fetchable evidence does not guess between multiple MSE players on one page', () => {
  const first = item({ id: 'mse-1', url: 'mse:https://example.com/feed#vidsy-player=1', kind: 'mse' });
  const second = item({ id: 'mse-2', url: 'mse:https://example.com/feed#vidsy-player=2', kind: 'mse' });
  const fetchable = item({
    id: 'fetchable',
    url: 'https://cdn.example/video.mp4',
    variants: [{ url: 'https://cdn.example/video.mp4' }],
  });

  const result = reconcilePlayerEvidence([first, second], fetchable);

  assert.equal(result.consumed, false);
  assert.deepEqual(result.items, [first, second]);
});

test('presentation metadata updates only the explicitly resolved media item', () => {
  const first = item({ id: 'first', thumbnail: 'data:image/jpeg;base64,old-first' });
  const second = item({ id: 'second', thumbnail: 'data:image/jpeg;base64,old-second' });

  const updated = applyPresentationMetadata([first, second], 'second', {
    thumbnail: 'data:image/jpeg;base64,current-poster',
    duration: 158,
  });

  assert.equal(updated?.[0], first);
  assert.equal(updated?.[0].thumbnail, 'data:image/jpeg;base64,old-first');
  assert.equal(updated?.[1].thumbnail, 'data:image/jpeg;base64,current-poster');
  assert.equal(updated?.[1].duration, 158);
});

test('presentation metadata never guesses when the resolved media item is absent', () => {
  const first = item({ id: 'first' });
  const second = item({ id: 'second' });

  assert.equal(
    applyPresentationMetadata([first, second], 'missing', { thumbnail: 'data:image/jpeg;base64,poster' }),
    undefined,
  );
});

test('an unavailable authoritative poster clears stale thumbnail evidence', () => {
  const media = item({ id: 'target', thumbnail: 'data:image/jpeg;base64,stale' });

  const updated = applyPresentationMetadata([media], 'target', { thumbnail: null });

  assert.equal(updated?.[0].thumbnail, undefined);
});

test('progressive fMP4 evidence grows the variant set without regressing on stale observations', () => {
  const first = [{ url: 'https://cdn.example/video-1080.m4s' }];
  const complete = [...first, { url: 'https://cdn.example/video-720.m4s' }];

  assert.equal(selectRicherVariants(first, complete), complete);
  assert.equal(selectRicherVariants(complete, first), complete);
  assert.equal(selectRicherVariants(complete, undefined), complete);
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
