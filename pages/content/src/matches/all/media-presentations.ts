import { MEDIA_MESSAGE } from '@extension/shared';
import type { MediaKind, MediaVariant } from '@extension/shared';

type DeclaredMediaPresentation = {
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

const durationSeconds = (value: JsonValue | undefined): number | undefined => {
  const duration = positiveNumber(value);
  if (!duration) return undefined;
  return duration > 86_400 ? duration / 1000 : duration;
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

  const duration = durationSeconds(value.duration) ?? inheritedDuration;
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

const kindFromUrl = (url: string): MediaKind => {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'video';
};

const initDeclaredMediaPresentationDetector = () => {
  const sent = new Set<string>();
  let scanQueued = false;

  const scan = () => {
    scanQueued = false;
    const scripts = Array.from(document.scripts, script => script.textContent ?? '');
    for (const presentation of extractDeclaredMediaPresentations(scripts)) {
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
            title: document.title,
            duration: presentation.duration,
            variants: presentation.variants,
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
  new MutationObserver(mutations => {
    const scriptChanged = mutations.some(mutation => {
      if (mutation.target instanceof HTMLScriptElement) return true;
      return Array.from(mutation.addedNodes).some(
        node =>
          node instanceof HTMLScriptElement || (node instanceof HTMLElement && node.querySelector('script') !== null),
      );
    });
    if (scriptChanged) queueScan();
  }).observe(document.documentElement, { childList: true, subtree: true });
};

export { extractDeclaredMediaPresentations, initDeclaredMediaPresentationDetector };
export type { DeclaredMediaPresentation };
