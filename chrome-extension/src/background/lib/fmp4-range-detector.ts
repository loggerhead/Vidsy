import { injectHeadersForDownload, removeHeadersForDownload } from './header-capture';
import type { MediaItem, MediaVariant } from '@extension/shared';

type ByteRange = {
  start: number;
  end: number;
  total: number;
};

type Fmp4TrackKind = 'video' | 'audio';

type Fmp4TrackInfo = {
  kind: Fmp4TrackKind;
  codecs?: string;
  width?: number;
  height?: number;
};

type Fmp4Stream = {
  url: string;
  mimeType?: string;
  contentLength?: number;
  codecs?: string;
  resolution?: { width: number; height: number };
  detectedAt: number;
};

type Fmp4Group = {
  pageUrl?: string;
  title?: string;
  videos: Map<string, Fmp4Stream>;
  audios: Map<string, Fmp4Stream>;
};

type Fmp4Detection = {
  handled: boolean;
  candidate?: Partial<MediaItem> & { url: string };
};

const MAX_INIT_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 8000;
const GROUP_TTL_MS = 2 * 60 * 1000;

const groupsByTab = new Map<string, Map<string, Fmp4Group>>();
// Probe identity belongs to a tab/document lifecycle. Keeping one process-wide
// set makes a reload miss a reused signed URL even after its groups were
// cleared, recreating the same "only MSE remains" failure as a late start.
const probedUrlsByTab = new Map<string, Set<string>>();

const contentRangeHeader = (headers?: chrome.webRequest.HttpHeader[]): string | undefined =>
  headers?.find(h => h.name.toLowerCase() === 'content-range')?.value;

const parseContentRange = (value: string | undefined): ByteRange | undefined => {
  if (!value) return undefined;
  const match = value.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isFinite)) return undefined;
  if (start < 0 || end < start || total <= end) return undefined;
  return { start, end, total };
};

const readAscii = (bytes: Uint8Array, offset: number, length: number): string => {
  if (offset < 0 || offset + length > bytes.length) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
};

const readU32 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
};

const readU64Safe = (bytes: Uint8Array, offset: number): number => {
  const high = readU32(bytes, offset);
  const low = readU32(bytes, offset + 4);
  return high * 0x100000000 + low;
};

const boxEnd = (
  bytes: Uint8Array,
  offset: number,
  limit: number,
): { type: string; start: number; end: number } | null => {
  if (offset + 8 > limit) return null;
  let size = readU32(bytes, offset);
  const type = readAscii(bytes, offset + 4, 4);
  let header = 8;
  if (!type.trim()) return null;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const wideSize = readU64Safe(bytes, offset + 8);
    if (!Number.isSafeInteger(wideSize)) return null;
    size = wideSize;
    header = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < header || offset + size > limit) return null;
  return { type, start: offset + header, end: offset + size };
};

const findChild = (bytes: Uint8Array, start: number, end: number, wanted: string) => {
  for (let off = start; off + 8 <= end; ) {
    const box = boxEnd(bytes, off, end);
    if (!box) break;
    if (box.type === wanted) return box;
    off = box.end;
  }
  return null;
};

const codecFromStsd = (bytes: Uint8Array, stsdStart: number, stsdEnd: number): string | undefined => {
  // FullBox header (4) + entry_count (4), then sample entries.
  let off = stsdStart + 8;
  while (off + 8 <= stsdEnd) {
    const box = boxEnd(bytes, off, stsdEnd);
    if (!box) break;
    if (box.type) return box.type;
    off = box.end;
  }
  return undefined;
};

const parseTkhdResolution = (
  bytes: Uint8Array,
  tkhdStart: number,
  tkhdEnd: number,
): { width: number; height: number } | undefined => {
  if (tkhdEnd - tkhdStart < 8) return undefined;
  const widthRaw = readU32(bytes, tkhdEnd - 8);
  const heightRaw = readU32(bytes, tkhdEnd - 4);
  const width = Math.round(widthRaw / 65536);
  const height = Math.round(heightRaw / 65536);
  if (width > 0 && height > 0) return { width, height };
  return undefined;
};

