import { parseHlsPlaylist } from './m3u8-parser';
import assert from 'node:assert/strict';
import test from 'node:test';

test('HLS ranges retain initialization offsets, explicit offsets and implicit same-resource offsets', () => {
  const parsed = parseHlsPlaylist(
    '#EXTM3U\n#EXT-X-MAP:URI="one.mp4",BYTERANGE="10@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:20@10\none.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:30\none.mp4\n',
    'https://cdn.test/playlist.m3u8',
  );
  assert.deepEqual(parsed.mapRange, { start: 0, end: 9 });
  assert.deepEqual(
    parsed.segments.map(segment => segment.range),
    [
      { start: 10, end: 29 },
      { start: 30, end: 59 },
    ],
  );
});

test('HLS implicit offsets require a prior range of the same resource', () => {
  for (const content of [
    '#EXT-X-BYTERANGE:20\none.mp4',
    '#EXT-X-BYTERANGE:10@0\none.mp4\n#EXT-X-BYTERANGE:20\ntwo.mp4',
    '#EXT-X-BYTERANGE:0@0\none.mp4',
  ])
    assert.throws(() => parseHlsPlaylist(content, 'https://cdn.test/p.m3u8'), /Invalid HLS byte range/);
});
