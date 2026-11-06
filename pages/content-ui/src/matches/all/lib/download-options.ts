import { formatBytes, estimateBytes } from './media-helpers';
import { qualityLabel, variantOptionLabel } from '@extension/shared';
import type { MediaItem, MediaVariant } from '@extension/shared';

export type DownloadRow = { sub: string; item: MediaItem; variant?: MediaVariant };
export type DownloadOption = DownloadRow & {
  key: string;
  quality: string;
  height: number;
  details: string;
  size: string;
  blocked: boolean;
};
export type QualityGroup = { quality: string; options: DownloadOption[] };

export const groupDownloadOptions = (rows: DownloadRow[]): QualityGroup[] => {
  const groups = new Map<string, QualityGroup>();
  const seen = new Set<string>();
  for (const row of rows) {
    const { item, variant } = row;
    const key = JSON.stringify([item.id, variant?.url ?? item.url, variant?.audioUrl ?? item.audioUrl]);
    if (seen.has(key)) continue;
    seen.add(key);
    // A rendition without dimensions must not inherit the primary rendition's quality.
    const resolution = variant ? variant.resolution : item.resolution;
    const quality = resolution ? qualityLabel(resolution) : 'Auto';
    const height = resolution ? Number.parseInt(quality) : 0;
    const exact = variant ? variant.contentLength : item.contentLength;
    const estimate = variant ? estimateBytes(variant.bandwidth, item.duration) : undefined;
    const size = exact ? formatBytes(exact) : estimate ? formatBytes(estimate) : 'Size unknown';
    const metadata: MediaVariant = variant ?? { url: item.url, mimeType: item.mimeType, resolution };
    const details = variantOptionLabel(metadata, { includeResolution: false });
    const option: DownloadOption = {
      ...row,
      key,
      quality,
      height,
      size,
      details: details === 'Auto' ? 'Default version' : details,
      blocked: !!(item.isDrmProtected || variant?.isDrmProtected || item.kind === 'mse'),
    };
    // Unknown qualities may be unrelated resources; keep them individually visible.
    const groupKey = resolution ? quality : key;
    const group = groups.get(groupKey) ?? { quality, options: [] };
    group.options.push(option);
    groups.set(groupKey, group);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.options.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      // Prefer H.264 for playback compatibility, then higher frame rate / bitrate.
      const compatible = (option: DownloadOption) => /avc1|avc3/i.test(option.variant?.codecs ?? '');
      return (
        Number(compatible(b)) - Number(compatible(a)) ||
        (b.variant?.frameRate ?? 0) - (a.variant?.frameRate ?? 0) ||
        (b.variant?.bandwidth ?? 0) - (a.variant?.bandwidth ?? 0)
      );
    });
  }
  return result.sort((a, b) => b.options[0].height - a.options[0].height);
};

export const recommendDownloadOption = (groups: QualityGroup[]): DownloadOption | undefined => {
  const options = groups.map(group => group.options.find(option => !option.blocked)).filter(option => !!option);
  const knownQualities = options.filter(option => option.height > 0);
  return knownQualities.find(option => option.height <= 1080) ?? knownQualities.at(-1) ?? options[0];
};
