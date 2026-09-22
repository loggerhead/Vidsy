type MediaInputKind = 'hls' | 'dash' | 'direct' | 'separate-tracks';
type MediaContainer = 'mpegts' | 'mp4' | 'webm' | 'aac' | 'mp3' | 'wav' | 'unknown';
type MediaCodec = 'h264' | 'hevc' | 'av1' | 'aac' | 'vp9' | 'opus' | 'mp3' | 'pcm' | 'unknown';
type MediaTrackType = 'video' | 'audio';
type OutputContainer = 'mp4' | 'webm' | 'mp3';

type MediaEvidence = {
  source: 'manifest' | 'init-segment' | 'media-probe' | 'content-type';
  confidence: 'declared' | 'verified';
};

type MediaTrack = {
  type: MediaTrackType;
  codec: MediaCodec;
  codecString?: string;
  evidence: MediaEvidence;
};

type MediaDescriptor = {
  inputKind: MediaInputKind;
  container: MediaContainer;
  tracks: MediaTrack[];
  encryption: 'none' | 'aes-128' | 'drm' | 'unknown';
  hasInitializationSegment: boolean;
  durationSeconds?: number;
  totalBytes?: number;
};

type MediaCapabilities = {
  variant: string;
  demuxers: readonly MediaContainer[];
  parsers: readonly MediaCodec[];
  muxers: readonly OutputContainer[];
  bitstreamFilters: readonly string[];
  decoders: readonly MediaCodec[];
  encoders: readonly MediaCodec[];
  protocols: readonly string[];
  outputDevices: readonly string[];
};

const WEB_MEDIA_REMUX_CAPABILITIES: MediaCapabilities = {
  variant: 'web-media-remux-cli',
  demuxers: ['mpegts', 'mp4', 'webm', 'aac', 'mp3'],
  // This is a stream-copy capability list, not a decoder list. The bundled
  // engine can demux and mux AV1-in-MP4 without decoding video frames.
  parsers: ['h264', 'hevc', 'av1', 'aac', 'vp9', 'opus', 'mp3'],
  muxers: ['mp4', 'webm', 'mp3'],
  bitstreamFilters: ['extract_extradata', 'h264_mp4toannexb', 'hevc_mp4toannexb', 'aac_adtstoasc'],
  decoders: ['aac', 'opus', 'mp3'],
  encoders: ['mp3'],
  protocols: ['data', 'file', 'jsfetch'],
  outputDevices: ['mkwriterdev'],
};

type PlanOutput = {
  container: OutputContainer;
  extension: '.mp4' | '.webm' | '.mp3';
  mime: 'video/mp4' | 'video/webm' | 'audio/mpeg';
};

type RequiredTrack = {
  type: MediaTrackType;
  codec: MediaCodec;
};

type ExecutablePlanBase = {
  output: PlanOutput;
  requiredTracks: RequiredTrack[];
  prefetchToOpfs: boolean;
};

type CopyToMp4Plan = ExecutablePlanBase & {
  type: 'copy-to-mp4';
  videoTag?: 'hvc1';
};

type CopyToWebmPlan = ExecutablePlanBase & {
  type: 'copy-to-webm';
};

type ConcatenateFmp4Plan = ExecutablePlanBase & {
  type: 'concatenate-fmp4';
};

type TranscodeAudioToMp3Plan = ExecutablePlanBase & {
  type: 'transcode-audio-to-mp3';
  audioEncoder: 'libmp3lame';
};

type PassthroughPlan = ExecutablePlanBase & {
  type: 'passthrough';
};

type UnsupportedReason =
  | 'drm-protected'
  | 'missing-required-track'
  | 'unsupported-input-container'
  | 'unsupported-video-codec'
  | 'unsupported-audio-codec'
  | 'incompatible-output-container'
  | 'missing-decoder';

type UnsupportedPlan = {
  type: 'unsupported';
  reason: UnsupportedReason;
  message: string;
};

