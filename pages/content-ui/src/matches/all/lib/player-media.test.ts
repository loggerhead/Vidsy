import { buildDownloadMessage } from './download-request';
import { buildRows } from './media-helpers';
import { resolvePlayerMedia, selectVisiblePlayer } from './player-media';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaItem } from '@extension/shared';

const pageUrl = 'https://x.com/example';
const item = (id: string): MediaItem => ({
  id,
  kind: 'hls',
  source: 'network',
  pageUrl,
  detectedAt: 1,
  url: `https://video.twimg.com/amplify_video/${id}/pl/master.m3u8`,
  variants: [1080, 720, 360].map(height => ({
    url: `https://video.twimg.com/amplify_video/${id}/pl/${height}.m3u8`,
    resolution: { width: (height * 16) / 9, height },
    audioUrl: `https://video.twimg.com/amplify_video/${id}/audio.m3u8`,
  })),
});
const evidence = (id: string) => ({
  sourceUrls: ['blob:https://x.com/local'],
  posterUrl: `https://pbs.twimg.com/amplify_video_thumb/${id}/img/poster.jpg`,
  pageUrl,
  playerCount: 3,
});

test('multiple videos with identical qualities yield only the current asset and its audio', () => {
  const items = ['100', '200', '300'].map(item);
  for (const id of ['100', '300', '200']) {
    const primary = resolvePlayerMedia(items, evidence(id));
    assert.equal(primary?.id, id);
    const rows = buildRows([primary!]);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const request = buildDownloadMessage(row.item, row.variant, 1, true);
      assert.ok(request.payload.url.includes(`/${id}/`));
      assert.ok(request.payload.audioUrl?.includes(`/${id}/`));
    }
  }
});

test('unseen or ambiguous asset never selects a different video', () => {
  assert.equal(resolvePlayerMedia([item('100')], { ...evidence('999'), playerCount: 1 }), undefined);
  assert.equal(resolvePlayerMedia([item('100'), { ...item('100'), id: 'duplicate' }], evidence('100')), undefined);
});

test('direct and child playlist sources resolve without provider-specific assumptions', () => {
  const target = {
    ...item('100'),
    url: 'https://cdn.example/master.m3u8',
    hlsChildUrls: ['https://other.example/child.m3u8'],
  };
  assert.equal(resolvePlayerMedia([target, item('200')], { ...evidence('200'), sourceUrls: [target.url] }), target);
  assert.equal(
    resolvePlayerMedia([target, item('200')], { ...evidence('200'), sourceUrls: target.hlsChildUrls }),
    target,
  );
  assert.equal(
    resolvePlayerMedia([target], { ...evidence('100'), sourceUrls: ['https://cdn.example/unseen.mp4'] }),
    undefined,
  );
});

test('single-player pages retain a unique same-page presentation; multiple candidates remain unresolved', () => {
  const player = { sourceUrls: ['blob:local'], posterUrl: '', pageUrl, playerCount: 1 };
  assert.equal(resolvePlayerMedia([item('100')], player)?.id, '100');
  assert.equal(resolvePlayerMedia([item('100'), item('200')], player), undefined);
  assert.equal(resolvePlayerMedia([item('100')], { ...player, pageUrl: 'https://example.com/other' })?.id, '100');
  assert.equal(resolvePlayerMedia([item('100')], { ...player, playerCount: 2 }), undefined);
});

test('cross-origin iframe player can use the tab-level unique presentation fallback', () => {
  const detectedInTopTab = {
    ...item('100'),
    pageUrl: 'https://avple.tv/video/124114844020371',
    url: 'https://cdn.example/avple/playlist.m3u8',
  };
  assert.equal(
    resolvePlayerMedia([detectedInTopTab], {
      sourceUrls: ['blob:https://iframe-player.example/local-media-source'],
      posterUrl: '',
      pageUrl: 'https://iframe-player.example/embed/124114844020371',
      playerCount: 1,
    }),
    detectedInTopTab,
  );
});

test('offscreen large video does not steal overlay from visible player; playback breaks ties', () => {
  const box = (id: string, top: number, playing = false) => ({
    id,
    playing,
    rect: { top, bottom: top + 300, left: 0, right: 500, width: 500, height: 300 },
  });
  const offscreen = box('old', -400, true);
  const visible = box('visible', 100);
  assert.equal(selectVisiblePlayer([offscreen, visible], 1000, 800)?.id, 'visible');
  assert.equal(selectVisiblePlayer([visible, box('playing', 450, true)], 1000, 800)?.id, 'playing');
  assert.equal(selectVisiblePlayer([offscreen], 1000, 800), undefined);
});

test('ext_tw_video poster IDs are matched exactly and untrusted lookalike hosts are ignored', () => {
  const target = { ...item('123'), url: 'https://video.twimg.com/ext_tw_video/123/pu/pl/master.m3u8' };
  assert.equal(
    resolvePlayerMedia([target], {
      ...evidence('123'),
      posterUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/cover.jpg',
    }),
    target,
  );
  assert.equal(
    resolvePlayerMedia([target], {
      ...evidence('123'),
      posterUrl: 'https://pbs.twimg.com.evil.example/ext_tw_video_thumb/123/cover.jpg',
    }),
    undefined,
  );
});
