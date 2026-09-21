import type { MediaItem } from '@extension/shared';

type PlayerEvidence = {
  sourceUrls: string[];
  posterUrl: string;
  pageUrl: string;
  playerCount: number;
};

// X exposes the same asset ID in its poster and its video CDN paths. A blob
// URL identifies only a local MediaSource, so it cannot identify the asset.
const xAssetId = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    const pattern =
      url.hostname === 'video.twimg.com'
        ? /^\/(?:amplify_video|ext_tw_video)\/(\d+)\//
        : url.hostname === 'pbs.twimg.com'
          ? /^\/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)\//
          : undefined;
    return pattern?.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
};

const unique = (items: MediaItem[]): MediaItem | undefined => (items.length === 1 ? items[0] : undefined);

const resolvePlayerMedia = (items: MediaItem[], player: PlayerEvidence): MediaItem | undefined => {
  const candidates = items.filter(item => item.kind !== 'mse' && item.kind !== 'audio' && item.kind !== 'subtitle');
  const sources = new Set(player.sourceUrls.filter(url => url && !url.startsWith('blob:')));
  if (sources.size) {
    return unique(
      candidates.filter(item =>
        [item.url, ...(item.variants?.map(v => v.url) ?? []), ...(item.hlsChildUrls ?? [])].some(url =>
          sources.has(url),
        ),
      ),
    );
  }
  const assetId = xAssetId(player.posterUrl);
  if (assetId) {
    return unique(
      candidates.filter(
        item => xAssetId(item.url) === assetId || item.variants?.some(v => xAssetId(v.url) === assetId),
      ),
    );
  }
  // A single-player document can own one manifest or provider-extracted
  // presentation. Never choose the newest item in a multi-video feed.
  if (player.playerCount !== 1) return undefined;
  const presentations = candidates.filter(
    item =>
      item.kind === 'hls' ||
      item.kind === 'dash' ||
      item.kind === 'mss' ||
      (item.source === 'element' && !!item.variants?.length),
  );
  return unique(presentations.filter(item => item.pageUrl === player.pageUrl)) ?? unique(presentations);
};

type PlayerBox = { width: number; height: number; top: number; bottom: number; left: number; right: number };
const visiblePlayerArea = (rect: PlayerBox, width: number, height: number): number =>
  Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0)) *
  Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));

const selectVisiblePlayer = <T extends { rect: PlayerBox; playing: boolean }>(
  players: T[],
  width: number,
  height: number,
): T | undefined =>
  players
    .filter(
      player =>
        player.rect.width >= 280 && player.rect.height >= 160 && visiblePlayerArea(player.rect, width, height) > 0,
    )
    .reduce<T | undefined>((best, player) => {
      if (!best) return player;
      if (player.playing !== best.playing) return player.playing ? player : best;
      return visiblePlayerArea(player.rect, width, height) > visiblePlayerArea(best.rect, width, height)
        ? player
        : best;
    }, undefined);

export { resolvePlayerMedia, selectVisiblePlayer, visiblePlayerArea };
export type { PlayerEvidence, PlayerBox };
