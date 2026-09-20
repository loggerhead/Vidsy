import { deriveFileName } from './media-utils';
import type { MediaItem } from '@extension/shared';

const hasPairedAudio = (item: Pick<MediaItem, 'kind' | 'audioUrl' | 'variants'>): boolean =>
  item.kind === 'video' && (!!item.audioUrl || !!item.variants?.some(variant => variant.audioUrl));

const isVariantAuthority = (item: MediaItem): boolean => item.source === 'element' && !!item.variants?.length;

const isFetchablePlayerAuthority = (item: MediaItem): boolean => isVariantAuthority(item) || hasPairedAudio(item);

const sameMainPlayerSession = (left: MediaItem, right: MediaItem): boolean => {
  if (!left.pageUrl || !right.pageUrl || left.pageUrl !== right.pageUrl) return false;
  if (left.duration && right.duration && Math.abs(left.duration - right.duration) >= 2) return false;
  return true;
};

const combineMseAndFetchable = (mse: MediaItem, fetchable: MediaItem): MediaItem => ({
  ...mse,
  ...fetchable,
  id: mse.id,
  title: mse.title ?? fetchable.title,
  fileName: deriveFileName(fetchable.url, mse.title ?? fetchable.title),
  thumbnail: mse.thumbnail ?? fetchable.thumbnail,
  duration: mse.duration ?? fetchable.duration,
  detectedAt: Math.min(mse.detectedAt, fetchable.detectedAt),
});

const reconcilePlayerEvidence = (
  items: MediaItem[],
  incoming: MediaItem,
): { items: MediaItem[]; consumed: boolean } => {
  if (incoming.kind !== 'mse' && !isFetchablePlayerAuthority(incoming)) return { items, consumed: false };

  const incomingIsMse = incoming.kind === 'mse';
  const counterpartIndex = items.findIndex(item => {
    if (!sameMainPlayerSession(item, incoming)) return false;
    return incomingIsMse ? isFetchablePlayerAuthority(item) : item.kind === 'mse';
  });
  if (counterpartIndex === -1) return { items, consumed: false };

  const counterpart = items[counterpartIndex];
  if (incomingIsMse && isVariantAuthority(counterpart)) {
    return { items, consumed: true };
  }
  const merged = incomingIsMse
    ? combineMseAndFetchable(incoming, counterpart)
    : combineMseAndFetchable(counterpart, incoming);
  return {
    items: items.map((item, index) => (index === counterpartIndex ? merged : item)),
    consumed: true,
  };
};

export { isVariantAuthority, reconcilePlayerEvidence, sameMainPlayerSession };

// A master owns only the exact child playlists it declares, including unused
// language/bitrate renditions. Do not infer ownership from directories or tabs.
export const reconcileHlsPlaylistEvidence = (items: MediaItem[], incoming: MediaItem) => {
  if (items.some(item => item.hlsChildUrls?.includes(incoming.url))) return { items, consumed: true };
  const children = new Set(incoming.hlsChildUrls);
  return { items: items.filter(item => !children.has(item.url)), consumed: false };
};
