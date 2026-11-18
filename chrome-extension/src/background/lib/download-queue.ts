import { cachedDownloadBytes, describeCachedProgress } from './download-cache';
import { downloadCache } from './download-cache-store';
import { createLocalDownloadStore } from './download-persistence';
import { AUTO_RECOVERY_ALARM } from './download-recovery';
import { createDownloadRuntime } from './download-runtime';
import { findDownloadHeaders, waitForCapturedHeaders } from './header-capture';
import { authorizeDownload, ensureRetryAuthorization, reportDownloadOutcome } from './license';
import { clearProgress, updateProgress } from './progress';
import { resourceLocator } from './resource-identity';
import { mediaSettingsStorage } from '@extension/storage';
import type {
  DownloadCommand,
  DownloadRuntime,
  ExecutorAdapter,
  ExecutorCommand,
  DownloadSubmission,
} from './download-runtime';
import type { MediaItem, MediaMessage, MediaDownloadStage } from '@extension/shared';

type DownloadPayload = Extract<MediaMessage, { type: 'media/download' }>['payload'];
let adapter: ExecutorAdapter = {};
let recovery: Promise<void> | undefined;
const RECOVERY_ALARM = 'vidsy-download-recovery';
const requestQueueRecovery = () => chrome.alarms.create(RECOVERY_ALARM, { delayInMinutes: 0.5 });
const store = createLocalDownloadStore(chrome.storage.local, chrome.storage.session);
const meteredNetwork = async () => {
  const settings = await mediaSettingsStorage.get();
  const cost = (await chrome.storage.local.get('uuget-network-cost'))['uuget-network-cost'];
  return (settings.pauseOnMeteredNetwork ?? true) && (settings.manuallyMetered || cost?.metered === true);
};
const runtime: DownloadRuntime = createDownloadRuntime({
  store,
  recoverCheckpoint: async job => {
    const { records = [] } = await downloadCache.command({ operation: 'list' });
    const files = records.filter(record => record.jobKey === job.requestId);
    let bytes = 0,
      estimated = 0;
    const completeParents = new Set(files.filter(file => file.complete).map(file => file.name));
    for (const file of files) {
      const parent = file.name.replace(/(?:\.part-\d+|\.init)$/, '');
      if (parent !== file.name && completeParents.has(parent)) continue;
      if (file.complete) bytes += file.complete.size;
      else if (file.ranges) bytes += file.ranges.done.reduce((sum, chunk) => sum + chunk.downloaded, 0);
      if (!file.complete && file.ranges?.checkpoints) {
        const done = new Set(file.ranges.done.map(chunk => chunk.i));
        bytes += file.ranges.checkpoints
          .filter(checkpoint => !done.has(checkpoint.i))
          .reduce((sum, checkpoint) => sum + checkpoint.downloaded, 0);
      }
      if (file.ranges)
        estimated += file.segmentIdentity
          ? file.ranges.source.ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0)
          : file.ranges.source.totalBytes;
    }
    const artifact = files.find(file => file.artifact && file.artifact.expiresAt > Date.now());
    return {
      downloadedBytes: bytes || artifact?.size || 0,
      estimatedBytes: estimated || undefined,
      artifactAvailable: Boolean(artifact),
    };
  },
  // Authenticated manifests can discover additional hosts after dispatch. Until
  // those requests have their own isolated transport, reserve the executor for
  // such jobs. Public jobs still use the configured concurrency.
  canStart: async (job, active) =>
    (!(await meteredNetwork()) || job.execution.allowMetered === true) &&
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
const syncAutomaticRecoveryAlarm = async () => {
  const needed = (await runtime.snapshot()).jobs.some(
    job => ['queued', 'starting', 'running'].includes(job.state) || (job.state === 'paused' && job.recovery),
  );
  if (needed) {
    const current = await chrome.alarms.get(AUTO_RECOVERY_ALARM);
    // Arm before a transfer can fail. A periodic alarm closes the crash gap
    // between persisting paused state and creating its next wakeup, and cannot
    // be postponed by unrelated progress reports. Durable deadlines fence each tick.
    if (!current || current.periodInMinutes !== 0.5)
      await chrome.alarms.create(AUTO_RECOVERY_ALARM, { periodInMinutes: 0.5 });
  } else await chrome.alarms.clear(AUTO_RECOVERY_ALARM);
};
const projectSnapshot = async () => {
  const snapshot = await runtime.snapshot();
  const { records = [] } = await downloadCache.command({ operation: 'list' });
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
        ...(job.state === 'paused' && job.terminal?.reason?.includes('metered')
          ? { resumeNotice: job.terminal.reason }
          : {}),
        ...describeCachedProgress(
          records.filter(record => record.jobKey === job.requestId),
          job.progress.estimatedBytes,
          job.artifactReady && !['succeeded', 'cancelled'].includes(job.state),
        ),
        ...(job.artifactReady && !['succeeded', 'cancelled'].includes(job.state)
          ? { resumeCapability: 'artifact' as const, validationMethod: 'local-checksums' as const }
          : {}),
        ...(job.state === 'failed' && job.terminal?.kind === 'processing' && job.segmentedSource
          ? {
              resumeCapability: 'complete-input' as const,
              resumeNotice:
                'Completed snapshot inputs are retained; Retry reruns processing without downloading media.',
            }
          : {}),
        ...(job.recovery && job.state === 'paused'
          ? {
              resumeNotice: `Connection interrupted; automatic retry ${job.recovery.attempts + 1}/5 after ${new Date(job.recovery.nextRetryAt).toLocaleTimeString()}. Cached progress is retained.`,
            }
          : {}),
        downloadId: job.downloadId,
        queuePosition: job.queuePosition,
        ...(job.state === 'cancelled'
          ? { chunks: [], resumeCapability: job.segmentedSource?.live ? ('none' as const) : ('restart' as const) }
          : {}),
      },
      {
        item: job.execution.item,
        outputFormat: job.execution.outputFormat,
        revision: job.updatedAt,
        clearDownloadId: job.downloadId === undefined,
        cacheExpiresAt: job.cacheExpiresAt,
      },
    );
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') {
      await reportDownloadOutcome({
        downloadKey: job.requestId,
        outcome: job.state === 'succeeded' ? 'success' : job.state,
        bytesDownloaded: job.progress.downloadedBytes,
      });
    }
    projected.set(job.jobId, revision);
  }
  await syncAutomaticRecoveryAlarm();
};