const parseTrack = (bytes: Uint8Array, trakStart: number, trakEnd: number): Fmp4TrackInfo | null => {
  const mdia = findChild(bytes, trakStart, trakEnd, 'mdia');
  if (!mdia) return null;
  const hdlr = findChild(bytes, mdia.start, mdia.end, 'hdlr');
  if (!hdlr) return null;
  const handlerType = readAscii(bytes, hdlr.start + 8, 4);
  const kind: Fmp4TrackKind | undefined =
    handlerType === 'vide' ? 'video' : handlerType === 'soun' ? 'audio' : undefined;
  if (!kind) return null;

  const minf = findChild(bytes, mdia.start, mdia.end, 'minf');
  const stbl = minf ? findChild(bytes, minf.start, minf.end, 'stbl') : null;
  const stsd = stbl ? findChild(bytes, stbl.start, stbl.end, 'stsd') : null;
  const codec = stsd ? codecFromStsd(bytes, stsd.start, stsd.end) : undefined;
  const tkhd = findChild(bytes, trakStart, trakEnd, 'tkhd');
  const resolution = kind === 'video' && tkhd ? parseTkhdResolution(bytes, tkhd.start, tkhd.end) : undefined;

  return {
    kind,
    codecs: codec,
    width: resolution?.width,
    height: resolution?.height,
  };
};

const parseFmp4Tracks = (buffer: ArrayBuffer): Fmp4TrackInfo[] => {
  const bytes = new Uint8Array(buffer);
  const moov = findChild(bytes, 0, bytes.length, 'moov');
  if (!moov) return [];
  const tracks: Fmp4TrackInfo[] = [];
  for (let off = moov.start; off + 8 <= moov.end; ) {
    const box = boxEnd(bytes, off, moov.end);
    if (!box) break;
    if (box.type === 'trak') {
      const track = parseTrack(bytes, box.start, box.end);
      if (track) tracks.push(track);
    }
    off = box.end;
  }
  return tracks;
};

const parseFmp4InitSegment = (buffer: ArrayBuffer): Fmp4TrackInfo | null => parseFmp4Tracks(buffer)[0] ?? null;

const fetchInitSegment = async (
  url: string,
  byteRange: ByteRange,
  headers: Record<string, string> | undefined,
  dnrKey: string,
): Promise<ArrayBuffer | null> => {
  const end = Math.min(byteRange.end, MAX_INIT_BYTES - 1);
  try {
    if (headers && Object.keys(headers).length > 0) await injectHeadersForDownload(url, headers, dnrKey);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: `bytes=0-${end}` },
      credentials: 'include',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 206) return null;
    const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType && !contentType.includes('mp4') && !contentType.includes('octet-stream')) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  } finally {
    if (headers && Object.keys(headers).length > 0) await removeHeadersForDownload(dnrKey);
  }
};

const groupKeyFor = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return undefined;
    parts.pop();
    // Do not include origin: adaptive tracks for the same asset are often
    // served from different CDN hostnames while keeping the same path layout.
    return `/${parts.join('/')}`;
  } catch {
    return undefined;
  }
};

const codecRank = (stream: Fmp4Stream): number => {
  const codec = stream.codecs?.toLowerCase() ?? '';
  if (codec.startsWith('avc1')) return 0;
  if (codec.startsWith('mp4a')) return 0;
  if (codec.startsWith('hvc1') || codec.startsWith('hev1')) return 1;
  if (codec.startsWith('av01')) return 2;
  return 3;
};

const videoSort = (a: Fmp4Stream, b: Fmp4Stream): number => {
  const aH = a.resolution?.height ?? 0;
  const bH = b.resolution?.height ?? 0;
  if (aH !== bH) return bH - aH;
  const codec = codecRank(a) - codecRank(b);
  if (codec !== 0) return codec;
  return (b.contentLength ?? 0) - (a.contentLength ?? 0);
};

const audioSort = (a: Fmp4Stream, b: Fmp4Stream): number => {
  const codec = codecRank(a) - codecRank(b);
  if (codec !== 0) return codec;
  return (b.contentLength ?? 0) - (a.contentLength ?? 0);
};

const buildCandidate = (group: Fmp4Group): (Partial<MediaItem> & { url: string }) | undefined => {
  const videos = [...group.videos.values()].sort(videoSort);
  const audios = [...group.audios.values()].sort(audioSort);
  if (videos.length === 0) return undefined;

  const audio = audios[0];
  const variants: MediaVariant[] = videos.map(video => ({
    url: video.url,
    codecs: video.codecs,
    resolution: video.resolution,
    contentLength: video.contentLength,
    audioUrl: audio?.url,
    audioMimeType: audio?.mimeType,
  }));
  const primary = videos[0];

  return {
    url: primary.url,
    kind: 'video',
    mimeType: primary.mimeType,
    source: 'network',
    title: group.title,
    contentLength: primary.contentLength,
    resolution: primary.resolution,
    variants,
    audioUrl: audio?.url,
    audioMimeType: audio?.mimeType,
    detectedAt: Math.min(...videos.map(v => v.detectedAt), ...audios.map(a => a.detectedAt)),
  };
};

