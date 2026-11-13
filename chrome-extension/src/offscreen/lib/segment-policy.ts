import type { MediaDescriptor } from './media-processing';

export type SegmentedSnapshot =
  | { kind: 'hls'; video: { url: string; manifestText: string }; audio?: { url: string; manifestText: string } }
  | { kind: 'dash'; url: string; manifestText: string };
export type SegmentedSource = {
  fingerprint: string;
  live: boolean;
  descriptor?: MediaDescriptor;
  snapshot?: SegmentedSnapshot;
};
export const isLiveHls = (text: string): boolean => !/^[ \t]*#EXT-X-ENDLIST\s*$/m.test(text.replace(/\r/g, ''));
export const isLiveDash = (text: string): boolean => /<MPD\b[^>]*\btype\s*=\s*['"]dynamic['"]/i.test(text);
