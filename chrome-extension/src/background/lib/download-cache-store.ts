import { createDownloadCache } from './download-cache';
import { mediaSettingsStorage } from '@extension/storage';

export const DOWNLOAD_CACHE_KEY = 'uuget-download-cache';
export const downloadCache = createDownloadCache({
  read: async () => (await chrome.storage.local.get(DOWNLOAD_CACHE_KEY))[DOWNLOAD_CACHE_KEY],
  write: async ledger => {
    await chrome.storage.local.set({ [DOWNLOAD_CACHE_KEY]: ledger });
  },
  ttlMs: async () => {
    const days = (await mediaSettingsStorage.get()).cacheRetentionDays ?? 7;
    return Math.max(1, Math.min(365, Number.isFinite(days) ? days : 7)) * 24 * 60 * 60 * 1000;
  },
});
