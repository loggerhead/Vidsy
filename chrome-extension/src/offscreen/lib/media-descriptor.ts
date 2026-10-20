import { headersForFetch } from './hls-request';
import { parseHlsPlaylist } from './m3u8-parser';
import { normalizeCodec, tracksFromCodecString } from './media-processing';
import type { MediaCodec, MediaContainer, MediaDescriptor, MediaTrack } from './media-processing';

const PROBE_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

const verifiedTrack = (
  type: 'video' | 'audio',
  codec: MediaCodec,
  source: 'init-segment' | 'media-probe',
): MediaTrack => ({
  type,
  codec,
  evidence: { source, confidence: 'verified' },
});

const deduplicateTracks = (tracks: MediaTrack[]): MediaTrack[] => {
  const byType = new Map<string, MediaTrack>();
  for (const track of tracks) {
    const key = `${track.type}:${track.codec}`;
    if (!byType.has(key)) byType.set(key, track);
  }
  return [...byType.values()];
};

const codecStringsInBytes = (bytes: Uint8Array): MediaTrack[] => {
  const text = new TextDecoder('latin1').decode(bytes);
  const tracks: MediaTrack[] = [];
  if (/(?:avc1|avc3)/.test(text)) tracks.push(verifiedTrack('video', 'h264', 'init-segment'));
  if (/(?:hvc1|hev1)/.test(text)) tracks.push(verifiedTrack('video', 'hevc', 'init-segment'));
  if (/av01/.test(text)) tracks.push(verifiedTrack('video', 'av1', 'init-segment'));
  if (/vp09|V_VP9/.test(text)) tracks.push(verifiedTrack('video', 'vp9', 'init-segment'));
  if (/mp4a/.test(text)) tracks.push(verifiedTrack('audio', 'aac', 'init-segment'));
  if (/Opus|A_OPUS/.test(text)) tracks.push(verifiedTrack('audio', 'opus', 'init-segment'));
  return deduplicateTracks(tracks);
};

const parsePatPmtPid = (payload: Uint8Array): number | undefined => {
  const pointer = payload[0] ?? 0;
  const section = payload.subarray(pointer + 1);
  if (section[0] !== 0x00 || section.length < 12) return undefined;
  const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
  const end = Math.min(section.length - 4, 3 + sectionLength - 4);
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    const programNumber = (section[offset] << 8) | section[offset + 1];
    if (programNumber !== 0) return ((section[offset + 2] & 0x1f) << 8) | section[offset + 3];
  }
  return undefined;
};

const parsePmtTracks = (payload: Uint8Array): MediaTrack[] => {
  const pointer = payload[0] ?? 0;
  const section = payload.subarray(pointer + 1);
  if (section[0] !== 0x02 || section.length < 16) return [];
  const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
  const end = Math.min(section.length - 4, 3 + sectionLength - 4);
  const tracks: MediaTrack[] = [];
  for (let offset = 12 + programInfoLength; offset + 5 <= end; ) {
    const streamType = section[offset];
    if (streamType === 0x1b) tracks.push(verifiedTrack('video', 'h264', 'media-probe'));
    else if (streamType === 0x24) tracks.push(verifiedTrack('video', 'hevc', 'media-probe'));
    else if (streamType === 0x0f || streamType === 0x11) tracks.push(verifiedTrack('audio', 'aac', 'media-probe'));
    else if (streamType === 0x03 || streamType === 0x04) tracks.push(verifiedTrack('audio', 'mp3', 'media-probe'));
    const esInfoLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];
    offset += 5 + esInfoLength;
  }
  return tracks;
};

const tsPayload = (packet: Uint8Array): { pid: number; unitStart: boolean; payload?: Uint8Array } | undefined => {
  if (packet.length !== 188 || packet[0] !== 0x47) return undefined;
  const pid = ((packet[1] & 0x1f) << 8) | packet[2];
  const unitStart = Boolean(packet[1] & 0x40);
  const adaptation = (packet[3] >> 4) & 0x03;
  if (adaptation === 0 || adaptation === 2) return { pid, unitStart };
  let offset = 4;
  if (adaptation === 3) offset += 1 + packet[4];
  if (offset >= packet.length) return { pid, unitStart };
  return { pid, unitStart, payload: packet.subarray(offset) };
};

