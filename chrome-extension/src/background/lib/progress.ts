import { dlLog } from './logger';
import { mediaDownloadsStorage } from '@extension/storage';
import type { ChunkProgress, MediaDownloadProgress, MediaDownloadState, MediaItem } from '@extension/shared';

type ProgressUpdate = {
  stage:
    | 'queued'
    | 'init'
    | 'fetch-manifest'
    | 'download-video'
    | 'download-audio'
    | 'mux'
    | 'finalize'
    | 'success'
    | 'failed'
    | 'cancelled'
    | 'paused';
  downloadedBytes: number;
  estimatedBytes?: number;
  error?: string;
  muxPercent?: number;
  downloadId?: number;
  chunks?: ChunkProgress[];
  transferMode?: 'range' | 'stream' | 'mixed';
  activeConnections?: number;
  connectionLimit?: number;
  fallbackReason?: string;
  queuePosition?: number;
};

type ProgressContext = {
  item?: MediaItem;
  outputFormat?: 'mp4' | 'mp3';
  revision?: number;
  reset?: boolean;
  clearDownloadId?: boolean;
};

// All progress writes are owned by the background. Serialize reads and writes
// together, including clear/cancel operations, so unrelated jobs cannot vanish.
let writeTail = Promise.resolve();
const clearedKeys = new Set<string>();
const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
  const pending = writeTail.then(operation);
  writeTail = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
};

export const updateProgress = (key: string, progress: ProgressUpdate, context?: ProgressContext) =>
  mutate(async () => {
    if (clearedKeys.has(key) && !context?.reset) return;
    if (context?.reset) clearedKeys.delete(key);
    const current = await mediaDownloadsStorage.get();
    const existing = current[key];
    if (context?.revision !== undefined && (existing?.revision ?? -1) > context.revision) return;
    const terminal = new Set(['success', 'failed', 'cancelled', 'paused']);
    // Late worker/browser messages must not resurrect a terminal attempt. A new
    // attempt explicitly starts at queued/init with fresh context.
    if (existing && terminal.has(existing.stage) && !context) return;
    const now = Date.now();
    const entry: MediaDownloadProgress = {
      key,
      stage: progress.stage,
      downloadedBytes: progress.downloadedBytes,
      estimatedBytes: progress.estimatedBytes ?? existing?.estimatedBytes,
      muxPercent: progress.muxPercent,
      error: progress.error,
      downloadId: progress.downloadId ?? (context?.clearDownloadId ? undefined : existing?.downloadId),
      item: context?.item ?? existing?.item,
      outputFormat: context?.outputFormat ?? existing?.outputFormat,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      revision: context?.revision ?? existing?.revision,
      chunks: progress.chunks ?? existing?.chunks,
      transferMode: progress.transferMode ?? existing?.transferMode,
      activeConnections: progress.activeConnections ?? existing?.activeConnections,
      connectionLimit: progress.connectionLimit ?? existing?.connectionLimit,
      fallbackReason: progress.fallbackReason ?? existing?.fallbackReason,
      queuePosition: progress.queuePosition,
    };
    const next: MediaDownloadState = { ...current, [key]: entry };
    await mediaDownloadsStorage.set(next);
    if (!existing || existing.stage !== progress.stage || progress.stage === 'success' || progress.stage === 'failed') {
      dlLog('progress.stage', {
        key,
        from: existing?.stage,
        to: progress.stage,
        downloadedBytes: progress.downloadedBytes,
        estimatedBytes: progress.estimatedBytes ?? existing?.estimatedBytes,
        error: progress.error,
      });
    }
  });

export const clearProgress = (key: string) =>
  mutate(async () => {
    clearedKeys.add(key);
    dlLog('progress.clear', { key });
    const next = { ...(await mediaDownloadsStorage.get()) };
    delete next[key];
    await mediaDownloadsStorage.set(next);
  });

export const clearTerminalProgress = (keys?: string[]) =>
  mutate(async () => {
    const TERMINAL = new Set(['success', 'failed', 'cancelled', 'paused']);
    const current = await mediaDownloadsStorage.get();
    const next: MediaDownloadState = { ...current };
    for (const [k, v] of Object.entries(current)) {
      if (keys && !keys.includes(k)) continue;
      if (TERMINAL.has(v.stage)) {
        delete next[k];
        clearedKeys.add(k);
      }
    }
    await mediaDownloadsStorage.set(next);
  });
