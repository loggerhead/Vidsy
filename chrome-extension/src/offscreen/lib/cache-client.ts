import type { CacheCommand, CacheResponse } from './cache-protocol';

export const cacheCommand = async (command: CacheCommand): Promise<CacheResponse> => {
  const response = (await chrome.runtime.sendMessage({
    type: 'offscreen/download-cache',
    payload: command,
  })) as CacheResponse;
  if (!response?.ok) throw new Error(response?.error ?? 'Persistent download cache unavailable');
  return response;
};