const recoverAutomaticDownloads = async (online = navigator.onLine, immediate = false) => {
  for (const job of (await runtime.snapshot()).jobs)
    if (job.state === 'paused' && job.recovery)
      await commandDownload(job.jobId, { type: 'recovery-check', online, immediate });
  await projectSnapshot();
};
const handleDownloadNetworkChange = async (online: boolean) => {
  if (online) return recoverAutomaticDownloads(true, true);
  for (const job of (await runtime.snapshot()).jobs)
    if (['starting', 'running'].includes(job.state) && ['idle', 'fetching'].includes(job.phase))
      await commandDownload(
        job.jobId,
        job.segmentedSource?.live && !job.execution.reuseSegmentedSnapshot
          ? { type: 'cancel' }
          : { type: 'pause', automatic: true },
      );
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
    if (alarm.name === AUTO_RECOVERY_ALARM) {
      void ready()
        .then(() => recoverAutomaticDownloads())
        .catch(() => undefined);
      return;
    }
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
  if (await meteredNetwork())
    await commandDownload(
      result.jobId,
      {
        type: 'pause',
        metered: true,
        reason: 'Paused on a metered network. Resume explicitly to allow downloading on this connection.',
      },
      false,
    );
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
  const submission: DownloadSubmission = {
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
  };
  const locator = await resourceLocator(submission.execution);
  const { records = [] } = await downloadCache.command({ operation: 'list' });
  const candidates = (await runtime.snapshot()).jobs
    .filter(job => ['paused', 'failed'].includes(job.state))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const job of candidates) {
    if (
      !records.some(
        record =>
          record.jobKey === job.requestId &&
          record.fingerprint &&
          record.expiresAt > Date.now() &&
          (record.ranges?.source.resourceVersion ||
            record.manifestHash ||
            record.ranges?.source.validationMethod === 'boundary-sample') &&
          (record.complete || record.ranges?.done.length || record.ranges?.checkpoints?.length),
      )
    )
      continue;
    if ((await resourceLocator(job.execution)) !== locator) continue;
    const percent = job.progress.estimatedBytes
      ? Math.floor((job.progress.downloadedBytes / job.progress.estimatedBytes) * 100)
      : undefined;
    await updateProgress(
      job.requestId,
      {
        stage: job.state === 'paused' ? 'paused' : 'failed',
        downloadedBytes: job.progress.downloadedBytes,
        resumeNotice:
          percent === undefined
            ? 'Checking cached progress before continuing'
            : `Checking source before continuing from ${percent}%`,
      },
      { revision: job.updatedAt },
    );
    await commandDownload(job.jobId, { type: job.state === 'paused' ? 'resume' : 'retry', revalidateCompleted: true });
    return { jobId: job.jobId, duplicate: true, resumed: true, key: job.requestId };
  }
  await authorizeDownload({ downloadKey: requestId, kind: submission.execution.kind });
  let result: { jobId: string; duplicate: boolean };
  try {
    result = await runtime.submit(submission);
  } catch (error) {
    // The queue never accepted the job, so no bytes moved: release the
    // reservation under the same key.
    await reportDownloadOutcome({ downloadKey: requestId, outcome: 'failed', bytesDownloaded: 0 }).catch(
      () => undefined,
    );
    throw error;
  }
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
  await authorizeDownload({ downloadKey: requestId, kind: execution.kind });
  let result: { jobId: string; duplicate: boolean };
  try {
    result = await runtime.submit({ requestId, execution, display: job.display });
  } catch (error) {
    await reportDownloadOutcome({ downloadKey: requestId, outcome: 'failed', bytesDownloaded: 0 }).catch(
      () => undefined,
    );
    throw error;
  }
  return publishSubmission(result, requestId);
};

