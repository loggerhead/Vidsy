import { extractBilibiliPresentation } from './bilibili-presentation';
import assert from 'node:assert/strict';
import test from 'node:test';

const pageUrl = 'https://www.bilibili.com/video/BV1PcJd6UEQk/';
const video = (id: number, height: number) => ({
  id,
  baseUrl: `https://video.example/${id}.m4s?signature=keep-me`,
  width: (height * 16) / 9,
  height,
  codecs: 'avc1.640033',
  frameRate: '60000/1001',
  bandwidth: 4_000_000,
});
const declaration = (
  videos = [video(80, 1080), video(64, 720)],
  audio = [
    { base_url: 'https://audio.example/aac.m4s', codecs: 'mp4a.40.2', bandwidth: 128_000 },
    { baseUrl: 'https://audio.example/low.m4s', codecs: 'mp4a.40.2', bandwidth: 64_000 },
  ],
) =>
  `window.__playinfo__=${JSON.stringify({
    code: 0,
    data: {
      timelength: 499818,
      accept_quality: [80, 64],
      accept_description: ['1080P 高清', '720P 高清'],
      dash: { video: videos, audio },
    },
  })};`;
const page = {
  pageUrl: `${pageUrl}?trackid=tracking`,
  canonicalUrl: pageUrl,
  scripts: [declaration()],
  title: '真实锐评',
  thumbnail: 'https://i1.hdslb.com/bfs/archive/cover.jpg',
};

test('Bilibili main video has one presentation with its cover, signed qualities and paired audio', () => {
  const result = extractBilibiliPresentation(page)!;
  assert.equal(result.title, page.title);
  assert.equal(result.thumbnail, page.thumbnail);
  assert.equal(result.duration, 499.818);
  assert.equal(result.variants.length, 2);
  assert.equal(result.variants[0].name, '1080P 高清');
  assert.equal(result.variants[0].url, 'https://video.example/80.m4s?signature=keep-me');
  assert.equal(result.variants[0].frameRate, 60000 / 1001);
  assert.ok(result.variants.every(v => v.audioUrl === 'https://audio.example/aac.m4s'));
});

test('one available quality is still a complete presentation rather than an MSE placeholder', () => {
  const result = extractBilibiliPresentation({ ...page, scripts: [declaration([video(80, 1080)])] });
  assert.equal(result?.variants.length, 1);
  assert.ok(result?.variants[0].audioUrl);
});

test('page metadata cannot authorize unrelated videos, feeds, parts or lookalike hosts', () => {
  for (const url of [
    'https://www.bilibili.com/',
    'https://www.bilibili.com/video/BVother/',
    `${pageUrl}?p=2`,
    'https://www.bilibili.com.evil.example/video/BV1PcJd6UEQk/',
  ]) {
    assert.equal(extractBilibiliPresentation({ ...page, pageUrl: url }), undefined);
  }
  assert.equal(extractBilibiliPresentation({ ...page, canonicalUrl: undefined }), undefined);
});

test('invalid, incomplete and non-http declarations do not publish a silent or untrusted download', () => {
  for (const scripts of [
    ['window.__playinfo__={broken};'],
    [declaration([], [])],
    [declaration([video(80, 1080)], [])],
    [declaration([{ ...video(80, 1080), baseUrl: 'javascript:bad()' }])],
    [declaration().replace('"code":0', '"code":-1')],
  ]) {
    assert.equal(extractBilibiliPresentation({ ...page, scripts }), undefined);
  }
  assert.equal(extractBilibiliPresentation({ ...page, thumbnail: 'javascript:bad()' })?.thumbnail, undefined);
});

test('uses the declared standard CDN backup instead of a peer audio or video endpoint', () => {
  const videoTrack = {
    ...video(80, 1080),
    baseUrl: 'https://peer.mcdn.bilivideo.cn:8082/video.m4s?signature=peer',
    backupUrl: ['https://upos.bilivideo.com/video.m4s?signature=video-backup'],
  };
  const audioTrack = {
    baseUrl: 'https://peer.mcdn.bilivideo.cn:8082/audio.m4s?signature=peer',
    backup_url: ['https://upos.bilivideo.com/audio.m4s?signature=audio-backup'],
    codecs: 'mp4a.40.2',
    bandwidth: 128_000,
  };
  const result = extractBilibiliPresentation({ ...page, scripts: [declaration([videoTrack], [audioTrack])] })!;
  assert.equal(result.variants[0].url, videoTrack.backupUrl[0]);
  assert.equal(result.variants[0].audioUrl, audioTrack.backup_url[0]);
});
