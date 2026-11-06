import { createDownloadRuntime } from './download-runtime';
import { findDownloadHeaders, waitForCapturedHeaders } from './header-capture';
import { clearProgress, updateProgress } from './progress';
import { mediaSettingsStorage } from '@extension/storage';
import type {
  DownloadCommand,
  DownloadRuntime,
  ExecutorAdapter,
  ExecutorCommand,
  PersistedRuntime,
} from './download-runtime';
import type { MediaItem, MediaMessage, MediaDownloadStage } from '@extension/shared';

type DownloadPayload = Extract<MediaMessage, { type: 'media/download' }>['payload'];
const RUNTIME_STORAGE_KEY = 'vidsy-download-runtime';
let adapter: ExecutorAdapter = {};
let recovery: Promise<void> | undefined;
const RECOVERY_ALARM = 'vidsy-download-recovery';
const requestQueueRecovery = () => chrome.alarms.create(RECOVERY_ALARM, { delayInMinutes: 0.5 });
const store = {
  read: async (): Promise<PersistedRuntime | undefined> =>
    (await chrome.storage.session.get(RUNTIME_STORAGE_KEY))[RUNTIME_STORAGE_KEY],
  write: async (state: PersistedRuntime): Promise<void> => {
    await chrome.storage.session.set({ [RUNTIME_STORAGE_KEY]: state });
  },
};
const runtime: DownloadRuntime = createDownloadRuntime({
  store,
  // Authenticated manifests can discover additional hosts after dispatch. Until
  // those requests have their own isolated transport, reserve the executor for
  // such jobs. Public jobs still use the configured concurrency.
  canStart: (job, active) =>
    active.every(
      other =>
        !Object.keys({ ...job.execution.headers, ...job.execution.audioHeaders }).length &&
        !Object.keys({ ...other.execution.headers, ...other.execution.audioHeaders }).length,
    ),
  concurrency: async () => {
    const value = (await mediaSettingsStorage.get()).downloadConcurrency ?? 1;
    return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 1;
  },
  executor: {
    start: async command => {
      if (!adapter.start) throw new Error('Executor not configured');
      await adapter.start(command);
    },
    cancel: async identity => {
      await adapter.cancel?.(identity);
    },
    resumeDelivery: async id => {
      await adapter.resumeDelivery?.(id);
    },
    inventory: async () => {
      if (!adapter.inventory) throw new Error('Executor inventory unavailable');
      return adapter.inventory();
    },
  },
});

const terminalStage = { succeeded: 'success', failed: 'failed', cancelled: 'cancelled', paused: 'paused' } as const;
const projected = new Map<string, string>();
const projectSnapshot = async () => {
  const snapshot = await runtime.snapshot();
  for (const job of snapshot.jobs) {
    const stage: MediaDownloadStage | undefined =
      job.state === 'queued'
        ? 'queued'
        : job.state === 'finalizing'
          ? 'finalize'
          : terminalStage[job.state as keyof typeof terminalStage];
    if (!stage) continue;
    const revision = `${job.state}:${job.updatedAt}:${job.queuePosition ?? ''}`;
    if (projected.get(job.jobId) === revision) continue;
    await updateProgress(
      job.requestId,
      {
        stage,
        downloadedBytes: job.progress.downloadedBytes,
        estimatedBytes: job.progress.estimatedBytes,
        error: job.terminal?.reason,
        downloadId: job.downloadId,
        queuePosition: job.queuePosition,
      },
      {
        item: job.execution.item,
        outputFormat: job.execution.outputFormat,
        revision: job.updatedAt,
        clearDownloadId: job.downloadId === undefined,
      },
    );
    projected.set(job.jobId, revision);
  }
};

const setQueueExecutor = (executor: ExecutorAdapter, reconcile: () => Promise<void>) => {
  adapter = executor;
  // No dispatch until a successful inventory read and replay. A failed query
  // keeps the durable claims intact; callers can retry recovery safely.
  const recover = async () => {
    await runtime.bootstrap();
    await reconcile();
    await projectSnapshot();
  };
  const ready = () =>
    (recovery ??= recover().catch(error => {
      recovery = undefined;
      void requestQueueRecovery();
      throw error;
    }));
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== RECOVERY_ALARM) return;
    recovery = undefined;
    void ready().catch(() => undefined);
  });
  void ready().catch(() => undefined);
  return ready;
};

