import type { MediaVariant } from '@extension/shared';

type BilibiliPage = {
  pageUrl: string;
  canonicalUrl?: string;
  scripts: string[];
  title: string;
  thumbnail?: string;
};

type BilibiliTrack = {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  width: number;
  height: number;
  codecs?: string;
  frameRate?: string | number;
  frame_rate?: string | number;
  bandwidth?: number;
};

type BilibiliPlayInfo = {
  code?: number;
  data?: {
    timelength?: number;
    accept_quality?: number[];
    accept_description?: string[];
    dash?: { video?: BilibiliTrack[]; audio?: BilibiliTrack[] };
  };
};

const videoPage = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.hostname !== 'www.bilibili.com') return undefined;
    const bvid = /^\/video\/(BV[\w]+)\/?$/.exec(url.pathname)?.[1];
    return bvid ? `${bvid}:${url.searchParams.get('p') ?? '1'}` : undefined;
  } catch {
    return undefined;
  }
};

const httpUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
};

// The playinfo often puts a peer CDN on :8082 first. Prefer a normal HTTPS
// CDN explicitly supplied for the same track; preserve its signed URL intact.
const trackUrl = (track: BilibiliTrack): string | undefined => {
  const candidates = [track.baseUrl ?? track.base_url, ...(track.backupUrl ?? track.backup_url ?? [])]
    .map(httpUrl)
    .filter((url): url is string => !!url);
  return (
    candidates.find(value => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.port && url.hostname.endsWith('.bilivideo.com');
    }) ?? candidates[0]
  );
};

// The inline playinfo and canonical metadata describe the document's main
// video, including its separate audio track. Do not infer track ownership
// from a CDN directory, or attach this cover to recommended videos.
const extractBilibiliPresentation = (page: BilibiliPage) => {
  const identity = videoPage(page.pageUrl);
  if (!identity || !page.canonicalUrl || videoPage(page.canonicalUrl) !== identity) return undefined;

  for (const script of page.scripts) {
    const match = /^\s*window\.__playinfo__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(script);
    if (!match) continue;
    try {
      const info = JSON.parse(match[1]) as BilibiliPlayInfo;
      const dash = info?.data?.dash;
      if (info.code !== 0 || !Array.isArray(dash?.video) || !Array.isArray(dash?.audio)) continue;
      const audio = dash.audio
        .filter(track => trackUrl(track) && /^mp4a\b/.test(track.codecs ?? ''))
        .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
      if (!audio) continue;
      const audioUrl = trackUrl(audio)!;
      const variants: MediaVariant[] = dash.video.flatMap(track => {
        const url = trackUrl(track);
        if (!url || !(track.width > 0) || !(track.height > 0)) return [];
        const rate = String(track.frameRate ?? track.frame_rate ?? '')
          .split('/')
          .map(Number);
        const frameRate = rate.length === 2 ? rate[0] / rate[1] : rate[0];
        const qualityIndex = track.id === undefined ? -1 : (info.data?.accept_quality?.indexOf(track.id) ?? -1);
        return [
          {
            url,
            mimeType: 'video/mp4',
            name: qualityIndex >= 0 ? info.data?.accept_description?.[qualityIndex] : undefined,
            bandwidth: track.bandwidth,
            resolution: { width: track.width, height: track.height },
            codecs: track.codecs,
            frameRate: Number.isFinite(frameRate) && frameRate > 0 ? frameRate : undefined,
            audioUrl,
            audioMimeType: 'audio/mp4',
          },
        ];
      });
      if (!variants.length) continue;
      const milliseconds = info.data?.timelength;
      const duration =
        typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0
          ? milliseconds / 1000
          : undefined;
      return {
        title: page.title,
        thumbnail: httpUrl(page.thumbnail),
        duration,
        variants,
      };
    } catch {
      // An incomplete or non-JSON declaration is not a media authority.
    }
  }
  return undefined;
};

export { extractBilibiliPresentation };
