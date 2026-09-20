import 'webextension-polyfill';
import { cleanupBlob } from './lib/blob-cleanup';
import { downloadDashMuxed } from './lib/dash-download';
import { downloadHlsMuxed } from './lib/hls-download';
import { downloadHttpDirect } from './lib/http-download';
import { downloadMerged } from './lib/merged-download';
import { purgeOpfsOrphans } from './lib/opfs-gc';
import { activeAbortControllers } from './lib/segment-fetcher';
import { pingDownloadWorker } from './lib/worker-client';
import { createLogger } from '@extension/shared';

const log = createLogger('offscreen');

let started = false;

// Sweep orphaned OPFS files left over from a prior session (crash,
// browser kill, extension reload). Fire-and-forget so the message
// listener stays responsive for fresh downloads.
export const startOffscreen = (): void => {
  if (started) return;
  started = true;

  void purgeOpfsOrphans().then(({ removed, failed }) => {
    if (removed > 0 || failed > 0) {
      log.info('opfs.gc_completed', { removed, failed });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log.debug('message.received', {
      type: message.type,
      key: message.payload?.key,
      url: message.payload?.url,
      kind: message.payload?.kind,
    });
    if (message.type === 'offscreen/cleanup-blob') {
      void cleanupBlob(message.payload.blobUrl).finally(() => sendResponse({ ok: true }));
      return true;
    }

    if (message.type === 'offscreen/cancel') {
      const { key } = message.payload;
      const controller = activeAbortControllers.get(key);
      if (controller) {
        controller.abort();
        activeAbortControllers.delete(key);
      }
      log.debug('cancel', { key, hadController: Boolean(controller) });
      sendResponse({ ok: true });
      return;
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

    if (message.type === 'offscreen/download-blob') {
      const { kind, url, fileName, output, key, headers, audioUrl, videoMimeType, audioMimeType } = message.payload;
      const handle = (
        p: ReturnType<
          typeof downloadHlsMuxed | typeof downloadDashMuxed | typeof downloadMerged | typeof downloadHttpDirect
        >,
      ) =>
        p
          .then(result => {
            log.debug('download.success', { key, kind, result });
            sendResponse({ ok: true, ...result });
          })
          .catch(err => {
            log.error('download.failed', { key, kind, error: err });
            sendResponse({ ok: false, error: String(err) });
          });

      log.debug('download.started', {
        key,
        kind,
        url,
        audioUrl: audioUrl ? '[present]' : undefined,
        fileName,
      });

      if (kind === 'hls') {
        handle(downloadHlsMuxed(url, fileName, output, key, headers, audioUrl));
      } else if (kind === 'dash') {
        handle(downloadDashMuxed(url, fileName, output, key, headers));
      } else if (kind === 'merged') {
        handle(downloadMerged(url, audioUrl, videoMimeType, audioMimeType, key, headers));
      } else if (kind === 'http') {
        handle(downloadHttpDirect(url, key, output, headers));
      }
      return true;
    }
    return false;
  });
};