const publishSubmission = async (result: { jobId: string; duplicate: boolean }, requestId: string) => {
  if (!result.duplicate) {
    const job = (await runtime.snapshot()).jobs.find(job => job.jobId === result.jobId)!;
    await updateProgress(
      requestId,
      { stage: 'queued', downloadedBytes: 0, queuePosition: job.queuePosition },
      {
        item: job.execution.item,
        outputFormat: job.execution.outputFormat,
        revision: job.updatedAt,
        reset: true,
        clearDownloadId: true,
      },
    );
    projected.set(job.jobId, `${job.state}:${job.updatedAt}:${job.queuePosition ?? ''}`);
  }
  void runtime.schedule().catch(() => undefined);
  return { ...result, key: requestId };
};

const enqueueDownload = async (payload: DownloadPayload, item: MediaItem) => {
  await waitForCapturedHeaders();
  const requestId = payload.key ?? crypto.randomUUID();
  const itemSnapshot: MediaItem = {
    ...structuredClone(item),
    url: payload.url,
    kind: payload.kind ?? item.kind,
    title: payload.title ?? item.title,
    fileName: payload.fileName ?? item.fileName,
    audioUrl: payload.audioUrl,
    audioMimeType: payload.audioMimeType,
  };
  const result = await runtime.submit({
    requestId,
    execution: {
      url: payload.url,
      kind: payload.kind ?? item.kind,
      outputFormat: payload.outputFormat ?? 'mp4',
      fileName: payload.fileName,
      title: payload.title ?? item.title,
      audioUrl: payload.audioUrl,
      audioMimeType: payload.audioMimeType,
      item: itemSnapshot,
      headers: item.tabId === undefined ? undefined : findDownloadHeaders(payload.url, item.tabId, item.pageUrl),
      audioHeaders:
        payload.audioUrl && item.tabId !== undefined
          ? findDownloadHeaders(payload.audioUrl, item.tabId, item.pageUrl)
          : undefined,
    },
    display: { title: item.title, itemId: item.id, pageUrl: item.pageUrl, tabId: item.tabId },
  });
  return publishSubmission(result, requestId);
};

const resubmitDownload = async (key: string, requestId: string) => {
  const job = (await runtime.snapshot()).jobs.find(job => job.requestId === key || job.jobId === key);
  if (!job) return undefined;
  const execution = structuredClone(job.execution);
  execution.item ??= {
    id: job.display.itemId ?? job.jobId,
    url: execution.url,
    kind: execution.kind,
    title: execution.title ?? job.display.title,
    pageUrl: job.display.pageUrl,
    tabId: job.display.tabId,
    fileName: execution.fileName,
    audioUrl: execution.audioUrl,
    audioMimeType: execution.audioMimeType,
    detectedAt: job.createdAt,
    source: 'network',
  };
  const result = await runtime.submit({ requestId, execution, display: job.display });
  return publishSubmission(result, requestId);
};

const commandDownload = async (key: string, command: DownloadCommand): Promise<boolean> => {
  const job = (await runtime.snapshot()).jobs.find(item => item.requestId === key || item.jobId === key);
  if (!job) return false;
  const changed = await runtime.command(job.jobId, command);
  await projectSnapshot();
  if (command.type === 'clear-terminal' && changed) {
    projected.delete(job.jobId);
    await clearProgress(job.requestId);
  }
  void runtime.schedule().catch(() => undefined);
  return changed;
};
const cancelDownloadsForTab = async (tabId: number) => {
  for (const job of (await runtime.snapshot()).jobs) {
    if (job.display.tabId === tabId && !['succeeded', 'failed', 'cancelled'].includes(job.state)) {
      await commandDownload(job.jobId, { type: 'cancel' });
    }
  }
};
const clearDownloads = async (keys?: string[]) => {
  for (const job of (await runtime.snapshot()).jobs) {
    // Paused jobs retain resume data and remain visible until explicitly cancelled.
    if (keys?.includes(job.requestId) && job.state === 'paused') await commandDownload(job.jobId, { type: 'cancel' });
    if (
      (!keys || keys.includes(job.requestId)) &&
      ['succeeded', 'failed', 'cancelled', ...(keys ? ['paused'] : [])].includes(job.state)
    ) {
      await commandDownload(job.jobId, { type: 'clear-terminal' });
    }
  }
};
const reorderQueueItem = (key: string, direction: 'up' | 'down') =>
  commandDownload(key, { type: 'reorder', direction });
const queueState = async () => {
  const { jobs } = await runtime.snapshot();
  return {
    pending: jobs.filter(job => job.state === 'queued').map(job => job.requestId),
    running: jobs.filter(job => ['starting', 'running', 'finalizing'].includes(job.state)).map(job => job.requestId),
  };
};
export {
  runtime,
  projectSnapshot,
  setQueueExecutor,
  requestQueueRecovery,
  enqueueDownload,
  resubmitDownload,
  commandDownload,
  cancelDownloadsForTab,
  clearDownloads,
  reorderQueueItem,
  queueState,
};
export type { ExecutorCommand };
