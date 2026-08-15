import {
  WEB_MEDIA_REMUX_CAPABILITIES,
  buildMediaProcessingArgs,
  normalizeCodec,
  planMediaProcessing,
  tracksFromCodecString,
} from './media-processing';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaDescriptor, MediaProcessingPlan } from './media-processing';

const verified = { source: 'media-probe', confidence: 'verified' } as const;
const video = (codec: 'h264' | 'hevc' | 'vp9') => ({ type: 'video', codec, evidence: verified }) as const;
const audio = (codec: 'aac' | 'opus' | 'unknown') => ({ type: 'audio', codec, evidence: verified }) as const;

const descriptor = (overrides: Partial<MediaDescriptor> = {}): MediaDescriptor => ({
  inputKind: 'hls',
  container: 'mpegts',
  tracks: [video('h264'), audio('aac')],
  encryption: 'none',
  hasInitializationSegment: false,
  ...overrides,
});

const executable = <T extends Exclude<MediaProcessingPlan, { type: 'unsupported' }>['type']>(
  plan: MediaProcessingPlan,
  type: T,
): Extract<MediaProcessingPlan, { type: T }> => {
  assert.equal(plan.type, type);
  return plan as Extract<MediaProcessingPlan, { type: T }>;
};

test('capabilities match the web-media-remux binary contract', () => {
  assert.equal(WEB_MEDIA_REMUX_CAPABILITIES.variant, 'web-media-remux-cli');
  assert.deepEqual(WEB_MEDIA_REMUX_CAPABILITIES.encoders, ['mp3']);
  assert.ok(WEB_MEDIA_REMUX_CAPABILITIES.parsers.includes('hevc'));
  assert.ok(WEB_MEDIA_REMUX_CAPABILITIES.demuxers.includes('webm'));
  assert.ok(WEB_MEDIA_REMUX_CAPABILITIES.muxers.includes('mp4'));
  assert.ok(WEB_MEDIA_REMUX_CAPABILITIES.protocols.includes('jsfetch'));
  assert.deepEqual(WEB_MEDIA_REMUX_CAPABILITIES.outputDevices, ['mkwriterdev']);
});

test('plans H.264 and HEVC MPEG-TS HLS as stream-copy MP4', () => {
  const h264 = executable(planMediaProcessing(descriptor(), 'media'), 'copy-to-mp4');
  assert.equal(h264.output.extension, '.mp4');
  assert.equal(h264.videoTag, undefined);
  assert.equal(h264.prefetchToOpfs, true);

  const hevc = executable(
    planMediaProcessing(descriptor({ tracks: [video('hevc'), audio('aac')] }), 'media'),
    'copy-to-mp4',
  );
  assert.equal(hevc.videoTag, 'hvc1');
  assert.equal(hevc.prefetchToOpfs, true);
  assert.deepEqual(hevc.requiredTracks, [
    { type: 'video', codec: 'hevc' },
    { type: 'audio', codec: 'aac' },
  ]);
});

test('plans fMP4 HLS, DASH, direct MP4, separate tracks, and WebM deterministically', () => {
  assert.equal(
    planMediaProcessing(descriptor({ container: 'mp4', hasInitializationSegment: true }), 'media').type,
    'concatenate-fmp4',
  );
  assert.equal(
    planMediaProcessing(descriptor({ inputKind: 'dash', container: 'mp4', hasInitializationSegment: true }), 'media')
      .type,
    'copy-to-mp4',
  );
  assert.equal(planMediaProcessing(descriptor({ inputKind: 'direct', container: 'mp4' }), 'media').type, 'passthrough');
  assert.equal(
    planMediaProcessing(descriptor({ inputKind: 'separate-tracks', container: 'mp4' }), 'media').type,
    'copy-to-mp4',
  );
  const webm = executable(
    planMediaProcessing(
      descriptor({
        inputKind: 'direct',
        container: 'webm',
        tracks: [video('vp9'), audio('opus')],
      }),
      'media',
    ),
    'copy-to-webm',
  );
  assert.equal(webm.output.mime, 'video/webm');
});

