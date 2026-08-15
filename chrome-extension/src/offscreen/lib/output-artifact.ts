import type {
  MediaCodec,
  MediaTrackType,
  OutputContainer,
  PassthroughPlan,
  ConcatenateFmp4Plan,
  ExecutableMuxPlan,
} from './media-processing';

type ArtifactPlan = ExecutableMuxPlan | PassthroughPlan | ConcatenateFmp4Plan;

type OutputTrack = {
  type: MediaTrackType;
  codec: MediaCodec;
};

type OutputArtifact = {
  opfsName: string;
  size: number;
  container: OutputContainer;
  extension: '.mp4' | '.webm' | '.mp3';
  mime: 'video/mp4' | 'video/webm' | 'audio/mpeg';
  tracks: OutputTrack[];
  durationSeconds?: number;
  planType: ArtifactPlan['type'];
};

type ProbeResult = {
  container: OutputContainer;
  tracks: OutputTrack[];
  durationSeconds?: number;
};

const textDecoder = new TextDecoder('latin1');

const readBytes = async (file: Blob, start: number, length: number): Promise<Uint8Array> =>
  new Uint8Array(await file.slice(start, start + length).arrayBuffer());

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  textDecoder.decode(bytes.subarray(start, start + length));

const u32 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;

const u64 = (bytes: Uint8Array, offset: number): number => u32(bytes, offset) * 0x100000000 + u32(bytes, offset + 4);

type Mp4Box = {
  type: string;
  start: number;
  headerSize: number;
  size: number;
};

const mp4Boxes = (bytes: Uint8Array, start = 0, end = bytes.byteLength): Mp4Box[] => {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) throw new Error('Output MP4 has a truncated box header');
    let size = u32(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (end - offset < 16) throw new Error('Output MP4 has a truncated large box header');
      size = u64(bytes, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) {
      throw new Error(`Output MP4 has an invalid ${type || 'unknown'} box`);
    }
    boxes.push({ type, start: offset, headerSize, size });
    offset += size;
  }
  return boxes;
};

const childBox = (bytes: Uint8Array, parent: Mp4Box, type: string): Mp4Box | undefined =>
  mp4Boxes(bytes, parent.start + parent.headerSize, parent.start + parent.size).find(box => box.type === type);

const mp4Duration = (bytes: Uint8Array, moov: Mp4Box): number | undefined => {
  const mvhd = childBox(bytes, moov, 'mvhd');
  if (!mvhd) return undefined;
  const body = mvhd.start + mvhd.headerSize;
  const version = bytes[body];
  const timescaleOffset = body + (version === 1 ? 20 : 12);
  const durationOffset = timescaleOffset + 4;
  if (durationOffset + (version === 1 ? 8 : 4) > mvhd.start + mvhd.size) return undefined;
  const timescale = u32(bytes, timescaleOffset);
  const duration = version === 1 ? u64(bytes, durationOffset) : u32(bytes, durationOffset);
  return timescale > 0 && duration > 0 ? duration / timescale : undefined;
};

const mp4Track = (bytes: Uint8Array, trak: Mp4Box): OutputTrack | undefined => {
  const mdia = childBox(bytes, trak, 'mdia');
  if (!mdia) return undefined;
  const hdlr = childBox(bytes, mdia, 'hdlr');
  const minf = childBox(bytes, mdia, 'minf');
  const stbl = minf ? childBox(bytes, minf, 'stbl') : undefined;
  const stsd = stbl ? childBox(bytes, stbl, 'stsd') : undefined;
  if (!hdlr || !stsd) return undefined;
  const handler = ascii(bytes, hdlr.start + hdlr.headerSize + 8, 4);
  const type: MediaTrackType | undefined = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : undefined;
  const sampleEntry = ascii(bytes, stsd.start + stsd.headerSize + 12, 4);
  const codec: MediaCodec =
    sampleEntry === 'avc1' || sampleEntry === 'avc3'
      ? 'h264'
      : sampleEntry === 'hvc1' || sampleEntry === 'hev1'
        ? 'hevc'
        : sampleEntry === 'mp4a'
          ? 'aac'
          : 'unknown';
  return type ? { type, codec } : undefined;
};

