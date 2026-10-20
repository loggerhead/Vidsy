import type { MediaItem, MediaVariant } from './media.js';

const sanitizeFileNamePart = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

type DownloadState = { busyUrl: string | null; error: string | null };

// Badge answers "how is this delivered?" (HTTP / HLS / DASH / MSS / MSE) rather
// than "what container?". Container is irrelevant since the downloader always
// muxes to MP4/MP3. `+A` appended when a separate audio track is paired with a
// video-only stream (Instagram-style delivery).
const mediaBadgeLabel = (item: Pick<MediaItem, 'kind' | 'audioUrl'>): string => {
  let base: string;
  switch (item.kind) {
    case 'hls':
      base = 'HLS';
      break;
    case 'dash':
      base = 'DASH';
      break;
    case 'mss':
      base = 'MSS';
      break;
    case 'mse':
      base = 'MSE';
      break;
    case 'subtitle':
      base = 'CC';
      break;
    case 'video':
    case 'audio':
      base = 'HTTP';
      break;
    default:
      base = 'FILE';
  }
  return item.kind === 'video' && item.audioUrl ? `${base}+A` : base;
};

const kindBadgeColor = (kind: MediaItem['kind'], isLight: boolean): string => {
  const map: Record<string, string> = {
    hls: isLight ? 'bg-white/50 text-blue-900 ring-1 ring-white/40' : 'bg-black/40 text-blue-200 ring-1 ring-white/15',
    video: isLight
      ? 'bg-white/50 text-violet-900 ring-1 ring-white/40'
      : 'bg-black/40 text-violet-200 ring-1 ring-white/15',
    audio: isLight
      ? 'bg-white/50 text-emerald-900 ring-1 ring-white/40'
      : 'bg-black/40 text-emerald-200 ring-1 ring-white/15',
    dash: isLight
      ? 'bg-white/50 text-amber-900 ring-1 ring-white/40'
      : 'bg-black/40 text-amber-200 ring-1 ring-white/15',
    mss: isLight ? 'bg-white/50 text-cyan-900 ring-1 ring-white/40' : 'bg-black/40 text-cyan-200 ring-1 ring-white/15',
    mse: isLight ? 'bg-white/50 text-rose-900 ring-1 ring-white/40' : 'bg-black/40 text-rose-200 ring-1 ring-white/15',
    subtitle: isLight
      ? 'bg-white/50 text-pink-900 ring-1 ring-white/40'
      : 'bg-black/40 text-pink-200 ring-1 ring-white/15',
    other: isLight
      ? 'bg-white/50 text-gray-800 ring-1 ring-white/40'
      : 'bg-black/40 text-gray-200 ring-1 ring-white/15',
  };
  return map[kind] ?? map.other;
};

