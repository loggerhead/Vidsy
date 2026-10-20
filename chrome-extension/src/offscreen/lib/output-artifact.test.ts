import { validateOutputArtifact } from './output-artifact';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { ExecutableMuxPlan } from './media-processing';

const smokeRoot = process.env.VIDSY_MEDIA_SMOKE ?? path.resolve(import.meta.dirname, '../../../../.media-test/outputs');

const fixtureFile = async (name: string): Promise<File> => {
  const bytes = await readFile(`${smokeRoot}/${name}`);
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new File([body.buffer], name);
};

const ascii = (value: string): number[] => [...value].map(character => character.charCodeAt(0));
const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const box = (type: string, body: number[] = []): number[] => [...u32(body.length + 8), ...ascii(type), ...body];
const trackBox = (handler: 'vide' | 'soun', codec: string): number[] =>
  box('trak', [
    ...box('mdia', [
      ...box('hdlr', [0, 0, 0, 0, 0, 0, 0, 0, ...ascii(handler)]),
      ...box('minf', [...box('stbl', [...box('stsd', [0, 0, 0, 0, ...u32(1), ...box(codec)])])]),
    ]),
  ]);
const minimalAv1AacMp4 = (): File => {
  const bytes = new Uint8Array([
    ...box('ftyp', [...ascii('isom'), 0, 0, 0, 0]),
    ...box('moov', [...trackBox('vide', 'av01'), ...trackBox('soun', 'mp4a')]),
    ...box('mdat', [1]),
  ]);
  return new File([bytes], 'av1-aac.mp4');
};

const mp4Plan = (video: 'h264' | 'hevc' | 'av1'): ExecutableMuxPlan => ({
  type: 'copy-to-mp4',
  output: { container: 'mp4', extension: '.mp4', mime: 'video/mp4' },
  requiredTracks: [
    { type: 'video', codec: video },
    { type: 'audio', codec: 'aac' },
  ],
  prefetchToOpfs: false,
  videoTag: video === 'hevc' ? 'hvc1' : undefined,
});

test('validates stream-copied AV1 and AAC MP4 output', async () => {
  const artifact = await validateOutputArtifact({
    file: minimalAv1AacMp4(),
    opfsName: 'av1-output.mp4',
    plan: mp4Plan('av1'),
  });

  assert.deepEqual(artifact.tracks, [
    { type: 'video', codec: 'av1' },
    { type: 'audio', codec: 'aac' },
  ]);
});

test('validates MP4 container, required tracks, codecs, and duration', async () => {
  const artifact = await validateOutputArtifact({
    file: await fixtureFile('hevc-web-media-remux.mp4'),
    opfsName: 'output.mp4',
    plan: mp4Plan('hevc'),
    expectedDurationSeconds: 2,
  });

  assert.equal(artifact.container, 'mp4');
  assert.equal(artifact.planType, 'copy-to-mp4');
  assert.deepEqual(artifact.tracks, [
    { type: 'video', codec: 'hevc' },
    { type: 'audio', codec: 'aac' },
  ]);
  assert.ok(artifact.durationSeconds && artifact.durationSeconds > 1.9);
});

test('validates fragmented MP4 concatenation and DASH remux outputs', async () => {
  const fmp4 = await validateOutputArtifact({
    file: await fixtureFile('matrix-hls-fmp4.mp4'),
    opfsName: 'fmp4.mp4',
    plan: {
      type: 'concatenate-fmp4',
      output: { container: 'mp4', extension: '.mp4', mime: 'video/mp4' },
      requiredTracks: [
        { type: 'video', codec: 'h264' },
        { type: 'audio', codec: 'aac' },
      ],
      prefetchToOpfs: true,
    },
    expectedDurationSeconds: 2,
  });
  assert.deepEqual(fmp4.tracks, [
    { type: 'video', codec: 'h264' },
    { type: 'audio', codec: 'aac' },
  ]);

  const dash = await validateOutputArtifact({
    file: await fixtureFile('matrix-dash-fixed.mp4'),
    opfsName: 'dash.mp4',
    plan: mp4Plan('h264'),
    expectedDurationSeconds: 2,
  });
  assert.equal(dash.container, 'mp4');
});

test('validates WebM and MP3 output structures', async () => {
  const webm = await validateOutputArtifact({
    file: await fixtureFile('matrix-vp9.webm'),
    opfsName: 'output.webm',
    plan: {
      type: 'copy-to-webm',
      output: { container: 'webm', extension: '.webm', mime: 'video/webm' },
      requiredTracks: [
        { type: 'video', codec: 'vp9' },
        { type: 'audio', codec: 'opus' },
      ],
      prefetchToOpfs: false,
    },
  });
  assert.deepEqual(webm.tracks, [
    { type: 'video', codec: 'vp9' },
    { type: 'audio', codec: 'opus' },
  ]);

  const mp3 = await validateOutputArtifact({
    file: await fixtureFile('matrix-audio.mp3'),
    opfsName: 'output.mp3',
    plan: {
      type: 'transcode-audio-to-mp3',
      output: { container: 'mp3', extension: '.mp3', mime: 'audio/mpeg' },
      requiredTracks: [{ type: 'audio', codec: 'mp3' }],
      prefetchToOpfs: false,
      audioEncoder: 'libmp3lame',
    },
    expectedDurationSeconds: 2,
  });
  assert.deepEqual(mp3.tracks, [{ type: 'audio', codec: 'mp3' }]);
  assert.ok(mp3.durationSeconds && mp3.durationSeconds > 1.5);
});

test('rejects truncated output and missing required tracks', async () => {
  const valid = await fixtureFile('hevc-web-media-remux.mp4');
  const truncated = new File([await valid.slice(0, Math.floor(valid.size / 2)).arrayBuffer()], 'truncated.mp4');
  await assert.rejects(
    validateOutputArtifact({
      file: truncated,
      opfsName: 'truncated.mp4',
      plan: mp4Plan('hevc'),
    }),
    /invalid|truncated|missing/i,
  );

  await assert.rejects(
    validateOutputArtifact({
      file: await fixtureFile('hevc-web-media-remux.mp4'),
      opfsName: 'wrong-plan.mp4',
      plan: mp4Plan('h264'),
    }),
    /missing required video track h264/,
  );
});
