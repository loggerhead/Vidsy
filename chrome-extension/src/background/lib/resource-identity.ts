import { cacheFingerprint } from '../../offscreen/lib/cache-protocol';
import type { DownloadExecutionSpec } from './download-runtime';

const sortedHeaders = (headers?: Record<string, string>) =>
  headers
    ? Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : [];
export const resourceLocator = (execution: DownloadExecutionSpec): Promise<string> =>
  cacheFingerprint({
    url: execution.url,
    audioUrl: execution.audioUrl,
    kind: execution.kind,
    outputFormat: execution.outputFormat,
    headers: sortedHeaders(execution.headers),
    audioHeaders: sortedHeaders(execution.audioHeaders),
  });
