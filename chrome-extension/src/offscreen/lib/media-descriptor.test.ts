import { describeHls, probeMediaBytes } from './media-descriptor';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const fixtureRoot = process.env.VIDSY_MEDIA_FIXTURES ?? '/tmp/vidsy-web-media-remux/fixtures-full';
const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path.join(fixtureRoot, name)));

test('bounded byte probe identifies H.264 and HEVC MPEG-TS from PMT facts', async () => {
  const h264 = probeMediaBytes(await fixture('hls-ts-h264.ts'));
  assert.equal(h264.container, 'mpegts');
  assert.deepEqual(
    h264.tracks.map(track => [track.type, track.codec]),
    [
      ['video', 'h264'],
      ['audio', 'aac'],
    ],
  );

  const hevc = probeMediaBytes(await fixture('hls-ts-hevc.ts'));
  assert.equal(hevc.container, 'mpegts');
  assert.deepEqual(
    hevc.tracks.map(track => [track.type, track.codec]),
    [
      ['video', 'hevc'],
      ['audio', 'aac'],
    ],
  );
});

test('bounded byte probe identifies MP4 and WebM tracks without URL hints', async () => {
  const mp4 = probeMediaBytes(await fixture('direct.mp4'));
  assert.equal(mp4.container, 'mp4');
  assert.deepEqual(
    mp4.tracks.map(track => [track.type, track.codec]),
    [
      ['video', 'h264'],
      ['audio', 'aac'],
    ],
  );

  const webm = probeMediaBytes(await fixture('vp9-opus.webm'));
  assert.equal(webm.container, 'webm');
  assert.deepEqual(
    webm.tracks.map(track => [track.type, track.codec]),
    [
      ['video', 'vp9'],
      ['audio', 'opus'],
    ],
  );
});

test('bounded MP4 probe recognises AV1 sample entries', () => {
  const bytes = new Uint8Array([
    0,
    0,
    0,
    20,
    ...Buffer.from('ftyp'),
    ...Buffer.from('iso5'),
    0,
    0,
    0,
    0,
    ...Buffer.from('av01'),
  ]);

  assert.deepEqual(
    probeMediaBytes(bytes).tracks.map(track => [track.type, track.codec]),
    [['video', 'av1']],
  );
});

test('unknown bytes remain unknown', () => {
  assert.deepEqual(probeMediaBytes(new Uint8Array([1, 2, 3, 4])), {
    container: 'unknown',
    tracks: [],
    hasInitializationSegment: false,
  });
});

test('HLS descriptor probes the first segment when codecs are undeclared', async () => {
  const manifestText = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n';
  const segment = await fixture('hls-ts-hevc.ts');
  const requests: RequestInfo[] = [];
  const descriptor = await describeHls({
    manifestText,
    manifestUrl: 'https://fixture.invalid/playlist.m3u8',
    fetchImpl: async input => {
      requests.push(input instanceof URL ? input.toString() : input);
      const body = new Uint8Array(segment.byteLength);
      body.set(segment);
      return new Response(body.buffer, {
        status: 206,
        headers: { 'content-length': String(segment.byteLength) },
      });
    },
  });

  assert.deepEqual(requests, ['https://fixture.invalid/segment.ts']);
  assert.equal(descriptor.container, 'mpegts');
  assert.deepEqual(
    descriptor.tracks.map(track => [track.type, track.codec]),
    [
      ['video', 'hevc'],
      ['audio', 'aac'],
    ],
  );
});

test('HLS descriptor rejects probe bodies above the fixed byte budget', async () => {
  const manifestText = '#EXTM3U\n#EXTINF:2,\nsegment.ts\n';
  await assert.rejects(
    describeHls({
      manifestText,
      manifestUrl: 'https://fixture.invalid/playlist.m3u8',
      fetchImpl: async () =>
        new Response(new Uint8Array(), {
          status: 206,
          headers: { 'content-length': String(256 * 1024 + 1) },
        }),
    }),
    /exceeded 262144 bytes/,
  );
});
