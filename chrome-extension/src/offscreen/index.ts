import 'webextension-polyfill';
import { cleanupBlob } from './lib/blob-cleanup';
import { cacheCommand } from './lib/cache-client';
import { downloadDashMuxed } from './lib/dash-download';
import { DownloadFailure } from './lib/download-failure';
import { setDownloadDiagnosticReporter } from './lib/download-log';
import { createExecutionRegistry } from './lib/execution-registry';
import { downloadHlsMuxed } from './lib/hls-download';
import { scopeHeaders } from './lib/hls-request';
import { downloadHttpDirect, discardHttpResume, discardCompletedHttpInput } from './lib/http-download';
import { downloadMerged, discardMergedResume } from './lib/merged-download';
import { detectNetworkCost } from './lib/network-cost';
import { purgeOpfsOrphans } from './lib/opfs-gc';
import { restoreSavedOutput } from './lib/output-delivery';
import { setExecutionProgressReporter } from './lib/progress';
import { activeAbortControllers, downloadStopIntents } from './lib/segment-fetcher';
import { requestPersistentCacheStorage } from './lib/storage-persistence';
import { pingDownloadWorker, discardWorkerJobFiles, cancelWorkerJob } from './lib/worker-client';
import { isHlsKind, isDashKind } from '../background/lib/media-utils';
import { isExpiredSourceFailure } from '../background/lib/source-renewal';
import { createLogger } from '@extension/shared';

const log = createLogger('offscreen');

let started = false;