const probeMpegTs = (bytes: Uint8Array): MediaTrack[] => {
  let pmtPid: number | undefined;
  for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
    const packet = tsPayload(bytes.subarray(offset, offset + 188));
    if (!packet?.payload || !packet.unitStart) continue;
    if (packet.pid === 0) pmtPid = parsePatPmtPid(packet.payload) ?? pmtPid;
    if (pmtPid !== undefined && packet.pid === pmtPid) {
      const tracks = parsePmtTracks(packet.payload);
      if (tracks.length > 0) return deduplicateTracks(tracks);
    }
  }
  return [];
};

const probeMediaBytes = (
  bytes: Uint8Array,
): { container: MediaContainer; tracks: MediaTrack[]; hasInitializationSegment: boolean } => {
  if (bytes.length >= 188 && bytes[0] === 0x47) {
    return { container: 'mpegts', tracks: probeMpegTs(bytes), hasInitializationSegment: false };
  }
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (text.includes('ftyp') || text.includes('moov') || text.includes('styp')) {
    return { container: 'mp4', tracks: codecStringsInBytes(bytes), hasInitializationSegment: true };
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { container: 'webm', tracks: codecStringsInBytes(bytes), hasInitializationSegment: true };
  }
  if (text.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return {
      container: 'mp3',
      tracks: [verifiedTrack('audio', 'mp3', 'media-probe')],
      hasInitializationSegment: false,
    };
  }
  if (text.startsWith('RIFF') && text.includes('WAVE')) {
    return {
      container: 'wav',
      tracks: [verifiedTrack('audio', 'pcm', 'media-probe')],
      hasInitializationSegment: false,
    };
  }
  return { container: 'unknown', tracks: [], hasInitializationSegment: false };
};

const readBoundedFileProbe = async (file: Blob): Promise<ReturnType<typeof probeMediaBytes>> => {
  if (file.size <= PROBE_BYTES) {
    return probeMediaBytes(new Uint8Array(await file.arrayBuffer()));
  }
  const halfBudget = Math.floor(PROBE_BYTES / 2);
  const [head, tail] = await Promise.all([
    file.slice(0, halfBudget).arrayBuffer(),
    file.slice(file.size - halfBudget).arrayBuffer(),
  ]);
  const bytes = new Uint8Array(PROBE_BYTES);
  bytes.set(new Uint8Array(head));
  bytes.set(new Uint8Array(tail), halfBudget);
  return probeMediaBytes(bytes);
};

