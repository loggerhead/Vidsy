import { browserDownloadTerminal } from './browser-download-state';
import { downloadCache } from './download-cache-store';
import { recordDownloadDiagnostic } from './download-diagnostics';
import {
  runtime,
  projectSnapshot,
  pauseAllDownloads,
  pauseMeteredDownloads,
  resumeAllDownloads,
  enqueueDownload,
  resubmitDownload,
  commandDownload,
  setQueueExecutor,
  requestQueueRecovery,
  cancelDownloadsForTab as cancelTabJobs,
  clearDownloads as clearJobList,
} from './download-queue';
import {
  injectHeadersForDownload,
  removeHeadersForDownload,
  authorizeUrlForDownload,
  cleanupStaleDnrRules,
} from './header-capture';
import { addHistoryEntry } from './history';
import { PaymentRequiredError } from './license';
import { createId, deriveKind, deriveFileName, sanitizeFileName } from './media-utils';
import { updateProgress } from './progress';
import { createProgressPublisher } from './progress-publisher';
import { executorIdentity } from '../../offscreen/lib/execution-registry';
import { scopeHeaders } from '../../offscreen/lib/hls-request';
import { buildFilenameContext, renderFilenameTemplate } from '@extension/shared';
import { mediaSettingsStorage } from '@extension/storage';
import type { ExecutorAdapter, ExecutorCommand, ExecutorInventory } from './download-runtime';
import type { ExecutionRecord, ExecutionReport } from '../../offscreen/lib/execution-registry';
import type { MediaItem, MediaMessage, SubtitleFormat } from '@extension/shared';

type DownloadPayload = Extract<MediaMessage, { type: 'media/download' }>['payload'];
let offscreenCreation: Promise<void> | undefined;
const hasOffscreen = async () =>
  (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length > 0;
const ensureOffscreen = () =>
  (offscreenCreation ??= (async () => {
    if (!(await hasOffscreen()))
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Stream media into OPFS and process it in a worker',
      });
  })().finally(() => {
    offscreenCreation = undefined;
  }));

const sendOffscreen = async (message: object, retries = 1) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error ?? 'Offscreen executor unavailable');
      return response;
    } catch (error) {
      if (
        attempt >= retries - 1 ||
        !/Receiving end|message port closed|Offscreen executor unavailable/i.test(String(error))
      )
        throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
};
const inventoryRecords = async (): Promise<ExecutionRecord[]> => {
  if (!(await hasOffscreen())) {
    return [];
  }
  return (await sendOffscreen({ type: 'offscreen/executions' })).records;
};
const forgetExecution = async (command: ExecutorCommand) => {
  reportSequences.delete(command.executionId);
  reportedStages.delete(command.executionId);
  await removeHeadersForDownload(command.executionId);
  await chrome.runtime
    .sendMessage({ type: 'offscreen/forget-execution', payload: { executionId: command.executionId } })
    .catch(() => undefined);
};

