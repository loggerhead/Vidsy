import { buildDownloadMessage } from './download-request';
import { buildRows } from './media-helpers';
import { presentationThumbnailUrl, resolvePlayerMedia, selectVisiblePlayer } from './player-media';
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
    const resolution = resolvePlayerMedia(items, evidence(id));
    assert.equal(resolution?.item.id, id);
    assert.equal(resolution?.authority, 'poster');
    const rows = buildRows([resolution!.item]);
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

test('X video and audio rendition playlists for one poster become download choices', () => {
  const id = '2101667014213611520';
  const base = item(id);
  const playlist = (name: string, suffix: string): MediaItem => ({
    ...base,
    id: name,
    url: `https://video.twimg.com/amplify_video/${id}/pl/${suffix}`,
    variants: undefined,
  });
  const items = [
    playlist('1080', 'avc1/1920x1080/hi.m3u8'),
    playlist('audio', 'mp4a/32000/audio.m3u8'),
    playlist('270', 'avc1/480x270/low.m3u8'),
    playlist('other', 'avc1/3840x2160/ultra.m3u8'),
  ];
  const resolved = resolvePlayerMedia(items, evidence(id));
  assert.equal(resolved?.authority, 'poster');
  assert.equal(resolved?.item.variants?.length, 3);
  assert.equal(resolved?.item.variants?.[0].resolution?.height, 2160);
  for (const row of buildRows([resolved!.item])) {
    const request = buildDownloadMessage(row.item, row.variant, 1, true);
    assert.ok(request.payload.url.includes(`/${id}/pl/avc1/`));
    assert.ok(request.payload.audioUrl?.includes(`/${id}/pl/mp4a/`));
  }
});

test('direct and child playlist sources resolve without provider-specific assumptions', () => {
  const target = {
    ...item('100'),
    url: 'https://cdn.example/master.m3u8',
    hlsChildUrls: ['https://other.example/child.m3u8'],
  };
  assert.equal(
    resolvePlayerMedia([target, item('200')], { ...evidence('200'), sourceUrls: [target.url] })?.item,
    target,
  );
  assert.equal(
    resolvePlayerMedia([target, item('200')], { ...evidence('200'), sourceUrls: target.hlsChildUrls })?.item,
    target,
  );
  assert.equal(
    resolvePlayerMedia([target], { ...evidence('100'), sourceUrls: ['https://cdn.example/unseen.mp4'] }),
    undefined,
  );
});

test('the playing source wins over alternate source tags and a stale poster', () => {
  const playing = item('100');
  const alternative = item('200');
  assert.equal(
    resolvePlayerMedia([playing, alternative], {
      ...evidence('200'),
      currentSrc: playing.url,
      sourceUrls: [playing.url, alternative.url],
    })?.item,
    playing,
  );
});

test('X poster fallback requires the playing URL to identify the same asset', () => {
  const media = item('100');
  const matchingUrl = 'https://video.twimg.com/amplify_video/100/vid/720.mp4';
  const conflictingUrl = 'https://video.twimg.com/amplify_video/200/vid/720.mp4';
  assert.equal(
    resolvePlayerMedia([media], { ...evidence('100'), currentSrc: matchingUrl, sourceUrls: [matchingUrl] })?.item,
    media,
  );
  assert.equal(
    resolvePlayerMedia([media], { ...evidence('100'), currentSrc: conflictingUrl, sourceUrls: [conflictingUrl] }),
    undefined,
  );
});

test('blob playback ignores stale non-blob source tags', () => {
  const playing = item('100');
  const stale = item('200');
  assert.equal(
    resolvePlayerMedia([playing, stale], {
      ...evidence('100'),
      currentSrc: 'blob:https://x.com/local',
      sourceUrls: ['blob:https://x.com/local', stale.url],
    })?.item,
    playing,
  );
});

test('single-player pages retain a unique same-page presentation; multiple candidates remain unresolved', () => {
  const player = { sourceUrls: ['blob:local'], posterUrl: '', pageUrl, playerCount: 1 };
  assert.equal(resolvePlayerMedia([item('100')], player)?.item.id, '100');
  assert.equal(resolvePlayerMedia([item('100')], player)?.authority, 'unique-presentation');
  assert.equal(resolvePlayerMedia([item('100'), item('200')], player), undefined);
  assert.equal(resolvePlayerMedia([item('100')], { ...player, pageUrl: 'https://example.com/other' })?.item.id, '100');
  assert.equal(resolvePlayerMedia([item('100')], { ...player, playerCount: 2 }), undefined);
});

test('a unique same-page blob player uses its page image when the video has no poster', () => {
  const media = { ...item('100'), pageUrl: 'https://missav.ws/dm14/en/cz0006' };
  const player = {
    sourceUrls: ['blob:https://missav.ws/local'],
    posterUrl: '',
    pageUrl: media.pageUrl,
    playerCount: 1,
  };
  const resolved = resolvePlayerMedia([media], player);
  assert.equal(resolved?.authority, 'unique-presentation');
  assert.equal(
    presentationThumbnailUrl(resolved, player, 'https://fourhoi.com/cz0006/cover-n.jpg'),
    'https://fourhoi.com/cz0006/cover-n.jpg',
  );
  assert.equal(
    presentationThumbnailUrl(resolved, { ...player, pageUrl: 'https://other.example/watch' }, '/cover.jpg'),
    undefined,
  );
  assert.equal(presentationThumbnailUrl(resolved, { ...player, playerCount: 2 }, '/cover.jpg'), undefined);
  assert.equal(presentationThumbnailUrl(resolved, player, 'javascript:alert(1)'), undefined);
});

test('Bilibili blob player resolves its uniquely paired video and audio tracks', () => {
  const paired: MediaItem = {
    ...item('bili'),
    kind: 'video',
    variants: undefined,
    url: 'https://cdn.example/video.m4s',
    audioUrl: 'https://cdn.example/audio.m4s',
    pageUrl: 'https://www.bilibili.com/video/BV1j5nj68E48/',
  };
  const player = {
    sourceUrls: ['blob:https://www.bilibili.com/local'],
    posterUrl: '',
    pageUrl: 'https://www.bilibili.com/video/BV1j5nj68E48/?vd_source=abc',
    playerCount: 1,
  };
  assert.equal(resolvePlayerMedia([paired], player)?.item, paired);
  assert.equal(resolvePlayerMedia([paired, { ...paired, id: 'second' }], player), undefined);
  assert.equal(
    resolvePlayerMedia([paired], { ...player, pageUrl: 'https://www.bilibili.com/video/BVother' }),
    undefined,
  );
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
    })?.item,
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
    })?.item,
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
