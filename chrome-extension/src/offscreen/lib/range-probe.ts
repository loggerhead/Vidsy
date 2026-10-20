import { flowLog, safeUrl } from './download-log';
import { headersForFetch } from './hls-request';

const PROBE_TIMEOUT_MS = 10_000;

export type RangeProbe = {
  supportsRange: boolean;
  totalBytes?: number;
  contentType: string;
  resourceVersion?: string;
};

export const probeRangeSupport = async (
  url: string,
  signal: AbortSignal,
  keyHeaders?: Record<string, string>,
): Promise<RangeProbe> => {
  const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...headersForFetch(keyHeaders, url), Range: 'bytes=0-0' },
    signal: combinedSignal,
    credentials: 'include',
  });
  flowLog('http.probe.response', {
    url: safeUrl(url),
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    contentLength: res.headers.get('content-length') ?? undefined,
    contentRange: res.headers.get('content-range') ?? undefined,
  });
  // Only headers are needed. In particular a 200 response may be gigabytes.
  await res.body?.cancel();

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    throw new Error('URL returned HTML, not a media file');
  }

  if (res.status === 206) {
    const contentRange = res.headers.get('content-range') ?? '';
    const match = contentRange.match(/^bytes 0-0\/(\d+)$/);
    const totalBytes = match ? Number(match[1]) : undefined;
    if (totalBytes === undefined || !Number.isSafeInteger(totalBytes) || totalBytes <= 0)
      throw new Error('Invalid Range probe response');
    const etag = res.headers.get('etag');
    // Weak ETags and timestamps cannot establish byte identity reliably.
    const resourceVersion = etag && /^"[^\r\n]*"$/.test(etag) ? etag : undefined;
    return { supportsRange: true, totalBytes, contentType, resourceVersion };
  }
  const contentLengthHeader = res.headers.get('content-length');
  const length = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  const totalBytes = length !== undefined && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
  return { supportsRange: false, totalBytes, contentType };
};