const formatDuration = (secs: number): string => {
  if (!isFinite(secs) || secs <= 0) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const formatSpeed = (bps: number): string => {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
};

const formatDate = (ts: number): string => {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

const pickBestVariant = (variants: MediaVariant[]): MediaVariant | undefined =>
  variants.reduce<MediaVariant | undefined>((best, curr) => {
    if (!best) return curr;
    const bh = best.resolution?.height ?? 0;
    const ch = curr.resolution?.height ?? 0;
    if (ch !== bh) return ch > bh ? curr : best;
    return (curr.bandwidth ?? 0) > (best.bandwidth ?? 0) ? curr : best;
  }, undefined);

// Quality labels describe rendition tiers, not exact coded dimensions. Encoders
// frequently crop a few percent (1920×1018, 854×452) while the presentation is
// still conventionally called 1080p or 480p. Preserve unusual dimensions when
// they are not close to a standard tier; exact W×H remains visible in details.
const QUALITY_TIERS = [144, 240, 360, 480, 540, 720, 1080, 1440, 2160, 4320] as const;
const qualityLabel = (r: { width: number; height: number }): string => {
  const shortEdge = Math.min(r.width, r.height);
  const tier = QUALITY_TIERS.reduce((best, candidate) =>
    Math.abs(candidate - shortEdge) < Math.abs(best - shortEdge) ? candidate : best,
  );
  return `${Math.abs(tier - shortEdge) / tier <= 0.08 ? tier : Math.round(shortEdge)}p`;
};
const shortEdgeLabel = qualityLabel;

const formatFileSize = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
};

const variantLabel = (v: MediaVariant): string => {
  if (v.resolution) return shortEdgeLabel(v.resolution);
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)}k`;
  return v.name ?? 'Auto';
};

// "1920×1080 · 41.0 MB" — full W×H + size, used in the dropdown so the user
// can compare qualities at a glance. Size is exact when known (HTTP HEAD or
// network response), estimated (~) for HLS/DASH variants when bandwidth and
// duration are both set.
const variantDescriptor = (v: MediaVariant, durationSec?: number): string => {
  const wxh = v.resolution ? `${v.resolution.width}×${v.resolution.height}` : (v.name ?? 'Auto');
  let sizeStr = '';
  if (v.contentLength) {
    sizeStr = formatFileSize(v.contentLength);
  } else if (v.bandwidth && durationSec && durationSec > 0) {
    const est = (v.bandwidth * durationSec) / 8;
    const s = formatFileSize(est);
    if (s) sizeStr = `~${s}`;
  }
  return [wxh, sizeStr].filter(Boolean).join(' · ');
};

const variantContainer = (v: MediaVariant): string | undefined => {
  const mimeType = v.mimeType?.toLowerCase();
  if (mimeType?.includes('mp4')) return 'MP4';
  if (mimeType?.includes('webm')) return 'WEBM';
  return undefined;
};

const variantCodec = (v: MediaVariant): string | undefined => {
  const codecs = v.codecs?.toLowerCase() ?? '';
  if (codecs.includes('av01')) return 'AV1';
  if (codecs.includes('vp9') || codecs.includes('vp09')) return 'VP9';
  if (codecs.includes('avc1')) return 'H.264';
  if (codecs.includes('hev1') || codecs.includes('hvc1')) return 'H.265';
  return undefined;
};

const variantOptionLabel = (v: MediaVariant): string => {
  const resolution = v.resolution ? `${v.resolution.width}×${v.resolution.height}` : undefined;
  const frameRate = v.frameRate && v.frameRate > 30 ? `${v.frameRate}fps` : undefined;
  const bitrate =
    v.bandwidth && v.bandwidth > 0
      ? v.bandwidth >= 1_000_000
        ? `${(v.bandwidth / 1_000_000).toFixed(1)} Mbps`
        : `${Math.round(v.bandwidth / 1000)} Kbps`
      : undefined;
  const details = [variantContainer(v), variantCodec(v), resolution, frameRate, bitrate].filter(
    (part, index, parts): part is string => !!part && parts.indexOf(part) === index,
  );
  return details.length > 0 ? details.join(' · ') : (v.name ?? 'Auto');
};

type FilenameTemplateContext = {
  title?: string;
  resolution?: string; // e.g. "1080p"
  ext?: string; // e.g. "mp4", "mp3" (no leading dot)
  kind?: MediaItem['kind'];
  host?: string;
  date?: string; // YYYY-MM-DD
};

const buildFilenameContext = (
  item: Pick<MediaItem, 'title' | 'kind' | 'pageUrl' | 'url' | 'variants' | 'resolution'>,
  opts: { resolution?: string; ext?: string; date?: Date } = {},
): FilenameTemplateContext => {
  const best = item.variants?.length ? pickBestVariant(item.variants) : undefined;
  const resolution =
    opts.resolution ??
    (item.resolution
      ? shortEdgeLabel(item.resolution)
      : best?.resolution
        ? shortEdgeLabel(best.resolution)
        : undefined);
  let host: string | undefined;
  try {
    host = new URL(item.pageUrl ?? item.url).hostname.replace(/^www\./, '');
  } catch {
    host = undefined;
  }
  const d = opts.date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    title: item.title,
    resolution,
    ext: opts.ext,
    kind: item.kind,
    host,
    date,
  };
};

// Renders a filename template against a media item. Returns undefined when the
// template is empty or every token resolves to empty — callers should fall back
// to their default filename derivation in that case.
const renderFilenameTemplate = (template: string, ctx: FilenameTemplateContext): string | undefined => {
  const tpl = template.trim();
  if (!tpl) return undefined;
  const tokens: Record<string, string | undefined> = {
    title: ctx.title,
    resolution: ctx.resolution,
    ext: ctx.ext,
    kind: ctx.kind,
    host: ctx.host,
    date: ctx.date,
  };
  const rendered = tpl.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = tokens[name];
    return value ? sanitizeFileNamePart(String(value)) : '';
  });
  // Collapse separators left behind by empty tokens (e.g. "title -- 1080p" → "title - 1080p")
  const collapsed = rendered
    .replace(/[\s_-]*-[\s_-]*-[\s_-]*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s_\-.]+|[\s_\-.]+$/g, '')
    .trim();
  return collapsed.length > 0 ? collapsed.slice(0, 180) : undefined;
};

const FILENAME_TOKEN_HINT = '{title} {resolution} {ext} {kind} {host} {date}';

// True when the item's source URL is something a mobile browser can fetch and
// play directly (no HLS/DASH muxing, no separate audio track to merge). Used
// to decide whether to show a "Share to mobile" QR action.
const isMobileShareableUrl = (item: Pick<MediaItem, 'kind' | 'url' | 'audioUrl'>): boolean => {
  if (item.kind !== 'video' && item.kind !== 'audio') return false;
  if (item.audioUrl) return false; // separate audio track — mobile can't merge
  return /^https?:\/\//i.test(item.url);
};

export {
  FILENAME_TOKEN_HINT,
  buildFilenameContext,
  formatDate,
  formatDuration,
  formatFileSize,
  formatSpeed,
  isMobileShareableUrl,
  kindBadgeColor,
  mediaBadgeLabel,
  pickBestVariant,
  qualityLabel,
  renderFilenameTemplate,
  shortEdgeLabel,
  variantDescriptor,
  variantLabel,
  variantOptionLabel,
};
export type { DownloadState, FilenameTemplateContext };