type MediaProcessingPlan =
  | CopyToMp4Plan
  | CopyToWebmPlan
  | ConcatenateFmp4Plan
  | TranscodeAudioToMp3Plan
  | PassthroughPlan
  | UnsupportedPlan;

type ExecutableMuxPlan = CopyToMp4Plan | CopyToWebmPlan | TranscodeAudioToMp3Plan;

const outputFor = (container: OutputContainer): PlanOutput => {
  if (container === 'mp4') return { container, extension: '.mp4', mime: 'video/mp4' };
  if (container === 'webm') return { container, extension: '.webm', mime: 'video/webm' };
  return { container, extension: '.mp3', mime: 'audio/mpeg' };
};

const unsupported = (reason: UnsupportedReason, message: string): UnsupportedPlan => ({
  type: 'unsupported',
  reason,
  message,
});

const trackOfType = (descriptor: MediaDescriptor, type: MediaTrackType): MediaTrack | undefined =>
  descriptor.tracks.find(track => track.type === type);

const supports = <T>(values: readonly T[], value: T): boolean => values.includes(value);

const planMediaProcessing = (
  descriptor: MediaDescriptor,
  requestedOutput: 'media' | 'mp3',
  capabilities: MediaCapabilities = WEB_MEDIA_REMUX_CAPABILITIES,
): MediaProcessingPlan => {
  if (descriptor.encryption === 'drm') {
    return unsupported('drm-protected', 'DRM-protected media cannot be processed');
  }

  const video = trackOfType(descriptor, 'video');
  const audio = trackOfType(descriptor, 'audio');

  if (requestedOutput === 'mp3') {
    if (!audio) return unsupported('missing-required-track', 'An audio track is required for MP3 output');
    if (!supports(capabilities.decoders, audio.codec)) {
      return unsupported('missing-decoder', `The ${audio.codec} audio track cannot be decoded for MP3 output`);
    }
    if (!supports(capabilities.encoders, 'mp3') || !supports(capabilities.muxers, 'mp3')) {
      return unsupported('incompatible-output-container', 'The active media engine cannot produce MP3 output');
    }
    return {
      type: 'transcode-audio-to-mp3',
      output: outputFor('mp3'),
      requiredTracks: [{ type: 'audio', codec: 'mp3' }],
      prefetchToOpfs: descriptor.inputKind !== 'dash',
      audioEncoder: 'libmp3lame',
    };
  }

  if (!video) return unsupported('missing-required-track', 'A video track is required for media output');
  if (!supports(capabilities.parsers, video.codec)) {
    return unsupported('unsupported-video-codec', `The ${video.codec} video track is not supported`);
  }
  if (audio && !supports(capabilities.parsers, audio.codec)) {
    return unsupported('unsupported-audio-codec', `The ${audio.codec} audio track is not supported`);
  }
  if (!supports(capabilities.demuxers, descriptor.container)) {
    return unsupported('unsupported-input-container', `The ${descriptor.container} input container is not supported`);
  }

  const requiredTracks = descriptor.tracks.map(({ type, codec }) => ({ type, codec }));
  if (video.codec === 'vp9' && (!audio || audio.codec === 'opus') && descriptor.container === 'webm') {
    if (!supports(capabilities.muxers, 'webm')) {
      return unsupported('incompatible-output-container', 'The active media engine cannot produce WebM output');
    }
    return {
      type: 'copy-to-webm',
      output: outputFor('webm'),
      requiredTracks,
      prefetchToOpfs: descriptor.inputKind === 'separate-tracks',
    };
  }

  if (!['h264', 'hevc', 'av1'].includes(video.codec) || (audio && audio.codec !== 'aac')) {
    return unsupported('incompatible-output-container', 'The input tracks cannot be copied into MP4');
  }
  if (!supports(capabilities.muxers, 'mp4')) {
    return unsupported('incompatible-output-container', 'The active media engine cannot produce MP4 output');
  }

  if (descriptor.inputKind === 'direct' && descriptor.container === 'mp4') {
    return {
      type: 'passthrough',
      output: outputFor('mp4'),
      requiredTracks,
      prefetchToOpfs: true,
    };
  }
  if (descriptor.inputKind === 'hls' && descriptor.container === 'mp4' && descriptor.hasInitializationSegment) {
    return {
      type: 'concatenate-fmp4',
      output: outputFor('mp4'),
      requiredTracks,
      prefetchToOpfs: true,
    };
  }
  return {
    type: 'copy-to-mp4',
    output: outputFor('mp4'),
    requiredTracks,
    prefetchToOpfs: descriptor.inputKind === 'hls' || descriptor.inputKind === 'separate-tracks',
    videoTag: video.codec === 'hevc' ? 'hvc1' : undefined,
  };
};

