import { groupDownloadOptions, recommendDownloadOption } from './download-options';
import { buildRows } from './media-helpers';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaItem, MediaVariant } from '@extension/shared';

const variant = (height: number, codecs = 'avc1', extra: Partial<MediaVariant> = {}): MediaVariant => ({
  url: `https://media.example/${height}-${codecs}.mp4`,
  resolution: { width: Math.round((height * 16) / 9), height },
  codecs,
  ...extra,
});
const item = (variants: MediaVariant[]): MediaItem => ({
  id: 'video',
  url: 'https://media.example/video',
  kind: 'video',
  source: 'element',
  detectedAt: 1,
  duration: 120,
  variants,
});

test('groups renditions by quality, retains codec choices and recommends compatible 1080p', () => {
  const media = item([variant(2160), variant(1080, 'av01'), variant(720), variant(1080), variant(1080)]);
  const groups = groupDownloadOptions(buildRows([media]));
  assert.deepEqual(
    groups.map(group => group.quality),
    ['2160p', '1080p', '720p'],
  );
  assert.equal(groups[1].options.length, 2);
  assert.equal(groups[1].options[0].details, 'H.264');
  assert.equal(
    groupDownloadOptions(buildRows([item([variant(1080, 'avc1', { bandwidth: 4_500_000 })])]))[0].options[0].details,
    'H.264 · 4.5 Mbps',
  );
  assert.equal(recommendDownloadOption(groups)?.variant?.codecs, 'avc1');
  assert.equal(recommendDownloadOption(groups)?.height, 1080);
});

test('recommendation handles lower-only, higher-only, portrait and protected renditions', () => {
  for (const [variants, expected] of [
    [[variant(360), variant(720)], 720],
    [[variant(2160), variant(1440)], 1440],
    [[variant(1080, 'avc1', { isDrmProtected: true }), variant(720)], 720],
    [[variant(1920, 'avc1', { resolution: { width: 1080, height: 1920 } })], 1080],
  ] as [MediaVariant[], number][]) {
    assert.equal(recommendDownloadOption(groupDownloadOptions(buildRows([item(variants)])))?.height, expected);
  }
  assert.equal(
    recommendDownloadOption(groupDownloadOptions(buildRows([item([variant(1080, 'avc1', { isDrmProtected: true })])]))),
    undefined,
  );
});

test('does not invent rendition resolution, audio or exact file size from its parent', () => {
  const media = {
    ...item([
      { url: 'https://media.example/unknown', bandwidth: 1_000_000 },
      { url: 'https://media.example/other-unknown' },
      variant(720, 'avc1', { contentLength: 1024 * 1024 }),
    ]),
    resolution: { width: 3840, height: 2160 },
    contentLength: 99_000_000,
  };
  const groups = groupDownloadOptions(buildRows([media]));
  assert.equal(groups.length, 3);
  assert.equal(groups[1].quality, 'Auto');
  assert.equal(groups[1].options[0].size, '14.3 MB');
  assert.equal(groups[2].options[0].size, 'Size unknown');
  assert.equal(groups[0].options[0].size, '1.0 MB');
});

test('keeps distinct audio pairings and the original download target when grouping', () => {
  const one = variant(1080, 'avc1', { audioUrl: 'https://media.example/audio-en' });
  const two = { ...one, audioUrl: 'https://media.example/audio-zh' };
  const media = item([one, two]);
  const [group] = groupDownloadOptions(buildRows([media]));
  assert.equal(group.options.length, 2);
  assert.equal(group.options[1].item, media);
  assert.equal(group.options[1].variant, two);
});