// Events and browser delivery are serialized with each other. Identity fencing
// in the durable runtime rejects old attempts before any UI write or side effect.
let eventTail = Promise.resolve();
const serializeEvent = <T>(operation: () => Promise<T>): Promise<T> => {
  const pending = eventTail.then(operation);
  eventTail = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
};
const reportSequences = new Map<string, number>();
const reportedStages = new Map<string, string>();
const processReport = async (report: ExecutionReport): Promise<void> => {
  const { command } = report;
  const identity = executorIdentity(command);
  const job = (await runtime.snapshot()).jobs.find(job => job.jobId === command.jobId);
  if (
    !job ||
    job.executionId !== command.executionId ||
    job.attempt !== command.attempt ||
    ['succeeded', 'failed', 'cancelled', 'paused'].includes(job.state)
  ) {
    if (
      job?.state === 'paused' &&
      job.artifactReady &&
      job.executionId === command.executionId &&
      job.attempt === command.attempt
    )
      return;
    await projectSnapshot();
    if (report.type === 'output')
      await sendOffscreen({ type: 'offscreen/cleanup-blob', payload: { blobUrl: report.output.blobUrl } });
    await forgetExecution(command);
    return;
  }
  if (report.sequence !== undefined) {
    if (report.sequence <= (reportSequences.get(command.executionId) ?? -1)) return;
    // Commit only after processing: an unacknowledged storage failure retries.
  }
  if (report.type !== 'progress' || reportedStages.get(command.executionId) !== report.progress.stage) {
    recordDownloadDiagnostic('execution.' + report.type, {
      key: command.requestId,
      executionId: command.executionId,
      stage: report.type === 'progress' ? report.progress.stage : undefined,
      error: report.type === 'failed' ? report.reason : undefined,
    });
    if (report.type === 'progress') reportedStages.set(command.executionId, report.progress.stage ?? 'init');
  }
  // A terminal event may overtake a coalesced progress report. Persist its
  // final checkpoint first so an immediate block failure cannot erase the
  // completed byte count or chunk display from the task ledger.
  if ((report.type === 'failed' || report.type === 'cancelled') && report.progress) {
    const progress = report.progress;
    const accepted = await runtime.executorEvent({
      ...identity,
      type: 'progress',
      downloadedBytes: progress.downloadedBytes ?? 0,
      estimatedBytes: progress.estimatedBytes,
      phase: progress.stage === 'mux' ? 'processing' : 'fetching',
    });
    const checkpoint = (await runtime.snapshot()).jobs.find(job => job.jobId === command.jobId);
    if (accepted)
      await updateProgress(
        command.requestId,
        {
          ...progress,
          stage: progress.stage ?? 'init',
          downloadedBytes: checkpoint?.progress.downloadedBytes ?? 0,
        },
        { revision: checkpoint?.updatedAt },
      );
  }
  if (report.type === 'acknowledged') {
    await runtime.executorEvent({ ...identity, type: 'acknowledged' });
  } else if (report.type === 'progress') {
    const accepted = await runtime.executorEvent({
      ...identity,
      type: 'progress',
      downloadedBytes: report.progress.downloadedBytes ?? 0,
      estimatedBytes: report.progress.estimatedBytes,
      phase: report.progress.stage === 'mux' ? 'processing' : 'fetching',
    });
    const latest = (await runtime.snapshot()).jobs.find(job => job.jobId === command.jobId);
    if (accepted && !latest?.cancelRequested && !latest?.pauseRequested)
      await updateProgress(
        command.requestId,
        {
          ...report.progress,
          stage: report.progress.stage ?? 'init',
          downloadedBytes: latest?.progress.downloadedBytes ?? report.progress.downloadedBytes ?? 0,
        },
        { revision: latest?.updatedAt, cacheExpiresAt: latest?.cacheExpiresAt },
      );
  } else if (report.type === 'output') {
    if (job.state === 'starting') await runtime.executorEvent({ ...identity, type: 'acknowledged' });
    if (job.state !== 'finalizing') await runtime.executorEvent({ ...identity, type: 'ready' });
    if (job.cancelRequested || job.pauseRequested)
      await stopExecution({
        ...identity,
        requestId: command.requestId,
        intent: job.pauseRequested ? 'pause' : 'cancel',
      });
    else beginDelivery(report);
  } else {
    // Release credentials before releasing the scheduling slot. A new job may
    // otherwise start between the terminal commit and rule cleanup.
    await removeHeadersForDownload(command.executionId);
    if (
      await runtime.executorEvent(
        report.type === 'failed'
          ? {
              ...identity,
              type: 'failed',
              reason: report.reason,
              recoverable: report.recoverable,
              failureKind: report.failureKind,
            }
          : { ...identity, type: 'cancelled' },
      )
    ) {
      if (
        report.type === 'failed' &&
        command.execution.item &&
        (await runtime.snapshot()).jobs.find(job => job.jobId === command.jobId)?.state === 'failed'
      )
        await addHistoryEntry(command.execution.item, 'failed', report.reason);
      await forgetExecution(command);
    }
  }
  await projectSnapshot();
  if (report.sequence !== undefined && report.type !== 'failed' && report.type !== 'cancelled')
    reportSequences.set(command.executionId, report.sequence);
  void runtime.schedule().catch(() => undefined);
};
const progressPublisher = createProgressPublisher<ExecutionReport>(report =>
  serializeEvent(() => processReport(report)),
);
const handleExecutionReport = (report: ExecutionReport) =>
  progressPublisher.publish(
    report.command.executionId,
    report.type === 'progress' ? (report.progress.stage ?? 'init') : report.type,
    report,
    report.type !== 'progress',
  );

