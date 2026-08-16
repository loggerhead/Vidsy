import { parseM3u8Attributes } from './media-utils';
import { createLogger } from '@extension/shared';
import type { MediaVariant } from '@extension/shared';

type ManifestParseResult = {
  variants: MediaVariant[];
  isDrmProtected: boolean;
};

const manifestUrlForLog = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
};

const manifestLog = createLogger('manifest').debug;

// HLS `METHOD=AES-128` is standard HTTP-delivered envelope encryption — the
// segment fetcher decrypts it. Anything else (SAMPLE-AES, SAMPLE-AES-CTR,
// proprietary schemes with KEYFORMAT pointing at Widevine / PlayReady /
// FairPlay / a uuid:) needs a key we can't obtain — treat as DRM.
const isHlsKeyLineDrm = (attrsRaw: string): boolean => {
  const attrs = parseM3u8Attributes(attrsRaw);
  const method = (attrs.METHOD ?? '').toUpperCase();
  return method !== 'NONE' && method !== '' && method !== 'AES-128';
};

export const parseHlsVariants = async (manifestUrl: string): Promise<ManifestParseResult> => {
  try {
    manifestLog('hls.fetch.start', { url: manifestUrlForLog(manifestUrl) });
    const res = await fetch(manifestUrl);
    if (!res.ok) {
      manifestLog('hls.fetch.failed', { url: manifestUrlForLog(manifestUrl), status: res.status });
      return { variants: [], isDrmProtected: false };
    }
    const text = await res.text();
    const lines = text.split('\n');
    const variants: MediaVariant[] = [];
    let isDrmProtected = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) {
        if (isHlsKeyLineDrm(line.slice(line.indexOf(':') + 1))) isDrmProtected = true;
        continue;
      }

      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
      const attrsRaw = line.slice(line.indexOf(':') + 1);
      const attrs = parseM3u8Attributes(attrsRaw);

      const nextLine = lines[i + 1]?.trim();
      if (!nextLine || nextLine.startsWith('#')) continue;
      const variantUrl = new URL(nextLine, manifestUrl).toString();
      const resolutionText = attrs['RESOLUTION'] ?? '';
      const [wStr, hStr] = resolutionText.split('x');
      const width = Number(wStr);
      const height = Number(hStr);
      const bandwidth = attrs['BANDWIDTH'] ? Number(attrs['BANDWIDTH']) : undefined;
      const name = attrs['NAME'] ?? undefined;
      const codecs = attrs['CODECS'] ?? undefined;

      variants.push({
        url: variantUrl,
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : undefined,
        resolution: Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined,
        name,
        codecs,
      });
    }

    if (isDrmProtected) {
      for (const v of variants) v.isDrmProtected = true;
    }

    manifestLog('hls.parsed', {
      url: manifestUrlForLog(manifestUrl),
      variantCount: variants.length,
      variants: variants.map(v => ({ resolution: v.resolution, bandwidth: v.bandwidth, url: v.url })),
      isDrmProtected,
    });
    return { variants, isDrmProtected };
  } catch (error) {
    manifestLog('hls.failed', { url: manifestUrlForLog(manifestUrl), error: String(error) });
    return { variants: [], isDrmProtected: false };
  }
};

type DashParseOptions = {
  fetchImpl?: typeof fetch;
  parseDocument?: (xml: string) => Document;
};

export const parseDashVariants = async (
  manifestUrl: string,
  options: DashParseOptions = {},
): Promise<ManifestParseResult> => {
  try {
    manifestLog('dash.fetch.start', { url: manifestUrlForLog(manifestUrl) });
    const res = await (options.fetchImpl ?? fetch)(manifestUrl);
    if (!res.ok) {
      manifestLog('dash.fetch.failed', { url: manifestUrlForLog(manifestUrl), status: res.status });
      return { variants: [], isDrmProtected: false };
    }
    const xml = await res.text();
    const doc = options.parseDocument
      ? options.parseDocument(xml)
      : new DOMParser().parseFromString(xml, 'application/xml');

    // Any ContentProtection element means the content is encrypted. Even the
    // generic CENC marker (urn:mpeg:dash:mp4protection:2011) alone implies
    // AES-CTR with a key obtained out-of-band (browser EME) — we have no
    // pathway to that key, so the resulting download would be corrupt.
    const contentProtections = Array.from(doc.querySelectorAll('ContentProtection'));
    const isDrmProtected = contentProtections.some(el => Boolean(el.getAttribute('schemeIdUri')));

    const reps = Array.from(doc.querySelectorAll('Representation'));
    const variants = reps
      .map(rep => {
        const bandwidth = rep.getAttribute('bandwidth');
        const width = rep.getAttribute('width');
        const height = rep.getAttribute('height');
        const codecs = rep.getAttribute('codecs') ?? undefined;
        const baseUrl =
          rep.querySelector('BaseURL')?.textContent?.trim() ??
          rep.closest('AdaptationSet')?.querySelector('BaseURL')?.textContent?.trim() ??
          rep.closest('Period')?.querySelector('BaseURL')?.textContent?.trim() ??
          doc.querySelector('MPD > BaseURL')?.textContent?.trim();
        if (!baseUrl) return undefined;
        const absoluteUrl = new URL(baseUrl, manifestUrl).toString();
        return {
          url: absoluteUrl,
          bandwidth: bandwidth ? Number(bandwidth) : undefined,
          resolution: width && height ? { width: Number(width), height: Number(height) } : undefined,
          codecs,
          name: rep.getAttribute('id') ?? undefined,
          isDrmProtected: isDrmProtected || undefined,
        } as MediaVariant;
      })
      .filter((v): v is MediaVariant => Boolean(v));

    manifestLog('dash.parsed', {
      url: manifestUrlForLog(manifestUrl),
      representationCount: reps.length,
      variantCount: variants.length,
      variants: variants.map(v => ({ resolution: v.resolution, bandwidth: v.bandwidth, codecs: v.codecs, url: v.url })),
      isDrmProtected,
    });
    return { variants, isDrmProtected };
  } catch (error) {
    manifestLog('dash.failed', { url: manifestUrlForLog(manifestUrl), error: String(error) });
    return { variants: [], isDrmProtected: false };
  }
};

export type { ManifestParseResult };
