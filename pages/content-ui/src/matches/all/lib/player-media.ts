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

const xRenditionResolution = (value: string): { width: number; height: number } | undefined => {
  try {
    const match = /\/pl\/(?:avc1|av01|hvc1|hev1|vp9)\/(\d+)x(\d+)\//.exec(new URL(value).pathname);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
  } catch {
    return undefined;
  }
};

const xAudioRendition = (value: string): boolean => {
  try {
    return /\/pl\/(?:mp4a|opus)\//.test(new URL(value).pathname);
  } catch {
    return false;
  }
};

const groupXRenditions = (items: MediaItem[]): MediaItem | undefined => {
  const videos = items
    .filter(item => item.kind === 'hls' && xRenditionResolution(item.url))
    .sort((a, b) => xRenditionResolution(b.url)!.height - xRenditionResolution(a.url)!.height);
  if (videos.length < 2) return undefined;
  const audio = unique(items.filter(item => item.kind === 'hls' && xAudioRendition(item.url)));
  const primary = videos[0];
  return {
    ...primary,
    resolution: xRenditionResolution(primary.url),
    audioUrl: audio?.url,
    audioMimeType: audio ? 'audio/mp4' : undefined,
    variants: videos.map(video => ({
      url: video.url,
      resolution: xRenditionResolution(video.url),
      audioUrl: audio?.url,
      audioMimeType: audio ? 'audio/mp4' : undefined,
    })),
  };
};

type PlayerMediaResolution = { item: MediaItem; authority: 'source' | 'poster' | 'unique-presentation' };

const resolvePlayerMedia = (items: MediaItem[], player: PlayerEvidence): PlayerMediaResolution | undefined => {
  const candidates = items.filter(item => item.kind !== 'mse' && item.kind !== 'audio' && item.kind !== 'subtitle');
  const sources = new Set(player.sourceUrls.filter(url => url && !url.startsWith('blob:')));
  if (sources.size) {
    const item = unique(
      candidates.filter(item =>
        [item.url, ...(item.variants?.map(v => v.url) ?? []), ...(item.hlsChildUrls ?? [])].some(url =>
          sources.has(url),
        ),
      ),
    );
    return item ? { item, authority: 'source' } : undefined;
  }
  const assetId = xAssetId(player.posterUrl);
  if (assetId) {
    const matches = candidates.filter(
      item => xAssetId(item.url) === assetId || item.variants?.some(v => xAssetId(v.url) === assetId),
    );
    const item = unique(matches) ?? groupXRenditions(matches);
    return item ? { item, authority: 'poster' } : undefined;
  }
  // A single-player document can own one manifest or provider-extracted
  // presentation. Never choose the newest item in a multi-video feed.
  if (player.playerCount !== 1) return undefined;
  // Bilibili plays DASH tracks through a blob URL. Network capture pairs the
  // video and audio tracks, but the element cannot expose either HTTP source.
  // Only bind a unique paired item from this exact video page.
  const page = new URL(player.pageUrl);
  if (page.hostname === 'www.bilibili.com' && /^\/video\/BV[^/]+\/?$/.test(page.pathname)) {
    const videoPage = page.pathname.replace(/\/$/, '');
    const paired = unique(
      candidates.filter(item => {
        if (item.kind !== 'video' || !item.audioUrl || !item.pageUrl) return false;
        const sourcePage = new URL(item.pageUrl);
        return sourcePage.origin === page.origin && sourcePage.pathname.replace(/\/$/, '') === videoPage;
      }),
    );
    if (paired) return { item: paired, authority: 'unique-presentation' };
  }
  const presentations = candidates.filter(
    item =>
      item.kind === 'hls' ||
      item.kind === 'dash' ||
      item.kind === 'mss' ||
      (item.source === 'element' && !!item.variants?.length),
  );
  const item = unique(presentations.filter(item => item.pageUrl === player.pageUrl)) ?? unique(presentations);
  return item ? { item, authority: 'unique-presentation' } : undefined;
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
export type { PlayerEvidence, PlayerBox, PlayerMediaResolution };