const cleanupOldGroups = (now: number) => {
  for (const [tabKey, groups] of groupsByTab) {
    for (const [key, group] of groups) {
      const latest = Math.max(
        0,
        ...[...group.videos.values(), ...group.audios.values()].map(stream => stream.detectedAt),
      );
      if (latest > 0 && now - latest > GROUP_TTL_MS) groups.delete(key);
    }
    if (groups.size === 0) groupsByTab.delete(tabKey);
  }
};

const handleFmp4RangeDetection = async (args: {
  url: string;
  tabId?: number;
  pageUrl?: string;
  title?: string;
  responseHeaders?: chrome.webRequest.HttpHeader[];
  requestHeaders?: Record<string, string>;
  mimeType?: string;
}): Promise<Fmp4Detection> => {
  const byteRange = parseContentRange(contentRangeHeader(args.responseHeaders));
  if (!byteRange || byteRange.start !== 0) return { handled: false };
  const tabKey = args.tabId !== undefined ? String(args.tabId) : 'unknown';
  const probedUrls = probedUrlsByTab.get(tabKey) ?? new Set<string>();
  if (!probedUrlsByTab.has(tabKey)) probedUrlsByTab.set(tabKey, probedUrls);
  if (probedUrls.has(args.url)) return { handled: true };

  const key = groupKeyFor(args.url);
  if (!key) return { handled: false };
  probedUrls.add(args.url);

  const dnrKey = `fmp4-probe:${args.tabId ?? 'unknown'}:${crypto.randomUUID?.() ?? Math.random().toString(36)}`;
  const initSegment = await fetchInitSegment(args.url, byteRange, args.requestHeaders, dnrKey);
  if (!initSegment) {
    probedUrls.delete(args.url);
    return { handled: false };
  }

  const tracks = parseFmp4Tracks(initSegment);
  if (tracks.length === 0) {
    probedUrls.delete(args.url);
    return { handled: false };
  }
  const videoTrack = tracks.find(track => track.kind === 'video');
  const audioTrack = tracks.find(track => track.kind === 'audio');

  // A file containing both track kinds is a complete media authority. It is
  // not a fragment waiting to be paired with another URL.
  if (videoTrack && audioTrack) {
    return {
      handled: true,
      candidate: {
        url: args.url,
        kind: 'video',
        mimeType: 'video/mp4',
        source: 'network',
        title: args.title,
        contentLength: byteRange.total,
        resolution:
          videoTrack.width && videoTrack.height ? { width: videoTrack.width, height: videoTrack.height } : undefined,
        detectedAt: Date.now(),
      },
    };
  }

  const track = tracks[0];

  const groups = groupsByTab.get(tabKey) ?? new Map<string, Fmp4Group>();
  if (!groupsByTab.has(tabKey)) groupsByTab.set(tabKey, groups);

  const group = groups.get(key) ?? { pageUrl: args.pageUrl, title: args.title, videos: new Map(), audios: new Map() };
  groups.set(key, group);
  if (args.pageUrl) group.pageUrl = args.pageUrl;
  if (args.title) group.title = args.title;

  const stream: Fmp4Stream = {
    url: args.url,
    // The parsed MP4 handler is stronger evidence than the HTTP Content-Type.
    // CDNs commonly serve both .m4s tracks as application/octet-stream (or
    // even label audio as video), which must not leak into download planning.
    mimeType: track.kind === 'audio' ? 'audio/mp4' : 'video/mp4',
    contentLength: byteRange.total,
    codecs: track.codecs,
    resolution: track.width && track.height ? { width: track.width, height: track.height } : undefined,
    detectedAt: Date.now(),
  };

  if (track.kind === 'video') group.videos.set(args.url, stream);
  else group.audios.set(args.url, stream);

  cleanupOldGroups(Date.now());
  return { handled: true, candidate: buildCandidate(group) };
};

const clearFmp4RangeDetectionsForTab = (tabId: number) => {
  const tabKey = String(tabId);
  groupsByTab.delete(tabKey);
  probedUrlsByTab.delete(tabKey);
};

export { clearFmp4RangeDetectionsForTab, handleFmp4RangeDetection, parseFmp4InitSegment };
