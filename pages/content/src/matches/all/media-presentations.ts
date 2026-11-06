import { extractBilibiliPresentation } from './bilibili-presentation';
import { MEDIA_MESSAGE } from '@extension/shared';
import type { MediaKind, MediaVariant } from '@extension/shared';

type DeclaredMediaPresentation = {
  title?: string;
  thumbnail?: string;
  duration?: number;
  variants: MediaVariant[];
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const isRecord = (value: JsonValue): value is { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveNumber = (value: JsonValue | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const mediaUrl = (value: JsonValue | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
};

const explicitDurationSeconds = (value: { [key: string]: JsonValue }): number | undefined => {
  const seconds = positiveNumber(value.durationSeconds);
  if (seconds !== undefined) return seconds;
  const milliseconds = positiveNumber(value.durationMillis) ?? positiveNumber(value.durationMs);
  // A plain "duration" has no declared unit. Its magnitude cannot tell us
  // whether a short video is measured in milliseconds or a long one in seconds.
  return milliseconds !== undefined ? milliseconds / 1000 : undefined;
};

const toVariant = (value: JsonValue): MediaVariant | undefined => {
  if (!isRecord(value)) return undefined;
  const url = mediaUrl(value.url);
  if (!url) return undefined;

  const width = positiveNumber(value.width);
  const height = positiveNumber(value.height);
  const frameRate = positiveNumber(value.frameRate);
  const averageKbps = positiveNumber(value.avgBitrate);
  const bandwidth = positiveNumber(value.bandwidth) ?? (averageKbps ? averageKbps * 1000 : undefined);
  const name = typeof value.qualityLabel === 'string' ? value.qualityLabel : undefined;
  if (!width && !height && !frameRate && !bandwidth && !name) return undefined;

  return {
    url,
    name,
    bandwidth,
    resolution: width && height ? { width, height } : undefined,
    frameRate,
  };
};

const collectPresentations = (
  value: JsonValue,
  inheritedDuration: number | undefined,
  output: DeclaredMediaPresentation[],
) => {
  if (Array.isArray(value)) {
    const variants = value.map(toVariant).filter((variant): variant is MediaVariant => variant !== undefined);
    if (variants.length >= 2) {
      output.push({ duration: inheritedDuration, variants });
      return;
    }
    value.forEach(child => collectPresentations(child, inheritedDuration, output));
    return;
  }
  if (!isRecord(value)) return;

  const duration = explicitDurationSeconds(value) ?? inheritedDuration;
  Object.values(value).forEach(child => collectPresentations(child, duration, output));
};

const parseJsonAt = (source: string, start: number): { value: JsonValue; end: number } | undefined => {
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{' || char === '[') stack.push(char);
    if (char === '}' || char === ']') {
      const opening = stack.pop();
      if ((opening === '{' && char !== '}') || (opening === '[' && char !== ']')) return undefined;
      if (stack.length === 0) {
        try {
          return { value: JSON.parse(source.slice(start, index + 1)) as JsonValue, end: index + 1 };
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
};

const parseEmbeddedJson = (script: string): JsonValue[] => {
  const values: JsonValue[] = [];
  const decoded = script.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  for (let index = 0; index < decoded.length; index += 1) {
    if (decoded[index] !== '{' && decoded[index] !== '[') continue;
    const parsed = parseJsonAt(decoded, index);
    if (!parsed) continue;
    values.push(parsed.value);
    index = parsed.end - 1;
  }
  return values;
};

const extractDeclaredMediaPresentations = (scripts: string[]): DeclaredMediaPresentation[] => {
  const presentations: DeclaredMediaPresentation[] = [];
  for (const script of scripts) {
    for (const value of parseEmbeddedJson(script)) {
      collectPresentations(value, undefined, presentations);
    }
  }

  const seen = new Set<string>();
  return presentations.filter(presentation => {
    const key = presentation.variants.map(variant => variant.url).join('\n');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const extractAcfunPresentation = (pageUrl: string, scripts: string[]): DeclaredMediaPresentation | undefined => {
  let videoId: string | undefined;
  try {
    const url = new URL(pageUrl);
    if (url.hostname !== 'www.acfun.cn' && url.hostname !== 'acfun.cn') return undefined;
    videoId = /^\/v\/ac(\d+)\/?$/.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
  if (!videoId) return undefined;

  for (const script of scripts) {
    const assignment = /window\.pageInfo\s*=\s*window\.videoInfo\s*=\s*/.exec(script);
    if (!assignment) continue;
    const start = script.indexOf('{', assignment.index + assignment[0].length);
    const parsed = start >= 0 ? parseJsonAt(script, start) : undefined;
    if (!parsed || !isRecord(parsed.value) || String(parsed.value.dougaId) !== videoId) continue;
    const currentVideo = parsed.value.currentVideoInfo;
    if (!isRecord(currentVideo) || typeof currentVideo.ksPlayJson !== 'string') continue;
    try {
      const playInfo = JSON.parse(currentVideo.ksPlayJson) as JsonValue;
      if (!isRecord(playInfo) || !Array.isArray(playInfo.adaptationSet)) continue;
      for (const set of playInfo.adaptationSet) {
        if (!isRecord(set) || !Array.isArray(set.representation)) continue;
        const variants = set.representation.map(toVariant).filter((variant): variant is MediaVariant => !!variant);
        if (!variants.length) continue;
        // AcFun declares both values in milliseconds, including short videos.
        const milliseconds = positiveNumber(currentVideo.durationMillis) ?? positiveNumber(set.duration);
        return {
          title: typeof parsed.value.title === 'string' ? parsed.value.title : undefined,
          thumbnail: mediaUrl(parsed.value.coverUrl),
          duration: milliseconds ? milliseconds / 1000 : undefined,
          variants,
        };
      }
    } catch {
      // Ignore incomplete page declarations and keep generic detection available.
    }
  }
  return undefined;
};

const kindFromUrl = (url: string): MediaKind => {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'video';
};

const initDeclaredMediaPresentationDetector = (): (() => void) => {
  const documentUrl = window.location.href;
  const sent = new Set<string>();
  let scanQueued = false;
  let disposed = false;

  const scan = () => {
    if (disposed) return;
    scanQueued = false;
    const scripts = Array.from(document.scripts, script => script.textContent ?? '');
    const bilibili =
      window.location.href === documentUrl
        ? extractBilibiliPresentation({
            pageUrl: documentUrl,
            canonicalUrl: document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content,
            scripts,
            title: document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || document.title,
            thumbnail: document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content,
          })
        : undefined;
    const acfun = extractAcfunPresentation(documentUrl, scripts);
    const presentations = bilibili ? [bilibili] : acfun ? [acfun] : extractDeclaredMediaPresentations(scripts);
    for (const presentation of presentations) {
      const primary = presentation.variants[0];
      const key = presentation.variants.map(variant => variant.url).join('\n');
      if (sent.has(key)) continue;
      sent.add(key);
      chrome.runtime
        .sendMessage({
          type: MEDIA_MESSAGE.DETECTED,
          payload: {
            url: primary.url,
            kind: kindFromUrl(primary.url),
            source: 'element',
            title: presentation.title ?? document.title,
            thumbnail: presentation.thumbnail,
            duration: presentation.duration,
            variants: presentation.variants,
            resolution: primary.resolution,
            mimeType: primary.mimeType,
            audioUrl: primary.audioUrl,
            audioMimeType: primary.audioMimeType,
          },
        })
        .catch(() => undefined);
    }
  };

  const queueScan = () => {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(scan);
  };

  scan();
  const observer = new MutationObserver(mutations => {
    const scriptChanged = mutations.some(mutation => {
      if (mutation.target instanceof HTMLScriptElement) return true;
      return Array.from(mutation.addedNodes).some(
        node =>
          node instanceof HTMLScriptElement || (node instanceof HTMLElement && node.querySelector('script') !== null),
      );
    });
    if (scriptChanged) queueScan();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    disposed = true;
    observer.disconnect();
  };
};

export { extractAcfunPresentation, extractDeclaredMediaPresentations, initDeclaredMediaPresentationDetector };
export type { DeclaredMediaPresentation };
