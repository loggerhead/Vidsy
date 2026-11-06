import { headersForFetch } from './fetch-headers';

export class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status}: ${new URL(url).origin}${new URL(url).pathname}`);
    this.name = 'HttpRequestError';
  }
}

export const retryableRequest = (error: unknown): boolean =>
  error instanceof HttpRequestError
    ? [408, 429, 500, 502, 503, 504].includes(error.status)
    : !(error instanceof DOMException && ['QuotaExceededError', 'NotAllowedError'].includes(error.name));

// Header and body-idle deadlines are independent. Check the last received
// timestamp periodically instead of allocating a timer for every packet.
export const openDownloadResponse = async (
  url: string,
  options: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
    authorizeUrl?: (url: string) => Promise<void | string>;
    idleMs?: number;
    totalMs?: number;
  },
) => {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', abort, { once: true });
  const idleMs = options.idleMs ?? 30_000;
  let lastDataAt = Date.now();
  const startedAt = lastDataAt;
  const timer = setInterval(
    () => {
      const now = Date.now();
      if (now - lastDataAt >= idleMs)
        controller.abort(new Error(`Download stalled: no data for ${idleMs / 1000} seconds`));
      else if (now - startedAt >= (options.totalMs ?? 24 * 60 * 60 * 1000))
        controller.abort(new Error('Download exceeded its overall time limit'));
    },
    Math.min(1000, idleMs),
  );
  const dispose = () => {
    clearInterval(timer);
    options.signal?.removeEventListener('abort', abort);
  };
  const touch = () => {
    lastDataAt = Date.now();
  };
  try {
    let target = url;
    target = (await options.authorizeUrl?.(target)) || target;
    let response = await (options.fetchImpl ?? fetch)(target, {
      credentials: 'include',
      signal: controller.signal,
      headers: headersForFetch(options.headers, target),
    });
    // fetch cannot expose Location on an opaque manual redirect. Once the
    // final URL is known, prepare its isolated DNR context and retry there.
    if (options.authorizeUrl && ((response.url && response.url !== target) || [401, 403].includes(response.status))) {
      target = response.url || target;
      await response.body?.cancel();
      target = (await options.authorizeUrl(target)) || target;
      touch();
      response = await (options.fetchImpl ?? fetch)(target, {
        credentials: 'include',
        signal: controller.signal,
        headers: headersForFetch(options.headers, target),
      });
    }
    touch();
    return { response, touch, dispose, signal: controller.signal };
  } catch (error) {
    dispose();
    throw controller.signal.aborted ? controller.signal.reason : error;
  }
};