const reconcileBrowserDownload = async (downloadId: number) => {
  const [download] = await chrome.downloads.search({ id: downloadId });
  if (download && !browserDownloadTerminal(download.state, download.error)) return;
  const job = (await runtime.snapshot()).jobs.find(job => job.downloadId === downloadId);
  if (!job || job.state !== 'finalizing') return;
  const state = download?.state === 'complete' ? 'complete' : 'interrupted';
  const reason = download ? download.error : 'Browser download record unavailable';
  const records = await inventoryRecords();
  const record = records.find(record => record.command.executionId === job.executionId);
  if (record?.report.type === 'output')
    await sendOffscreen({
      type: 'offscreen/cleanup-blob',
      payload: { blobUrl: record.report.output.blobUrl, preserveOutput: state !== 'complete' },
    });
  if (state === 'complete') {
    await ensureOffscreen();
    await sendOffscreen({
      type: 'offscreen/stop-execution',
      payload: {
        jobId: job.jobId,
        requestId: job.requestId,
        executionId: job.executionId,
        attempt: job.attempt,
        intent: 'cancel',
      },
    });
  }
  await removeHeadersForDownload(job.executionId ?? job.requestId);
  const accepted = await runtime.browserDelivery({
    jobId: job.jobId,
    downloadId,
    state,
    reason,
  });
  if (!accepted) return;
  if (record) await forgetExecution(record.command);
  if (job.execution.item)
    await addHistoryEntry(job.execution.item, state === 'complete' ? 'success' : 'failed', reason, downloadId);
};
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state?.current || !['complete', 'interrupted'].includes(delta.state.current)) return;
  void serializeEvent(async () => {
    await reconcileBrowserDownload(delta.id);
    await projectSnapshot();
    await runtime.schedule();
  });
});

// Browser acceptance can itself wait on I/O. Keep it outside the event queue
// so pause/cancel and new submissions can still reach the durable authority.
const deliveries = new Map<string, { phase: 'searching' | 'creating' }>();
const stopExecution: NonNullable<ExecutorAdapter['cancel']> = async identity => {
  const job = (await runtime.snapshot()).jobs.find(job => job.jobId === identity.jobId);
  if (!job) return;
  if (!job.artifactReady) {
    if (identity.intent === 'cancel' && !(await hasOffscreen())) await ensureOffscreen();
    if (await hasOffscreen()) await sendOffscreen({ type: 'offscreen/stop-execution', payload: identity });
    return;
  }
  if (job.downloadId === undefined && deliveries.get(identity.executionId)?.phase === 'creating') return;
  if (job.downloadId !== undefined) {
    await chrome.downloads.cancel(job.downloadId).catch(() => undefined);
    const [native] = await chrome.downloads.search({ id: job.downloadId });
    if (native?.state === 'complete' && job.state === 'finalizing') {
      await reconcileBrowserDownload(job.downloadId);
      return;
    }
  }
  const record = (await inventoryRecords()).find(record => record.command.executionId === identity.executionId);
  if (identity.intent === 'cancel' && record?.report.type === 'output')
    await sendOffscreen({ type: 'offscreen/cleanup-blob', payload: { blobUrl: record.report.output.blobUrl } });
  if (identity.intent === 'cancel') {
    await ensureOffscreen();
    await sendOffscreen({ type: 'offscreen/stop-execution', payload: identity });
  }
  await removeHeadersForDownload(identity.executionId);
  await runtime.executorEvent({ ...identity, type: 'cancelled' });
  if (identity.intent === 'cancel' && record) await forgetExecution(record.command);
};
const collectDownloadCache = () =>
  serializeEvent(async () => {
    const existed = await hasOffscreen();
    await ensureOffscreen();
    const result = await sendOffscreen({ type: 'offscreen/collect-download-cache' });
    if (!existed) {
      const jobs = (await runtime.snapshot()).jobs;
      if (
        !jobs.some(
          job =>
            ['queued', 'starting', 'running', 'finalizing'].includes(job.state) ||
            (job.artifactReady && job.state === 'paused'),
        )
      )
        await chrome.offscreen.closeDocument();
    }
    return result;
  });