const fetchBoundedProbe = async (
  url: string,
  headers?: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  range?: { start: number; end: number },
): Promise<Uint8Array> => {
  const start = range?.start ?? 0;
  const end = Math.min(range?.end ?? PROBE_BYTES - 1, start + PROBE_BYTES - 1);
  const response = await fetchImpl(url, {
    headers: { ...headersForFetch(headers, url), Range: `bytes=${start}-${end}` },
    credentials: 'include',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 206) throw new Error(`Media probe failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > PROBE_BYTES) {
    await response.body?.cancel();
    throw new Error(`Media probe exceeded ${PROBE_BYTES} bytes`);
  }
  if (!response.body) throw new Error('Media probe returned no body');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.slice(0, PROBE_BYTES - size);
      parts.push(part);
      size += part.byteLength;
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

const hlsEncryption = (manifestText: string): MediaDescriptor['encryption'] => {
  if (/METHOD=(?:SAMPLE-AES|SAMPLE-AES-CTR)|KEYFORMAT=/i.test(manifestText)) return 'drm';
  if (/METHOD=AES-128/i.test(manifestText)) return 'aes-128';
  if (/METHOD=NONE/i.test(manifestText) || !/#EXT-X-KEY:/i.test(manifestText)) return 'none';
  return 'unknown';
};

const describeHls = async (args: {
  manifestText: string;
  manifestUrl: string;
  declaredCodecs?: string;
  headers?: Record<string, string>;
  durationSeconds?: number;
  fetchImpl?: typeof fetch;
  authorizeUrl?: (url: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<MediaDescriptor> => {
  const parsed = parseHlsPlaylist(args.manifestText, args.manifestUrl);
  const declaredTracks = tracksFromCodecString(args.declaredCodecs, 'manifest');
  const probeUrl = parsed.mapUrl ?? parsed.segments[0]?.url;
  let probe = { container: 'unknown' as MediaContainer, tracks: [] as MediaTrack[], hasInitializationSegment: false };
  if (probeUrl) {
    await args.authorizeUrl?.(probeUrl);
    const bytes = await fetchBoundedProbe(
      probeUrl,
      args.headers,
      args.fetchImpl,
      args.signal,
      parsed.mapUrl ? parsed.mapRange : parsed.segments[0]?.range,
    );
    probe = probeMediaBytes(bytes);
  }
  return {
    inputKind: 'hls',
    container: parsed.mapUrl ? 'mp4' : probe.container,
    tracks: probe.tracks.length > 0 ? probe.tracks : declaredTracks,
    encryption: hlsEncryption(args.manifestText),
    hasInitializationSegment: Boolean(parsed.mapUrl),
    durationSeconds: args.durationSeconds,
  };
};

const tracksFromDashDocument = (document: Document): MediaTrack[] => {
  const tracks: MediaTrack[] = [];
  for (const representation of Array.from(document.querySelectorAll('Representation'))) {
    const adaptation = representation.closest('AdaptationSet');
    const contentType = representation.getAttribute('contentType') ?? adaptation?.getAttribute('contentType') ?? '';
    const codecString = representation.getAttribute('codecs') ?? adaptation?.getAttribute('codecs') ?? undefined;
    const codec = normalizeCodec(codecString);
    const type = contentType.includes('audio') ? 'audio' : contentType.includes('video') ? 'video' : undefined;
    if (type && codec !== 'unknown') {
      tracks.push({ type, codec, codecString, evidence: { source: 'manifest', confidence: 'declared' } });
    }
  }
  return deduplicateTracks(tracks);
};

const describeDash = (manifestXml: string, durationSeconds?: number): MediaDescriptor => {
  const document = new DOMParser().parseFromString(manifestXml, 'application/xml');
  return {
    inputKind: 'dash',
    container: 'mp4',
    tracks: tracksFromDashDocument(document),
    encryption: document.querySelector('ContentProtection') ? 'drm' : 'none',
    hasInitializationSegment: Boolean(document.querySelector('Initialization, SegmentTemplate[initialization]')),
    durationSeconds,
  };
};

const describeDirectFile = async (
  file: Blob,
  inputKind: 'direct' | 'separate-tracks',
  declaredCodecs?: string,
): Promise<MediaDescriptor> => {
  const probe = await readBoundedFileProbe(file);
  const declaredTracks = tracksFromCodecString(declaredCodecs, 'content-type');
  return {
    inputKind,
    container: probe.container,
    tracks: probe.tracks.length > 0 ? probe.tracks : declaredTracks,
    encryption: 'none',
    hasInitializationSegment: probe.hasInitializationSegment,
    totalBytes: file.size,
  };
};

const mergeTrackDescriptors = (descriptors: MediaDescriptor[]): MediaDescriptor => ({
  inputKind: 'separate-tracks',
  container: descriptors.every(item => item.container === 'webm') ? 'webm' : 'mp4',
  tracks: deduplicateTracks(descriptors.flatMap(item => item.tracks)),
  encryption: descriptors.some(item => item.encryption === 'drm') ? 'drm' : 'none',
  hasInitializationSegment: descriptors.some(item => item.hasInitializationSegment),
  totalBytes: descriptors.reduce((total, item) => total + (item.totalBytes ?? 0), 0),
});

export {
  describeDash,
  describeDirectFile,
  describeHls,
  mergeTrackDescriptors,
  probeMediaBytes,
  probeMpegTs,
  readBoundedFileProbe,
};
