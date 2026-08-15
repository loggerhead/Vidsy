import 'webextension-polyfill';
import { cleanupBlob } from './lib/blob-cleanup';
import { downloadDashMuxed } from './lib/dash-download';
import { downloadHlsMuxed } from './lib/hls-download';
import { downloadHttpDirect } from './lib/http-download';
import { downloadMerged } from './lib/merged-download';
import { purgeOpfsOrphans } from './lib/opfs-gc';
import { activeAbortControllers } from './lib/segment-fetcher';

// Sweep orphaned OPFS files left over from a prior session (crash,
// browser kill, extension reload). Fire-and-forget so the message
// listener stays responsive for fresh downloads.
void purgeOpfsOrphans().then(({ removed, failed }) => {
  if (removed > 0 || failed > 0) {
    console.log(`[Vidsy] OPFS GC: removed ${removed}, failed ${failed}`);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    sendResponse({ ok: true });
    return;
  }

  if (message.type === 'offscreen/download-blob') {
    const { kind, url, fileName, output, key, headers, audioUrl, videoMimeType, audioMimeType } = message.payload;
    const handle = (
      p: ReturnType<
        typeof downloadHlsMuxed | typeof downloadDashMuxed | typeof downloadMerged | typeof downloadHttpDirect
      >,
    ) =>
      p
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: String(err) }));

    if (kind === 'hls') {
      handle(downloadHlsMuxed(url, fileName, output, key, headers));
    } else if (kind === 'dash') {
      handle(downloadDashMuxed(url, fileName, output, key, headers));
    } else if (kind === 'merged') {
      handle(downloadMerged(url, audioUrl, videoMimeType, audioMimeType, key));
    } else if (kind === 'http') {
      void headers;
      handle(downloadHttpDirect(url, key, output));
    }
    return true;
  }
  return false;
});