test('MP3 is the only transcode plan and requires a decodable audio track', () => {
  const mp3 = executable(planMediaProcessing(descriptor(), 'mp3'), 'transcode-audio-to-mp3');
  assert.equal(mp3.audioEncoder, 'libmp3lame');
  assert.deepEqual(mp3.requiredTracks, [{ type: 'audio', codec: 'mp3' }]);

  const missingAudio = planMediaProcessing(descriptor({ tracks: [video('h264')] }), 'mp3');
  assert.deepEqual(missingAudio, {
    type: 'unsupported',
    reason: 'missing-required-track',
    message: 'An audio track is required for MP3 output',
  });

  const unknownAudio = planMediaProcessing(descriptor({ tracks: [video('h264'), audio('unknown')] }), 'mp3');
  assert.equal(unknownAudio.type, 'unsupported');
  if (unknownAudio.type === 'unsupported') assert.equal(unknownAudio.reason, 'missing-decoder');
});

test('rejects DRM, unknown codecs, unsupported containers, and missing video before execution', () => {
  const cases: Array<[MediaDescriptor, string]> = [
    [descriptor({ encryption: 'drm' }), 'drm-protected'],
    [descriptor({ tracks: [audio('aac')] }), 'missing-required-track'],
    [descriptor({ tracks: [{ type: 'video', codec: 'unknown', evidence: verified }] }), 'unsupported-video-codec'],
    [descriptor({ container: 'unknown' }), 'unsupported-input-container'],
    [descriptor({ tracks: [video('h264'), audio('unknown')] }), 'unsupported-audio-codec'],
  ];
  for (const [input, reason] of cases) {
    const plan = planMediaProcessing(input, 'media');
    assert.equal(plan.type, 'unsupported');
    if (plan.type === 'unsupported') assert.equal(plan.reason, reason);
  }
});

test('builds FFmpeg arguments only from an executable plan', () => {
  const hevc = executable(
    planMediaProcessing(descriptor({ tracks: [video('hevc'), audio('aac')] }), 'media'),
    'copy-to-mp4',
  );
  assert.deepEqual(buildMediaProcessingArgs(hevc, { urls: ['jsfetch:input.ts'], formatHint: 'hls' }, 'out.mp4'), [
    '-f',
    'hls',
    '-i',
    'jsfetch:input.ts',
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-tag:v',
    'hvc1',
    '-y',
    'out.mp4',
  ]);

  const merged = executable(
    planMediaProcessing(descriptor({ inputKind: 'separate-tracks', container: 'mp4' }), 'media'),
    'copy-to-mp4',
  );
  const args = buildMediaProcessingArgs(merged, { urls: ['video.mp4', 'audio.m4a'] }, 'out.mp4');
  assert.deepEqual(args.slice(0, 4), ['-i', 'video.mp4', '-i', 'audio.m4a']);
  assert.ok(args.includes('0:v:0?'));
  assert.ok(args.includes('1:a:0?'));
});

test('normalizes declared codec strings without inferring unknown values', () => {
  assert.equal(normalizeCodec('avc1.640028'), 'h264');
  assert.equal(normalizeCodec('hvc1.1.6.L93.B0'), 'hevc');
  assert.equal(normalizeCodec('vp09.00.10.08'), 'vp9');
  assert.equal(normalizeCodec(undefined), 'unknown');
  assert.equal(normalizeCodec('av01.0.05M.08'), 'unknown');
  assert.deepEqual(
    tracksFromCodecString('hvc1.1.6.L93.B0, mp4a.40.2', 'manifest').map(track => [track.type, track.codec]),
    [
      ['video', 'hevc'],
      ['audio', 'aac'],
    ],
  );
});
