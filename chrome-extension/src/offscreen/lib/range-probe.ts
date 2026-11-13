import { DownloadFailure } from './download-failure';
import { flowLog, safeUrl } from './download-log';
import { headersForFetch } from './hls-request';
import { responseValidator } from './http-validator';
import { HttpRequestError } from './network-request';
import type { HttpValidationMethod } from './http-validator';

const PROBE_TIMEOUT_MS = 10_000;

export type RangeProbe = {
  supportsRange: boolean;
  totalBytes?: number;
  contentType: string;
  resourceVersion?: string;
  weakEtag?: string;
  validationMethod?: HttpValidationMethod;
};

export const probeRangeSupport = async (
  url: string,
  signal: AbortSignal,
  keyHeaders?: Record<string, string>,
  prior?: { url: string; resourceVersion?: string; totalBytes: number },
): Promise<RangeProbe> => {
  const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
  if (prior?.url === url) {
    const head = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      headers: headersForFetch(keyHeaders, url),
      signal: combinedSignal,
      credentials: 'include',
    });
    if (!head.ok && ![405, 501].includes(head.status)) {
      await head.body?.cancel();
      throw new HttpRequestError(head.status, url);
    }
    const validator = responseValidator(head.headers);
    const length = Number(head.headers.get('content-length'));
    await head.body?.cancel();
    if (head.ok && Number.isSafeInteger(length) && length > 0) {
      // Existing checkpoints prove Range support. Each missing interval still
      // validates status, Content-Range and If-Range before writing any bytes.
      return {
        supportsRange: true,
        totalBytes: length,
        contentType: head.headers.get('content-type') ?? '',
        ...validator,
      };
    }
  }
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
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
  if (!res.ok) throw new HttpRequestError(res.status, url);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    throw new DownloadFailure('integrity', 'URL returned HTML, not a media file');
  }

  if (res.status === 206) {
    const contentRange = res.headers.get('content-range') ?? '';
    const match = contentRange.match(/^bytes 0-0\/(\d+)$/);
    const totalBytes = match ? Number(match[1]) : undefined;
    if (totalBytes === undefined || !Number.isSafeInteger(totalBytes) || totalBytes <= 0)
      throw new DownloadFailure('integrity', 'Invalid Range probe response');
    return { supportsRange: true, totalBytes, contentType, ...responseValidator(res.headers) };
  }
  const contentLengthHeader = res.headers.get('content-length');
  const length = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  const totalBytes = length !== undefined && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
  return { supportsRange: false, totalBytes, contentType };
};