const commandDownload = async (key: string, command: DownloadCommand, schedule = true): Promise<boolean> => {
  const job = (await runtime.snapshot()).jobs.find(item => item.requestId === key || item.jobId === key);
  if (!job) return false;
  // Resume never re-authorizes. Retry re-reserves only when the previous
  // attempt released its authorization (zero bytes); committed retries are
  // already paid for under the same download key.
  if (command.type === 'retry') await ensureRetryAuthorization(job.requestId, job.execution.kind);
  const changed = await runtime.command(job.jobId, command);
  if (changed && command.type === 'cancel' && !job.executionId)
    await adapter.cancel?.({
      jobId: job.jobId,
      requestId: job.requestId,
      attempt: job.attempt,
      executionId: `cleanup-${job.jobId}`,
      intent: 'cancel',
    });
  if (changed && ['resume', 'retry'].includes(command.type) && !job.artifactReady) {
    const { records = [] } = await downloadCache.command({ operation: 'list' });
    const bytes = cachedDownloadBytes(records.filter(record => record.jobKey === job.requestId));
    if (bytes > 0)
      await updateProgress(
        job.requestId,
        {
          stage: 'queued',
          downloadedBytes: job.progress.downloadedBytes,
          resumeNotice: `Continuing from ${job.progress.estimatedBytes ? Math.floor((100 * bytes) / job.progress.estimatedBytes) + '%' : bytes + ' bytes'} cached progress. Retained files are checked before reuse.`,
        },
        { revision: (await runtime.snapshot()).jobs.find(current => current.jobId === job.jobId)?.updatedAt },
      );
  }
  if (changed && job.recovery && ['pause', 'resume', 'retry', 'recovery-check'].includes(command.type))
    await updateProgress(job.requestId, {
      downloadedBytes: job.progress.downloadedBytes,
      stage: command.type === 'pause' ? 'paused' : 'queued',
      resumeNotice:
        command.type === 'pause'
          ? 'Paused by you; automatic recovery is stopped.'
          : 'Checking retained progress before continuing',
    });
  await projectSnapshot();
  if (command.type === 'clear-terminal' && changed) {
    projected.delete(job.jobId);
    await clearProgress(job.requestId);
  }
  if (schedule) void runtime.schedule().catch(() => undefined);
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
    if (
      ((!keys && job.state === 'failed') || keys?.includes(job.requestId)) &&
      ['paused', 'failed'].includes(job.state)
    )
      await commandDownload(job.jobId, { type: 'cancel' });
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
const resumeAllDownloads = async () => {
  let resumed = 0;
  for (const job of (await runtime.snapshot()).jobs)
    if (job.state === 'paused' && (await commandDownload(job.jobId, { type: 'resume' }, false))) resumed++;
  void runtime.schedule().catch(() => undefined);
  return resumed;
};
const pauseAllDownloads = async () => {
  let paused = 0;
  for (const job of (await runtime.snapshot()).jobs) {
    if (!['queued', 'starting', 'running', 'finalizing'].includes(job.state)) continue;
    const live = job.segmentedSource?.live && !job.execution.reuseSegmentedSnapshot && !job.artifactReady;
    if (
      await commandDownload(
        job.jobId,
        live
          ? {
              type: 'cancel',
              reason: 'Live snapshot stopped by Pause all; restart explicitly to download a new snapshot.',
            }
          : { type: 'pause' },
        false,
      )
    )
      paused++;
  }
  void runtime.schedule().catch(() => undefined);
  return paused;
};
const pauseMeteredDownloads = async () => {
  if (!(await meteredNetwork())) return 0;
  let paused = 0;
  for (const job of (await runtime.snapshot()).jobs) {
    if (!['queued', 'starting', 'running', 'finalizing'].includes(job.state)) continue;
    const live = job.segmentedSource?.live && !job.execution.reuseSegmentedSnapshot && !job.artifactReady;
    const reason = live
      ? 'Live snapshot stopped on a metered network; restart explicitly to download a new snapshot.'
      : 'Paused on a metered network. Resume explicitly to allow downloading on this connection.';
    if (
      await commandDownload(
        job.jobId,
        live ? { type: 'cancel', reason } : { type: 'pause', metered: true, reason },
        false,
      )
    )
      paused++;
  }
  void runtime.schedule().catch(() => undefined);
  return paused;
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
  resumeAllDownloads,
  pauseAllDownloads,
  pauseMeteredDownloads,
  recoverAutomaticDownloads,
  handleDownloadNetworkChange,
};
export type { ExecutorCommand };
