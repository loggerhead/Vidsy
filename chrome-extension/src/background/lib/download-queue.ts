import { createDownloadRuntime } from './download-runtime';
import { updateProgress } from './progress';
import { mediaSettingsStorage } from '@extension/storage';
import type { DownloadRuntime, ExecutorCommand, PersistedRuntime } from './download-runtime';
import type { MediaItem, MediaMessage } from '@extension/shared';

// Concurrency is user-configurable via the options page (default 1). libav
// HLS/DASH muxes are RAM- and OPFS-bandwidth-heavy; higher values trade
// stability for throughput. Clamped to [1, 8].
const readConcurrency = async (): Promise<number> => {
  const settings = await mediaSettingsStorage.get();
  const raw = settings.downloadConcurrency ?? 1;
  return Math.max(1, Math.min(8, Math.floor(raw)));
};

type DownloadPayload = Extract<MediaMessage, { type: 'media/download' }>['payload'];
type Runner = (payload: DownloadPayload) => Promise<unknown>;
const RUNTIME_STORAGE_KEY = 'vidsy-download-runtime';
let runner: Runner | null = null;

// Project durable queued jobs into the existing UI-facing progress shape.
const store = {
  read: async (): Promise<PersistedRuntime | undefined> => {
    const result = await chrome.storage.session.get(RUNTIME_STORAGE_KEY);
    return result[RUNTIME_STORAGE_KEY] as PersistedRuntime | undefined;
  },
  write: async (state: PersistedRuntime): Promise<void> => {
    await chrome.storage.session.set({ [RUNTIME_STORAGE_KEY]: state });
  },
};

const payloadFromCommand = (command: ExecutorCommand): DownloadPayload => ({
  url: command.execution.url,
  key: command.requestId,
  kind: command.execution.kind as DownloadPayload['kind'],
  outputFormat: command.execution.outputFormat,
  fileName: command.execution.fileName,
  audioUrl: command.execution.audioUrl,
  audioMimeType: command.execution.audioMimeType,
  title: command.execution.fileName,
});

const projectSnapshot = async () => {
  const snapshot = await runtime.snapshot();
  for (const job of snapshot.jobs) {
    if (job.state === 'cancelled') {
      await updateProgress(job.requestId, { stage: 'cancelled', downloadedBytes: 0 });
      continue;
    }
    if (job.state !== 'queued') continue;
    const item: MediaItem = {
      id: job.display.itemId ?? job.jobId,
      url: job.execution.url,
      kind: job.execution.kind as MediaItem['kind'],
      title: job.display.title,
      pageUrl: job.display.pageUrl,
      detectedAt: job.createdAt,
      source: 'network',
      fileName: job.execution.fileName,
    };
    await updateProgress(
      job.requestId,
      { stage: 'queued', downloadedBytes: 0, queuePosition: job.queuePosition },
      { item, outputFormat: job.execution.outputFormat },
    );
  }
};

// The executor callbacks close over the runtime so it must be initialized
// after the projection function is declared.
// eslint-disable-next-line prefer-const
let runtime: DownloadRuntime = createDownloadRuntime({
  store,
  concurrency: readConcurrency,
  executor: {
    start: async command => {
      if (!runner) return;
      try {
        await runtime.executorEvent({
          type: 'acknowledged',
          jobId: command.jobId,
          attempt: command.attempt,
          executionId: command.executionId,
        });
        const result = (await runner(payloadFromCommand(command))) as {
          ok?: boolean;
          downloadId?: number;
          cancelled?: boolean;
          paused?: boolean;
        };
        if (result.paused || result.cancelled) {
          await runtime.executorEvent({
            type: 'cancelled',
            jobId: command.jobId,
            attempt: command.attempt,
            executionId: command.executionId,
          });
        } else if (result.ok && result.downloadId !== undefined) {
          await runtime.executorEvent({
            type: 'artifact',
            jobId: command.jobId,
            attempt: command.attempt,
            executionId: command.executionId,
            downloadId: result.downloadId,
          });
          await runtime.browserDelivery({ jobId: command.jobId, downloadId: result.downloadId, state: 'complete' });
        } else {
          await runtime.executorEvent({
            type: 'failed',
            jobId: command.jobId,
            attempt: command.attempt,
            executionId: command.executionId,
            reason: 'executor_failed',
          });
        }
      } catch (error) {
        await runtime.executorEvent({
          type: 'failed',
          jobId: command.jobId,
          attempt: command.attempt,
          executionId: command.executionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await runtime.bootstrap();
        await projectSnapshot();
      }
    },
    cancel: async identity => {
      await chrome.runtime
        .sendMessage({ type: 'offscreen/cancel', payload: { key: identity.requestId } })
        .catch(() => undefined);
    },
  },
});

const enqueueDownload = async (payload: DownloadPayload, item: MediaItem): Promise<void> => {
  await runtime.submit({
    requestId: payload.key ?? payload.url,
    execution: {
      url: payload.url,
      kind: payload.kind ?? 'video',
      outputFormat: payload.outputFormat ?? 'mp4',
      fileName: payload.fileName,
      audioUrl: payload.audioUrl,
      audioMimeType: payload.audioMimeType,
    },
    display: { title: item.title, itemId: item.id, pageUrl: item.pageUrl },
  });
  await runtime.bootstrap();
  await projectSnapshot();
};

const cancelQueued = async (key: string): Promise<boolean> => {
  const changed = await runtime.command(key, { type: 'cancel' });
  await projectSnapshot();
  return changed;
};

const reorderQueueItem = async (key: string, direction: 'up' | 'down'): Promise<boolean> => {
  const changed = await runtime.command(key, { type: 'reorder', direction });
  await projectSnapshot();
  return changed;
};

const setQueueRunner = (fn: Runner) => {
  runner = fn;
  void runtime.bootstrap().then(projectSnapshot);
};

// Diagnostics — used by tests and surfaceable in a future "queue depth" badge.
const queueState = async () => {
  const snapshot = await runtime.snapshot();
  return {
    pending: snapshot.jobs.filter(job => job.state === 'queued').map(job => job.requestId),
    running: snapshot.jobs
      .filter(job => ['starting', 'running', 'finalizing'].includes(job.state))
      .map(job => job.requestId),
  };
};

export { cancelQueued, enqueueDownload, queueState, reorderQueueItem, setQueueRunner };