const probeMp4 = async (file: Blob): Promise<ProbeResult> => {
  const header = await readBytes(file, 0, Math.min(file.size, 16));
  if (header.byteLength < 8 || ascii(header, 4, 4) !== 'ftyp') throw new Error('Output is not an MP4 file');

  let offset = 0;
  let moovBytes: Uint8Array | undefined;
  let sawMediaData = false;
  while (offset < file.size) {
    const boxHeader = await readBytes(file, offset, Math.min(16, file.size - offset));
    if (boxHeader.byteLength < 8) throw new Error('Output MP4 ends with a truncated box header');
    let size = u32(boxHeader, 0);
    const type = ascii(boxHeader, 4, 4);
    if (size === 1) {
      if (boxHeader.byteLength < 16) throw new Error('Output MP4 has a truncated large box header');
      size = u64(boxHeader, 8);
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (!Number.isSafeInteger(size) || size < 8 || offset + size > file.size) {
      throw new Error(`Output MP4 has an invalid ${type || 'unknown'} box`);
    }
    if (type === 'moov') moovBytes = await readBytes(file, offset, size);
    if (type === 'mdat') sawMediaData = true;
    offset += size;
  }
  if (!moovBytes) throw new Error('Output MP4 is missing movie metadata');
  if (!sawMediaData) throw new Error('Output MP4 is missing media data');

  const moov = mp4Boxes(moovBytes).find(box => box.type === 'moov');
  if (!moov) throw new Error('Output MP4 movie metadata is malformed');
  const tracks = mp4Boxes(moovBytes, moov.headerSize, moov.size)
    .filter(box => box.type === 'trak')
    .map(box => mp4Track(moovBytes, box))
    .filter((track): track is OutputTrack => Boolean(track));
  return { container: 'mp4', tracks, durationSeconds: mp4Duration(moovBytes, moov) };
};

const probeWebm = async (file: Blob): Promise<ProbeResult> => {
  const bytes = await readBytes(file, 0, Math.min(file.size, 1024 * 1024));
  if (bytes.byteLength < 4 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
    throw new Error('Output is not a WebM file');
  }
  const text = textDecoder.decode(bytes);
  if (!text.includes('webm')) throw new Error('Output EBML document is not WebM');
  if (
    !bytes.some(
      (value, index) =>
        value === 0x1f && bytes[index + 1] === 0x43 && bytes[index + 2] === 0xb6 && bytes[index + 3] === 0x75,
    )
  ) {
    throw new Error('Output WebM is missing media clusters');
  }
  const tracks: OutputTrack[] = [];
  if (text.includes('V_VP9')) tracks.push({ type: 'video', codec: 'vp9' });
  if (text.includes('A_OPUS')) tracks.push({ type: 'audio', codec: 'opus' });
  return { container: 'webm', tracks };
};

const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_SAMPLE_RATES = [44100, 48000, 32000];

const mp3Frame = (bytes: Uint8Array, offset: number): { bitrate: number; sampleRate: number } | undefined => {
  if (offset + 4 > bytes.byteLength || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xfe) !== 0xfa) return undefined;
  const bitrate = MP3_BITRATES[(bytes[offset + 2] >> 4) & 0x0f];
  const sampleRate = MP3_SAMPLE_RATES[(bytes[offset + 2] >> 2) & 0x03];
  return bitrate && sampleRate ? { bitrate: bitrate * 1000, sampleRate } : undefined;
};

const probeMp3 = async (file: Blob): Promise<ProbeResult> => {
  const bytes = await readBytes(file, 0, Math.min(file.size, 128 * 1024));
  let offset = 0;
  if (ascii(bytes, 0, 3) === 'ID3' && bytes.byteLength >= 10) {
    offset = 10 + ((bytes[6] & 0x7f) << 21) + ((bytes[7] & 0x7f) << 14) + ((bytes[8] & 0x7f) << 7) + (bytes[9] & 0x7f);
  }
  let frame: ReturnType<typeof mp3Frame>;
  for (; offset + 4 <= bytes.byteLength; offset++) {
    frame = mp3Frame(bytes, offset);
    if (frame) break;
  }
  if (!frame) throw new Error('Output is not a valid MP3 stream');
  const durationSeconds = ((file.size - offset) * 8) / frame.bitrate;
  return { container: 'mp3', tracks: [{ type: 'audio', codec: 'mp3' }], durationSeconds };
};

const probeOutput = async (file: Blob, container: OutputContainer): Promise<ProbeResult> => {
  if (container === 'mp4') return probeMp4(file);
  if (container === 'webm') return probeWebm(file);
  return probeMp3(file);
};

const deduplicateTracks = (tracks: OutputTrack[]): OutputTrack[] => {
  const unique = new Map(tracks.map(track => [`${track.type}:${track.codec}`, track]));
  return [...unique.values()];
};

const validateOutputArtifact = async (args: {
  file: File;
  opfsName: string;
  plan: ArtifactPlan;
  expectedDurationSeconds?: number;
}): Promise<OutputArtifact> => {
  if (!Number.isFinite(args.file.size) || args.file.size <= 0) throw new Error('Output artifact is empty');
  const probe = await probeOutput(args.file, args.plan.output.container);
  if (probe.container !== args.plan.output.container) {
    throw new Error(`Output container ${probe.container} does not match plan ${args.plan.output.container}`);
  }
  const tracks = deduplicateTracks(probe.tracks);
  for (const required of args.plan.requiredTracks) {
    if (!tracks.some(track => track.type === required.type && track.codec === required.codec)) {
      throw new Error(`Output artifact is missing required ${required.type} track ${required.codec}`);
    }
  }
  if (tracks.some(track => track.codec === 'unknown')) throw new Error('Output artifact contains an unknown codec');
  if (args.expectedDurationSeconds && args.expectedDurationSeconds > 0) {
    if (!probe.durationSeconds || probe.durationSeconds <= 0) {
      throw new Error('Output artifact has no verifiable duration');
    }
    const tolerance = Math.max(1, args.expectedDurationSeconds * 0.1);
    if (Math.abs(probe.durationSeconds - args.expectedDurationSeconds) > tolerance) {
      throw new Error(
        `Output duration ${probe.durationSeconds.toFixed(3)}s differs from expected ${args.expectedDurationSeconds.toFixed(3)}s`,
      );
    }
  }
  return {
    opfsName: args.opfsName,
    size: args.file.size,
    container: probe.container,
    extension: args.plan.output.extension,
    mime: args.plan.output.mime,
    tracks,
    durationSeconds: probe.durationSeconds,
    planType: args.plan.type,
  };
};

export { validateOutputArtifact };
export type { OutputArtifact, OutputTrack };