const beginDelivery = (report: Extract<ExecutionReport, { type: 'output' }>) => {
  const { command, output } = report;
  if (deliveries.has(command.executionId)) return;
  const delivery = { phase: 'searching' as 'searching' | 'creating' };
  deliveries.set(command.executionId, delivery);
  void Promise.resolve()
    .then(async () => {
      const escaped = output.blobUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const previous = await chrome.downloads.search({ url: `^${escaped}$` });
      const job = (await runtime.snapshot()).jobs.find(job => job.jobId === command.jobId);
      if (!job || job.state !== 'finalizing' || job.executionId !== command.executionId) return;
      if (job.pauseRequested || job.cancelRequested) {
        await serializeEvent(() =>
          stopExecution({
            ...executorIdentity(command),
            requestId: command.requestId,
            intent: job.pauseRequested ? 'pause' : 'cancel',
          }),
        );
        return;
      }
      const accepted = previous.find(item => item.state === 'complete' || item.state === 'in_progress');
      const ext = output.artifact.extension;
      const name = command.execution.fileName ?? deriveFileName(command.execution.url, command.execution.title);
      delivery.phase = 'creating';
      const downloadId =
        accepted?.id ??
        (await chrome.downloads.download({
          url: output.blobUrl,
          filename: name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`,
          conflictAction: 'uniquify',
          saveAs: false,
        }));
      await serializeEvent(async () => {
        if (!(await runtime.executorEvent({ ...executorIdentity(command), type: 'artifact', downloadId }))) {
          await chrome.downloads.cancel(downloadId).catch(() => undefined);
          return;
        }
        const current = (await runtime.snapshot()).jobs.find(job => job.jobId === command.jobId)!;
        if (current.pauseRequested || current.cancelRequested)
          await stopExecution({
            ...executorIdentity(command),
            requestId: command.requestId,
            intent: current.pauseRequested ? 'pause' : 'cancel',
          });
        else await reconcileBrowserDownload(downloadId);
        await projectSnapshot();
        await runtime.schedule();
      });
    })
    .catch(async error => {
      deliveries.delete(command.executionId);
      const current = (await runtime.snapshot()).jobs.find(job => job.jobId === command.jobId);
      if (current?.pauseRequested || current?.cancelRequested) {
        await serializeEvent(async () => {
          await stopExecution({
            ...executorIdentity(command),
            requestId: command.requestId,
            intent: current.pauseRequested ? 'pause' : 'cancel',
          });
          await projectSnapshot();
          await runtime.schedule();
        });
      } else await handleExecutionReport({ command, type: 'failed', reason: String(error) });
    })
    .finally(() => {
      deliveries.delete(command.executionId);
    });
};

const queueReady = setQueueExecutor(
  {
    inventory: async (): Promise<ExecutorInventory> => {
      // Startup recovery owns stale-rule collection. Ordinary inventory reads
      // must never sweep rules while another job creates the offscreen page.
      if (!(await hasOffscreen())) await cleanupStaleDnrRules();
      return {
        executions: (await inventoryRecords()).map(({ command }) => ({
          ...executorIdentity(command),
          requestId: command.requestId,
          acknowledged: true,
        })),
      };
    },
    start: async command => {
      try {
        await ensureOffscreen();
        const current = (await runtime.snapshot()).jobs.find(job => job.jobId === command.jobId);
        if (current?.cancelRequested || current?.pauseRequested) {
          await runtime.executorEvent({ ...executorIdentity(command), type: 'cancelled' });
          await projectSnapshot();
          await runtime.schedule();
          return;
        }
        const settings = await mediaSettingsStorage.get();
        const execution = command.execution;
        if (execution.headers) {
          await injectHeadersForDownload(execution.url, execution.headers, command.executionId, command.display.tabId);
        }
        if (execution.audioUrl) {
          if (execution.audioHeaders)
            await injectHeadersForDownload(
              execution.audioUrl,
              execution.audioHeaders,
              command.executionId,
              command.display.tabId,
            );
          else await authorizeUrlForDownload(command.executionId, execution.audioUrl);
        }
        const fileName = settings.filenameTemplate
          ? renderFilenameTemplate(
              settings.filenameTemplate,
              buildFilenameContext(
                {
                  ...execution.item,
                  title: execution.title,
                  kind: execution.kind as MediaItem['kind'],
                  url: execution.url,
                },
                { ext: execution.outputFormat },
              ),
            )
          : (execution.fileName ?? deriveFileName(execution.url, execution.title));
        const prepared: ExecutorCommand = {
          ...command,
          execution: {
            ...execution,
            fileName,
            headers: scopeHeaders(execution.headers, execution.url),
            audioHeaders: execution.audioUrl ? scopeHeaders(execution.audioHeaders, execution.audioUrl) : undefined,
          },
        };
        await updateProgress(
          command.requestId,
          { stage: 'init', downloadedBytes: current?.progress.downloadedBytes ?? 0 },
          {
            item: execution.item,
            outputFormat: execution.outputFormat,
            revision: current?.updatedAt,
            reset: true,
            clearDownloadId: true,
          },
        );
        // Replaying the same execution identity is safe, including a lost ack.
        const accepted = await sendOffscreen({ type: 'offscreen/start-execution', payload: { command: prepared } }, 10);
        if (accepted.report) await handleExecutionReport(accepted.report);
      } catch (error) {
        // A failed response is not proof that the start was rejected. Query the
        // executor before deciding whether it is safe to fail or replay a claim.
        let records: ExecutionRecord[];
        try {
          records = await inventoryRecords();
        } catch {
          await requestQueueRecovery();
          return;
        }
        const known = records.find(record => record.command.executionId === command.executionId);
        await handleExecutionReport(
          known?.report ?? { command, type: 'failed', reason: error instanceof Error ? error.message : String(error) },
        );
      }
    },
    cancel: stopExecution,
    resumeDelivery: async jobId => {
      const job = (await runtime.snapshot()).jobs.find(job => job.jobId === jobId);
      const record = (await inventoryRecords()).find(record => record.command.executionId === job?.executionId);
      if (!job || !job.executionId) throw new Error('Saved delivery task unavailable');
      if (record?.report.type === 'output') {
        beginDelivery(record.report);
        return;
      }
      await ensureOffscreen();
      const command: ExecutorCommand = {
        jobId: job.jobId,
        requestId: job.requestId,
        attempt: job.attempt,
        executionId: job.executionId,
        execution: job.execution,
        display: job.display,
        resumeDelivery: true,
      };
      const accepted = await sendOffscreen({ type: 'offscreen/start-execution', payload: { command } }, 10);
      if (accepted.report) await handleExecutionReport(accepted.report);
    },
  },
  async () => {
    for (const record of await inventoryRecords()) await handleExecutionReport(record.report);
    for (const job of (await runtime.snapshot()).jobs)
      if (job.downloadId !== undefined && job.state === 'finalizing')
        await serializeEvent(() => reconcileBrowserDownload(job.downloadId!));
  },
);

const deriveSubtitleFormat = (url: string): SubtitleFormat =>
  /\.srt/i.test(url)
    ? 'srt'
    : /\.ttml|\.dfxp/i.test(url)
      ? 'ttml'
      : /timedtext/.test(url) && !/fmt=vtt/.test(url)
        ? 'xml'
        : 'vtt';
const handleDownload = async (payload: DownloadPayload) => {
  if (payload.kind === 'subtitle') {
    const format = payload.subtitleFormat ?? deriveSubtitleFormat(payload.url);
    const base = payload.fileName
      ? payload.fileName.replace(/\.[a-z0-9]{1,5}$/i, '')
      : sanitizeFileName(payload.title ?? 'subtitle');
    const downloadId = await chrome.downloads.download({
      url: payload.url,
      filename: `${base}${payload.subtitleLang ? `.${payload.subtitleLang}` : ''}.${format}`,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    return { ok: true, downloadId };
  }
  if (payload.item?.isDrmProtected) return { ok: false, error: 'DRM-protected stream cannot be downloaded' };
  await queueReady();
  const item: MediaItem = payload.item
    ? { ...payload.item, tabId: payload.tabId ?? payload.item.tabId }
    : {
        id: createId(),
        url: payload.url,
        kind: payload.kind ?? deriveKind(payload.url),
        detectedAt: Date.now(),
        source: 'network',
        title: payload.title,
        fileName: payload.fileName,
        tabId: payload.tabId,
      };
  try {
    return await serializeEvent(async () => ({ ok: true, queued: true, ...(await enqueueDownload(payload, item)) }));
  } catch (error) {
    if (error instanceof PaymentRequiredError)
      return {
        ok: false,
        code: 'PAYMENT_REQUIRED' as const,
        error: error.message,
        free: error.verdict.free,
        credits: error.verdict.credits,
        subscription: error.verdict.subscription,
        upgrade: error.verdict.upgrade,
      };
    throw error;
  }
};
const againDownload = (key: string, requestId: string) => serializeEvent(() => resubmitDownload(key, requestId));
const pauseDownload = (key: string) => serializeEvent(() => commandDownload(key, { type: 'pause' }));
const cancelDownload = (key: string) => serializeEvent(() => commandDownload(key, { type: 'cancel' }));
const retryDownload = (key: string, intent: 'resume' | 'retry') =>
  serializeEvent(() => commandDownload(key, { type: intent }));
const cancelDownloadsForTab = (tabId: number) => serializeEvent(() => cancelTabJobs(tabId));
const clearDownloads = (keys?: string[]) => serializeEvent(() => clearJobList(keys));
const handleMeteredDownloads = () => serializeEvent(pauseMeteredDownloads);
const batchPauseDownloads = () => serializeEvent(pauseAllDownloads);
const batchResumeDownloads = () => serializeEvent(resumeAllDownloads);
const cacheOverview = async () => {
  await ensureOffscreen();
  const status = await sendOffscreen({ type: 'offscreen/cache-status-read' });
  const { records = [] } = await downloadCache.command({ operation: 'list' });
  const jobs = (await runtime.snapshot()).jobs;
  const rows = jobs
    .map(job => ({
      key: job.requestId,
      title: job.display.title ?? job.execution.fileName ?? 'Download',
      state: job.state,
      allocatedBytes: records
        .filter(record => record.jobKey === job.requestId)
        .reduce((sum, record) => sum + record.size, 0),
      expiresAt: Math.max(
        0,
        ...records.filter(record => record.jobKey === job.requestId).map(record => record.expiresAt),
      ),
      clearable: ['paused', 'failed'].includes(job.state),
    }))
    .filter(row => row.allocatedBytes > 0);
  return {
    rows,
    allocatedBytes: rows.reduce((sum, row) => sum + row.allocatedBytes, 0),
    networkCost: (await chrome.storage.local.get('uuget-network-cost'))['uuget-network-cost'],
    persistence: status.persistence,
  };
};
const discardCachedDownloads = (keys?: string[]) =>
  serializeEvent(async () => {
    let cleared = 0;
    for (const job of (await runtime.snapshot()).jobs)
      if (['paused', 'failed'].includes(job.state) && (!keys || keys.includes(job.requestId))) {
        await commandDownload(job.jobId, { type: 'cancel' });
        cleared++;
      }
    return cleared;
  });
export {
  handleDownload,
  handleMeteredDownloads,
  batchPauseDownloads,
  batchResumeDownloads,
  cacheOverview,
  discardCachedDownloads,
  againDownload,
  pauseDownload,
  cancelDownload,
  retryDownload,
  cancelDownloadsForTab,
  clearDownloads,
  collectDownloadCache,
  handleExecutionReport,
};
