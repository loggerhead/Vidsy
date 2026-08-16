import type { MediaVariant } from '@extension/shared';

type YouTubeFormat = {
  itag?: number;
  url?: string;
  mimeType?: string;
  qualityLabel?: string;
  width?: number;
  height?: number;
  fps?: number;
  contentLength?: string;
  bitrate?: number;
};

type YouTubePlayerResponse = {
  streamingData?: {
    formats?: YouTubeFormat[];
    adaptiveFormats?: YouTubeFormat[];
  };
  videoDetails?: { title?: string };
};

type YouTubeMedia = {
  title?: string;
  primary: YouTubeFormat;
  variants: MediaVariant[];
};

const codecsFromMimeType = (mimeType?: string) => mimeType?.match(/codecs="([^"]+)"/)?.[1];
const containerFromMimeType = (mimeType?: string) => mimeType?.split(';', 1)[0]?.split('/')[1]?.toLowerCase();

const sortVideoFormats = (formats: YouTubeFormat[]) =>
  formats.slice().sort((left, right) => {
    const heightDiff = (right.height ?? 0) - (left.height ?? 0);
    if (heightDiff !== 0) return heightDiff;
    const frameRateDiff = (right.fps ?? 0) - (left.fps ?? 0);
    if (frameRateDiff !== 0) return frameRateDiff;
    const widthDiff = (right.width ?? 0) - (left.width ?? 0);
    if (widthDiff !== 0) return widthDiff;
    return (right.bitrate ?? 0) - (left.bitrate ?? 0);
  });

const bestCompatibleAudio = (video: YouTubeFormat, audioFormats: YouTubeFormat[]) => {
  const container = containerFromMimeType(video.mimeType);
  return audioFormats
    .filter(audio => containerFromMimeType(audio.mimeType) === container)
    .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))[0];
};

const extractYouTubeMedia = (response: YouTubePlayerResponse): YouTubeMedia | undefined => {
  const streamingData = response.streamingData;
  if (!streamingData) return undefined;

  const progressive = (streamingData.formats ?? []).filter(
    format => !!format.url && format.mimeType?.startsWith('video/'),
  );
  const adaptive = streamingData.adaptiveFormats ?? [];
  const adaptiveVideo = adaptive.filter(format => !!format.url && format.mimeType?.startsWith('video/'));
  const adaptiveAudio = adaptive.filter(format => !!format.url && format.mimeType?.startsWith('audio/'));
  const videoFormats = sortVideoFormats([...progressive, ...adaptiveVideo]);
  const primary = videoFormats[0];
  if (!primary?.url) return undefined;

  const variants = videoFormats.map(format => {
    const audio = adaptiveVideo.includes(format) ? bestCompatibleAudio(format, adaptiveAudio) : undefined;
    return {
      url: format.url!,
      name: format.qualityLabel ?? (format.height ? `${format.height}p` : undefined),
      mimeType: format.mimeType,
      bandwidth: format.bitrate,
      resolution: format.width && format.height ? { width: format.width, height: format.height } : undefined,
      frameRate: format.fps,
      contentLength: format.contentLength ? Number(format.contentLength) : undefined,
      codecs: codecsFromMimeType(format.mimeType),
      audioUrl: audio?.url,
      audioMimeType: audio?.mimeType,
    } satisfies MediaVariant;
  });

  return { title: response.videoDetails?.title, primary, variants };
};

const hasDirectAdaptiveVideo = (response: YouTubePlayerResponse): boolean =>
  (response.streamingData?.adaptiveFormats ?? []).some(format => !!format.url && format.mimeType?.startsWith('video/'));

export { extractYouTubeMedia, hasDirectAdaptiveVideo };
export type { YouTubeFormat, YouTubeMedia, YouTubePlayerResponse };
