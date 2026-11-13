import type { CacheCommand, CacheResponse } from '../lib/cache-protocol';

let counter = 0;
const pending = new Map<
  string,
  { resolve: (response: CacheResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
export const workerCacheCommand = (command: CacheCommand): Promise<CacheResponse> =>
  new Promise((resolve, reject) => {
    const cacheId = `cache-${++counter}`;
    const timer = setTimeout(() => {
      pending.delete(cacheId);
      reject(new Error('Cache checkpoint acknowledgement timed out'));
    }, 15_000);
    pending.set(cacheId, { resolve, reject, timer });
    self.postMessage({ type: 'cache-request', cacheId, command });
  });
export const receiveCacheResponse = (cacheId: string, response: CacheResponse): void => {
  const entry = pending.get(cacheId);
  if (!entry) return;
  pending.delete(cacheId);
  clearTimeout(entry.timer);
  if (response.ok) entry.resolve(response);
  else entry.reject(new Error(response.error ?? 'Persistent checkpoint rejected'));
};