// Sweep orphaned OPFS files left over from a prior session (crash,
// browser kill, extension reload). Fire-and-forget so the message
// listener stays responsive for fresh downloads.
export const startOffscreen = (): void => {
  if (started) return;
  started = true;
  const connection = (navigator as Navigator & { connection?: EventTarget & { type?: string; saveData?: boolean } })
    .connection;
  const reportNetworkCost = () => {
    void chrome.runtime
      .sendMessage({ type: 'offscreen/network-cost', payload: detectNetworkCost(connection) })
      .catch(() => undefined);
  };
  connection?.addEventListener('change', reportNetworkCost);
  reportNetworkCost();
  const reportNetwork = () => {
    void chrome.runtime
      .sendMessage({ type: 'offscreen/network-state', online: navigator.onLine })
      .catch(() => undefined);
  };
  window.addEventListener('online', reportNetwork);
  window.addEventListener('offline', reportNetwork);

  setDownloadDiagnosticReporter((event, data) => {
    void chrome.runtime
      .sendMessage({ type: 'offscreen/download-diagnostic', payload: { event, data } })
      .catch(() => undefined);
  });

  const collectCache = async (startup: boolean) => {
    const { records = [] } = await cacheCommand({ operation: 'list' });
    const policy = await chrome.runtime.sendMessage({ type: 'offscreen/cache-policy' });
    const { quota } = await navigator.storage.estimate();
    return purgeOpfsOrphans({
      records,
      liveJobs: new Set(policy.jobKeys),
      activeJobs: startup ? new Set() : new Set([...policy.activeJobKeys, ...activeAbortControllers.keys()]),
      ttlMs: policy.ttlMs,
      maxBytes: policy.maxBytes ?? (quota ? Math.floor(quota * 0.85) : 5 * 1024 ** 3),
      removeFile: startup ? undefined : discardCompletedHttpInput,
      removeRecord: async name => {
        await cacheCommand({ operation: 'remove', name });
      },
      removeArtifact: async record => {
        await cacheCommand({
          operation: 'remove-artifact',
          name: record.name,
        });
      },
      invalidated: async (jobKey, reason) => {
        await chrome.runtime.sendMessage({ type: 'offscreen/cache-invalidated', payload: { jobKey, reason } });
      },
    });
  };
  let persistence = { supported: false, persisted: false };
  const storageReady = requestPersistentCacheStorage(navigator.storage)
    .then(async result => {
      persistence = result;
      await chrome.runtime.sendMessage({ type: 'offscreen/cache-status', payload: result });
      return collectCache(true);
    })
    .then(({ removed, failed }) => {
      if (removed > 0 || failed > 0) {
        log.info('opfs.gc_completed', { removed, failed });
      }
    });

  const executions = createExecutionRegistry({
    execute: async command => {
      await storageReady;
      for (let attempt = 0; ; attempt++) {
        try {
          const { url, kind, fileName, outputFormat, headers, audioHeaders, audioUrl, audioMimeType, item } =
            command.execution;
          const key = command.requestId;
          if (downloadStopIntents.has(key)) throw new Error('Download cancelled');
          if (command.resumeDelivery) {
            const controller = new AbortController();
            activeAbortControllers.set(key, controller);
            try {
              return await restoreSavedOutput(key, controller.signal);
            } finally {
              activeAbortControllers.delete(key);
            }
          }
          if (isHlsKind(kind, url))
            return await downloadHlsMuxed(
              url,
              fileName ?? 'download',
              outputFormat,
              key,
              headers,
              audioUrl,
              audioHeaders,
            );
          if (isDashKind(kind, url))
            return await downloadDashMuxed(url, fileName ?? 'download', outputFormat, key, headers);
          if (audioUrl && outputFormat !== 'mp3')
            return await downloadMerged(
              url,
              audioUrl,
              item?.mimeType,
              audioMimeType,
              key,
              headers,
              command.execution.revalidateCompleted,
              audioHeaders,
            );
          return await downloadHttpDirect(url, key, outputFormat, headers, command.execution.revalidateCompleted);
        } catch (error) {
          if (!isExpiredSourceFailure(error) || command.resumeDelivery || downloadStopIntents.has(command.requestId))
            throw error;
          if (attempt > 0)
            throw new DownloadFailure(
              'transport',
              'Source still returned 403/410 after one refresh. Refresh the original page and re-detect the media; cached progress is retained.',
              { cause: error },
              false,
            );
          const response = await chrome.runtime.sendMessage({
            type: 'offscreen/renew-source',
            payload: { key: command.requestId, executionId: command.executionId },
          });
          if (!response?.ok)
            throw new DownloadFailure(
              'transport',
              `Source refresh failed (${error instanceof Error ? error.message : String(error)}). Refresh the original page and re-detect the media; cached progress is retained. ${response?.error ?? ''}`,
              { cause: error },
              false,
            );
          command.execution = {
            ...response.execution,
            headers: scopeHeaders(response.execution.headers, response.execution.url),
            audioHeaders: response.execution.audioUrl
              ? scopeHeaders(response.execution.audioHeaders, response.execution.audioUrl)
              : undefined,
          };
        }
      }
    },
    stop: async (command, intent) => {
      downloadStopIntents.set(command.requestId, intent);
      activeAbortControllers.get(command.requestId)?.abort();
      cancelWorkerJob(command.requestId);
    },
    publish: report => chrome.runtime.sendMessage({ type: 'offscreen/execution-event', payload: report }),
    discard: command =>
      Promise.all([
        discardHttpResume(command.requestId),
        discardMergedResume(command.requestId),
        discardWorkerJobFiles(command.requestId),
      ]).then(() => undefined),
  });
  setExecutionProgressReporter((key, progress) => executions.progress(key, progress));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log.debug('message.received', {
      type: message.type,
      key: message.payload?.key,
      url: message.payload?.url,
      kind: message.payload?.kind,
    });
    if (message.type === 'offscreen/cache-status-read') {
      void storageReady.then(() => sendResponse({ ok: true, persistence }));
      return true;
    }
    if (message.type === 'offscreen/executions') {
      sendResponse({ ok: true, records: executions.inventory() });
      return;
    }
    if (message.type === 'offscreen/collect-download-cache') {
      void storageReady
        .then(() => collectCache(false))
        .then(
          result => sendResponse({ ok: true, ...result }),
          error => sendResponse({ ok: false, error: String(error) }),
        );
      return true;
    }
    if (message.type === 'offscreen/start-execution') {
      try {
        executions.start(message.payload.command);
        sendResponse({
          ok: true,
          report: executions
            .inventory()
            .find(record => record.command.executionId === message.payload.command.executionId)?.report,
        });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
      return;
    }
    if (message.type === 'offscreen/stop-execution') {
      const known = executions.inventory().some(record => record.command.executionId === message.payload.executionId);
      void (
        known
          ? executions.stop(message.payload.executionId, message.payload.intent)
          : message.payload.intent === 'cancel'
            ? Promise.all([
                discardHttpResume(message.payload.requestId),
                discardMergedResume(message.payload.requestId),
                discardWorkerJobFiles(message.payload.requestId),
              ])
            : Promise.resolve()
      ).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'offscreen/forget-execution') {
      const record = executions.inventory().find(record => record.command.executionId === message.payload.executionId);
      if (record) downloadStopIntents.delete(record.command.requestId);
      executions.forget(message.payload.executionId);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'offscreen/cleanup-blob') {
      void cleanupBlob(message.payload.blobUrl, { preserveOutput: message.payload.preserveOutput }).finally(() =>
        sendResponse({ ok: true }),
      );
      return true;
    }

    // Readiness probe for the production-package smoke test. This exercises
    // the real WXT-emitted worker URL without introducing a second download
    // implementation or exposing any product state.
    if (message.type === 'offscreen/worker-ready') {
      void pingDownloadWorker()
        .then(() => sendResponse({ ok: true, workerUrl: chrome.runtime.getURL('download-worker.js') }))
        .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    return false;
  });
};
