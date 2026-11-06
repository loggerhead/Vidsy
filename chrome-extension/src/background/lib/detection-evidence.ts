import { deriveFileName } from './media-utils';
import type { MediaItem, MediaVariant } from '@extension/shared';

const hasPairedAudio = (item: Pick<MediaItem, 'kind' | 'audioUrl' | 'variants'>): boolean =>
  item.kind === 'video' && (!!item.audioUrl || !!item.variants?.some(variant => variant.audioUrl));

const isVariantAuthority = (item: MediaItem): boolean => item.source === 'element' && !!item.variants?.length;

const isFetchablePlayerAuthority = (item: MediaItem): boolean => isVariantAuthority(item) || hasPairedAudio(item);

const playerPageKey = (value: string): string => {
  try {
    const url = new URL(value);
    if (url.hostname === 'www.bilibili.com' && /^\/video\/BV[\w]+\/?$/.test(url.pathname)) {
      // Tracking parameters can be added after the first detection. A part
      // number changes the media; vd_source, trackid and spm_id_from do not.
      return `${url.origin}${url.pathname.replace(/\/$/, '')}?p=${url.searchParams.get('p') ?? '1'}`;
    }
  } catch {
    // Non-HTTP identifiers retain exact matching.
  }
  return value;
};

const sameMainPlayerSession = (left: MediaItem, right: MediaItem): boolean => {
  if (!left.pageUrl || !right.pageUrl || playerPageKey(left.pageUrl) !== playerPageKey(right.pageUrl)) return false;
  if (left.duration && right.duration && Math.abs(left.duration - right.duration) >= 2) return false;
  return true;
};

// Progressive fMP4 discovery is cumulative: video and audio init ranges can
// arrive in either order, followed by more video qualities. Once an item has
// been inserted, only accepting variants when the old list is empty freezes
// the first partial snapshot. Prefer strictly richer evidence while retaining
// the existing array for duplicate or out-of-order observations.
const selectRicherVariants = (
  existing: MediaVariant[] | undefined,
  incoming: MediaVariant[] | undefined,
): MediaVariant[] | undefined => ((incoming?.length ?? 0) > (existing?.length ?? 0) ? incoming : existing);

type PresentationMetadata = { thumbnail?: string | null; duration?: number };

// Presentation metadata is allowed to mutate only the MediaItem already
// resolved by the player-facing authority. The background never guesses an
// owner from list position, page URL, or arrival order.
const applyPresentationMetadata = (
  items: MediaItem[],
  itemId: string,
  metadata: PresentationMetadata,
): MediaItem[] | undefined => {
  const index = items.findIndex(item => item.id === itemId);
  if (index === -1) return undefined;
  const patch: Pick<MediaItem, 'thumbnail' | 'duration'> = {};
  if (metadata.thumbnail !== undefined) patch.thumbnail = metadata.thumbnail ?? undefined;
  if (metadata.duration !== undefined) patch.duration = metadata.duration;
  const updated = [...items];
  updated[index] = { ...updated[index], ...patch };
  return updated;
};

const combineMseAndFetchable = (mse: MediaItem, fetchable: MediaItem): MediaItem => ({
  ...mse,
  ...fetchable,
  id: mse.id,
  title: mse.title ?? fetchable.title,
  fileName: deriveFileName(fetchable.url, mse.title ?? fetchable.title),
  thumbnail: fetchable.thumbnail,
  duration: fetchable.duration,
  detectedAt: Math.min(mse.detectedAt, fetchable.detectedAt),
});

const reconcilePlayerEvidence = (
  items: MediaItem[],
  incoming: MediaItem,
): { items: MediaItem[]; consumed: boolean } => {
  if (incoming.kind !== 'mse' && !isFetchablePlayerAuthority(incoming)) return { items, consumed: false };

  const incomingIsMse = incoming.kind === 'mse';
  const counterpartIndexes = items.flatMap((item, index) => {
    if (!sameMainPlayerSession(item, incoming)) return [];
    const matches = incomingIsMse ? isFetchablePlayerAuthority(item) : item.kind === 'mse';
    return matches ? [index] : [];
  });
  if (counterpartIndexes.length !== 1) return { items, consumed: false };
  const counterpartIndex = counterpartIndexes[0];

  const counterpart = items[counterpartIndex];
  if (incomingIsMse && isVariantAuthority(counterpart)) {
    return { items, consumed: true };
  }
  const merged = incomingIsMse
    ? combineMseAndFetchable(incoming, counterpart)
    : combineMseAndFetchable(counterpart, incoming);
  // A partial network item may already exist when its audio arrives. Replace
  // the placeholder and remove that earlier copy of the same download URL.
  return {
    items: items.flatMap((item, index) =>
      index === counterpartIndex ? [merged] : item.url === merged.url ? [] : [item],
    ),
    consumed: true,
  };
};

export {
  applyPresentationMetadata,
  isVariantAuthority,
  reconcilePlayerEvidence,
  sameMainPlayerSession,
  selectRicherVariants,
};

// A master owns only the exact child playlists it declares, including unused
// language/bitrate renditions. Do not infer ownership from directories or tabs.
export const reconcileHlsPlaylistEvidence = (items: MediaItem[], incoming: MediaItem) => {
  if (items.some(item => item.hlsChildUrls?.includes(incoming.url))) return { items, consumed: true };
  const children = new Set(incoming.hlsChildUrls);
  return { items: items.filter(item => !children.has(item.url)), consumed: false };
};
