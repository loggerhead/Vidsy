import 'webextension-polyfill';
import { cleanupBlob } from './lib/blob-cleanup';
import { downloadDashMuxed } from './lib/dash-download';
import { createExecutionRegistry } from './lib/execution-registry';
import { downloadHlsMuxed } from './lib/hls-download';
import { downloadHttpDirect, discardHttpResume } from './lib/http-download';
import { downloadMerged, discardMergedResume } from './lib/merged-download';
import { purgeOpfsOrphans } from './lib/opfs-gc';
import { setExecutionProgressReporter } from './lib/progress';
import { activeAbortControllers, downloadStopIntents } from './lib/segment-fetcher';
import { pingDownloadWorker } from './lib/worker-client';
import { isHlsKind, isDashKind } from '../background/lib/media-utils';
import { createLogger } from '@extension/shared';

const log = createLogger('offscreen');

let started = false;

// Sweep orphaned OPFS files left over from a prior session (crash,
// browser kill, extension reload). Fire-and-forget so the message
// listener stays responsive for fresh downloads.
export const startOffscreen = (): void => {
  if (started) return;
  started = true;

  const storageReady = purgeOpfsOrphans().then(({ removed, failed }) => {
    if (removed > 0 || failed > 0) {
      log.info('opfs.gc_completed', { removed, failed });
    }
  });

  const executions = createExecutionRegistry({
    execute: async command => {
      await storageReady;
      const { url, kind, fileName, outputFormat, headers, audioUrl, audioMimeType, item } = command.execution;
      const key = command.requestId;
      if (downloadStopIntents.has(key)) throw new Error('Download cancelled');
      if (isHlsKind(kind, url))
        return downloadHlsMuxed(url, fileName ?? 'download', outputFormat, key, headers, audioUrl);
      if (isDashKind(kind, url)) return downloadDashMuxed(url, fileName ?? 'download', outputFormat, key, headers);
      if (audioUrl && outputFormat !== 'mp3')
        return downloadMerged(url, audioUrl, item?.mimeType, audioMimeType, key, headers);
      return downloadHttpDirect(url, key, outputFormat, headers);
    },
    stop: async (command, intent) => {
      downloadStopIntents.set(command.requestId, intent);
      activeAbortControllers.get(command.requestId)?.abort();
    },
    publish: report => chrome.runtime.sendMessage({ type: 'offscreen/execution-event', payload: report }),
  });
  setExecutionProgressReporter((key, progress) => executions.progress(key, progress));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log.debug('message.received', {
      type: message.type,
      key: message.payload?.key,
      url: message.payload?.url,
      kind: message.payload?.kind,
    });
    if (message.type === 'offscreen/executions') {
      sendResponse({ ok: true, records: executions.inventory() });
      return;
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
      void cleanupBlob(message.payload.blobUrl).finally(() => sendResponse({ ok: true }));
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