type PlanInput = {
  urls: string[];
  formatHint?: 'hls' | 'dash';
};

const buildMediaProcessingArgs = (plan: ExecutableMuxPlan, input: PlanInput, outputName: string): string[] => {
  if (input.urls.length === 0) throw new Error('At least one media input is required');
  const args: string[] = [];
  for (const url of input.urls) {
    if (input.formatHint) args.push('-f', input.formatHint);
    args.push('-i', url);
  }

  if (plan.type === 'transcode-audio-to-mp3') {
    return [...args, '-vn', '-c:a', plan.audioEncoder, '-q:a', '2', '-y', outputName];
  }

  if (input.urls.length === 1) {
    args.push('-map', '0:v:0', '-map', '0:a:0?');
  } else {
    args.push('-map', '0:v:0?', '-map', '1:v:0?', '-map', '0:a:0?', '-map', '1:a:0?');
  }
  args.push('-c', 'copy');
  if (plan.type === 'copy-to-mp4' && plan.videoTag) args.push('-tag:v', plan.videoTag);
  return [...args, '-y', outputName];
};

const codecAliases: Record<string, MediaCodec> = {
  avc1: 'h264',
  avc3: 'h264',
  h264: 'h264',
  hev1: 'hevc',
  hvc1: 'hevc',
  hevc: 'hevc',
  av01: 'av1',
  mp4a: 'aac',
  aac: 'aac',
  vp09: 'vp9',
  vp9: 'vp9',
  opus: 'opus',
  mp3: 'mp3',
};

const normalizeCodec = (codecString: string | undefined): MediaCodec => {
  const normalized = codecString?.trim().toLowerCase();
  if (!normalized) return 'unknown';
  const prefix = normalized.split('.')[0];
  return codecAliases[prefix] ?? 'unknown';
};

const tracksFromCodecString = (codecString: string | undefined, source: MediaEvidence['source']): MediaTrack[] =>
  (codecString ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      const codec = normalizeCodec(value);
      const type: MediaTrackType = ['h264', 'hevc', 'av1', 'vp9'].includes(codec) ? 'video' : 'audio';
      return { type, codec, codecString: value, evidence: { source, confidence: 'declared' } };
    });

export {
  WEB_MEDIA_REMUX_CAPABILITIES,
  buildMediaProcessingArgs,
  normalizeCodec,
  planMediaProcessing,
  tracksFromCodecString,
};
export type {
  ConcatenateFmp4Plan,
  CopyToMp4Plan,
  CopyToWebmPlan,
  ExecutableMuxPlan,
  MediaCapabilities,
  MediaCodec,
  MediaContainer,
  MediaDescriptor,
  MediaEvidence,
  MediaInputKind,
  MediaProcessingPlan,
  MediaTrack,
  MediaTrackType,
  OutputContainer,
  PassthroughPlan,
  PlanInput,
  TranscodeAudioToMp3Plan,
  UnsupportedPlan,
  UnsupportedReason,
};
