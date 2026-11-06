import type { MediaDownloadProgress } from '@extension/shared';

export const downloadPercent = (entry: MediaDownloadProgress): number | null => {
  if (entry.stage === 'success') return 100;
  if (['failed', 'cancelled', 'queued', 'finalize'].includes(entry.stage)) return null;
  if (entry.stage === 'mux') {
    if (entry.activity === 'waiting-mux' || entry.activity === 'verifying') return null;
    return entry.muxPercent !== undefined && Number.isFinite(entry.muxPercent)
      ? Math.max(0, Math.min(99, entry.muxPercent))
      : null;
  }
  return entry.estimatedBytes && entry.estimatedBytes > 0
    ? Math.max(0, Math.min(100, (entry.downloadedBytes / entry.estimatedBytes) * 100))
    : null;
};
