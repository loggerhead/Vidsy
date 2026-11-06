/// <reference types="vite/client" />
import 'webextension-polyfill';
import {
  configureDetectionTabLifecycle,
  handleNetworkDetection,
  upsertDetection,
  clearTabDetections,
  setMainVideoPresent,
  updatePresentationMetadata,
} from './lib/detection';
import {
  cancelDownloadsForTab,
  handleDownload,
  againDownload,
  pauseDownload,
  cancelDownload,
  retryDownload,
  clearDownloads,
  handleExecutionReport,
} from './lib/download';
import { recordDownloadDiagnostic } from './lib/download-diagnostics';
import { setupDownloadInterceptor, resumeBrowserDownload, openDownloadsWindow } from './lib/download-interceptor';
import { reorderQueueItem, runtime as downloadRuntime } from './lib/download-queue';
import {
  authorizeUrlForDownload,
  releaseUrlForDownload,
  clearCapturedHeadersForTab,
  configureHeaderCaptureTabFilter,
  setupHeaderCapture,
} from './lib/header-capture';
import { clearHistory } from './lib/history';
import { deriveKind, deriveFileName } from './lib/media-utils';
import { createNetworkCaptureAdmission } from './lib/network-capture-admission';
import { classifyAndAddUrl } from './lib/paste-url';
import { createTabWorkLifecycle } from './lib/tab-work-lifecycle';
import { createLogger, MEDIA_MESSAGE } from '@extension/shared';
import { configureSessionAccessLevel } from '@extension/storage';
import type { MediaMessage } from '@extension/shared';

export const startBackground = (): void => {
  const log = createLogger('background');
  const sessionAccessReady = configureSessionAccessLevel().catch((error: unknown) => {
    log.error('storage.session_access_failed', error);
  });
  const dispatchTabLifecycleEvent = async (tabId: number, eventName: string, allFrames: boolean) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, ...(allFrames ? { allFrames: true } : {}) },
        func: name => window.dispatchEvent(new CustomEvent(name)),
        args: [eventName],
      });
    } catch {
      // The tab may have closed or be a browser-internal page without an injected script.
    }
  };
  const dispatchFrameLifecycleEvent = async (tabId: number, frameId: number, eventName: string) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: name => window.dispatchEvent(new CustomEvent(name)),
        args: [eventName],
      });
    } catch {
      // The frame may have navigated before its ready message was handled.
    }
  };
  const tabWork = createTabWorkLifecycle({
    start: async ({ tabId, signal }) => {
      await sessionAccessReady;
      if (signal.aborted) return;
      await Promise.all([
        dispatchTabLifecycleEvent(tabId, 'vidsy:start-content', true),
        dispatchTabLifecycleEvent(tabId, 'vidsy:start-content-ui', false),
        dispatchTabLifecycleEvent(tabId, 'vidsy:start-youtube', false),
        dispatchTabLifecycleEvent(tabId, 'vidsy:start-youtube-main', false),
        dispatchTabLifecycleEvent(tabId, 'vidsy:start-vimeo', false),
        dispatchTabLifecycleEvent(tabId, 'vidsy:start-vimeo-main', false),
      ]);
    },
    stop: async ({ tabId }) => {
      // Header capture is tab-scoped, so clear it synchronously before the
      // first await. Otherwise an early request from the replacement document
      // can be captured and then erased by delayed old-document cleanup.
      clearCapturedHeadersForTab(tabId);
      await Promise.all([
        dispatchTabLifecycleEvent(tabId, 'vidsy:stop-content', true),
        dispatchTabLifecycleEvent(tabId, 'vidsy:stop-content-ui', false),
        dispatchTabLifecycleEvent(tabId, 'vidsy:stop-youtube', false),
        dispatchTabLifecycleEvent(tabId, 'vidsy:stop-youtube-main', false),
        dispatchTabLifecycleEvent(tabId, 'vidsy:stop-vimeo', false),
        dispatchTabLifecycleEvent(tabId, 'vidsy:stop-vimeo-main', false),
      ]);
      await Promise.all([clearTabDetections(tabId), cancelDownloadsForTab(tabId)]);
    },
  });
  configureDetectionTabLifecycle(tabWork);
  configureHeaderCaptureTabFilter(tabId => tabWork.isCapturing(tabId));
  const initialTabCaptureReady = chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => (tab?.id === undefined ? undefined : tabWork.track(tab.id, tab.status === 'complete', tab.url)))
    .then(() => undefined)
    .catch(() => undefined);
  const admitNetworkResponse = createNetworkCaptureAdmission({
    bootstrap: initialTabCaptureReady,
    prepareCapture: async tabId => {
      try {
        const tab = await chrome.tabs.get(tabId);
        await tabWork.prepareCapture(tabId, tab.status === 'loading', tab.url);
      } catch {
        // The tab disappeared before the response could be attributed.
      }
    },
    isCapturing: tabId => tabWork.isCapturing(tabId),
    handle: handleNetworkDetection,
  });

  // ─── Offscreen error monitor ───
  setInterval(() => {
    chrome.storage.local.get('__offscreen_error__', res => {
      if (res.__offscreen_error__) {
        log.error('offscreen.fatal_error', res.__offscreen_error__);
      }
    });
  }, 1000);

  // ─── Header capture & stale DNR cleanup ───
  setupHeaderCapture();

  // ─── Browser download interceptor (opt-in via settings) ───
  setupDownloadInterceptor();

  // ─── Network detection listener ───
  chrome.webRequest.onResponseStarted.addListener(
    details => {
      log.debug('network.response_started', {
        tabId: details.tabId,
        type: details.type,
        url: details.url,
        statusCode: details.statusCode,
        initiator: details.initiator,
      });
      void admitNetworkResponse(details);
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
    ['responseHeaders', 'extraHeaders'],
  );

  // ─── Message listener ───
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    log.debug('message.received', {
      type: message?.type,
      senderTabId: sender.tab?.id,
      payload: message?.payload
        ? {
            key: message.payload.key,
            url: typeof message.payload.url === 'string' ? message.payload.url : undefined,
            intent: message.payload.intent,
            item: message.payload.item
              ? {
                  id: message.payload.item.id,
                  kind: message.payload.item.kind,
                  url: message.payload.item.url,
                  variantCount: message.payload.item.variants?.length ?? 0,
                }
              : undefined,
          }
        : undefined,
    });
    (async () => {
      if (message.type === 'content/ready' && (message.scope === 'all' || message.scope === 'ui')) {
        const tabId = sender.tab?.id;
        if (tabId !== undefined && (message.scope === 'all' || sender.frameId === 0)) {
          await sessionAccessReady;
          await tabWork.track(tabId, true, sender.tab?.url);
          await dispatchFrameLifecycleEvent(
            tabId,
            sender.frameId ?? 0,
            message.scope === 'all' ? 'vidsy:start-content' : 'vidsy:start-content-ui',
          );
        }
        sendResponse({ ok: true });
        return;
      }
      if (message.type === 'offscreen/download-diagnostic') {
        recordDownloadDiagnostic(message.payload.event, message.payload.data);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === 'offscreen/execution-event') {
        await handleExecutionReport(message.payload);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === 'offscreen/authorize-download-url') {
        const job = (await downloadRuntime.snapshot()).jobs.find(job => job.requestId === message.payload.key);
        if (!job?.executionId || job.cancelRequested || job.pauseRequested) {
          sendResponse({ ok: false, error: 'Download cancelled' });
          return;
        }
        const url = await authorizeUrlForDownload(job.executionId, message.payload.url, message.payload.transient);
        sendResponse({ ok: true, downloadKey: job.executionId, url });
        return;
      }
      if (message.type === 'offscreen/release-download-url') {
        await releaseUrlForDownload(message.payload.downloadKey, message.payload.url);
        sendResponse({ ok: true });
        return;
      }
      const msg = message as MediaMessage;
      if (msg.type === MEDIA_MESSAGE.DETECTED) {
        if (sender.tab?.id === undefined || !tabWork.isRunning(sender.tab.id)) {
          sendResponse({ ok: false, error: 'Detection is not running for this tab' });
          return;
        }
        log.debug('message.detected', {
          tabId: sender.tab?.id,
          url: msg.payload.url,
          kind: msg.payload.kind,
          source: msg.payload.source,
          resolution: msg.payload.resolution,
          variantCount: msg.payload.variants?.length ?? 0,
        });
        await upsertDetection(msg.payload, sender.tab?.id, sender.tab?.url);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.DOWNLOAD) {
        log.debug('message.download.start', {
          key: msg.payload.key,
          itemId: msg.payload.item?.id,
          url: msg.payload.url,
          kind: msg.payload.kind,
          resolution: msg.payload.item?.resolution,
          variantCount: msg.payload.item?.variants?.length ?? 0,
          hasAudio: Boolean(msg.payload.audioUrl),
        });
        const result = await handleDownload(msg.payload);
        log.debug('message.download.result', { key: msg.payload.key, itemId: msg.payload.item?.id, result });
        sendResponse(result);
        return;
      }
      if (msg.type === MEDIA_MESSAGE.CONTROL) {
        if (msg.payload.intent === 'again') {
          const result = await againDownload(msg.payload.key, msg.payload.requestId ?? crypto.randomUUID());
          sendResponse(result ? { ok: true, ...result } : { ok: false, error: 'Download task not found' });
          return;
        }
        const ok = await retryDownload(msg.payload.key, msg.payload.intent);
        sendResponse({ ok });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.CANCEL) {
        const key = msg.payload.key ?? msg.payload.url;
        if (!key) {
          sendResponse({ ok: false, error: 'Missing download key' });
          return;
        }
        if (msg.payload.intent === 'pause') {
          await pauseDownload(key);
        } else {
          await cancelDownload(key);
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.CLEAR_TAB) {
        const tabId = msg.payload?.tabId ?? sender.tab?.id;
        if (tabId !== undefined) await clearTabDetections(tabId);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.CLEAR_DOWNLOADS) {
        await clearDownloads(msg.payload?.keys);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.QUEUE_REORDER) {
        const ok = await reorderQueueItem(msg.payload.key, msg.payload.direction);
        sendResponse({ ok });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.INTERCEPT_DOWNLOAD_VIDSY) {
        const tabId = sender.tab?.id;
        const kind = deriveKind(msg.payload.url);
        // Open the per-download progress window BEFORE kicking off the
        // download — keyed on the URL so each download gets its own window
        // (handleDownload uses url as the storage key by default).
        const requestKey = crypto.randomUUID();
        void openDownloadsWindow(requestKey);
        const result = await handleDownload({
          url: msg.payload.url,
          key: requestKey,
          fileName: msg.payload.fileName ?? deriveFileName(msg.payload.url),
          title: msg.payload.fileName,
          tabId,
          kind,
        });
        sendResponse(result);
        return;
      }
      if (msg.type === MEDIA_MESSAGE.INTERCEPT_RESUME_BROWSER) {
        resumeBrowserDownload(msg.payload.url, msg.payload.fileName);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.INTERCEPT_DISMISS) {
        // Original download is already cancelled — nothing to do beyond ack.
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.MAIN_VIDEO_PRESENT) {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) setMainVideoPresent(tabId, msg.payload.present);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.PRESENTATION_METADATA) {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          sendResponse({ ok: false, error: 'Missing sender tab' });
          return;
        }
        const updated = await updatePresentationMetadata(msg.payload.itemId, msg.payload, tabId);
        sendResponse({ ok: updated });
        return;
      }
      if (msg.type === MEDIA_MESSAGE.PASTE_URL) {
        const tabId = msg.payload.tabId ?? sender.tab?.id;
        let pageUrl: string | undefined = sender.tab?.url;
        if (tabId !== undefined && !pageUrl) {
          try {
            const tab = await chrome.tabs.get(tabId);
            pageUrl = tab.url;
          } catch {
            // Tab may be gone — proceed without pageUrl
          }
        }
        const result = await classifyAndAddUrl(msg.payload.url, tabId, pageUrl);
        sendResponse(result);
        return;
      }
      if (msg.type === MEDIA_MESSAGE.PICKER_START) {
        const tabId = msg.payload?.tabId ?? sender.tab?.id;
        if (tabId === undefined) {
          sendResponse({ ok: false, error: 'No active tab' });
          return;
        }
        try {
          await chrome.tabs.sendMessage(tabId, { type: MEDIA_MESSAGE.PICKER_ACTIVATE });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (msg.type === MEDIA_MESSAGE.PICKER_PICKED) {
        const tabId = sender.tab?.id;
        const pageUrl = sender.tab?.url;
        const result = await classifyAndAddUrl(msg.payload.url, tabId, pageUrl);
        sendResponse(result);
        return;
      }
      if (message.type === 'media/clear-history') {
        await clearHistory();
        sendResponse({ ok: true });
        return;
      }
      // Play / Show in folder for completed downloads
      if (message.type === 'media/open' && typeof message.downloadId === 'number') {
        chrome.downloads.open(message.downloadId);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === 'media/show' && typeof message.downloadId === 'number') {
        chrome.downloads.show(message.downloadId);
        sendResponse({ ok: true });
        return;
      }
      if (message.type === 'media/get-tab-id') {
        // Content scripts cannot call chrome.tabs.getCurrent() — they must ask the background
        sendResponse({ tabId: sender.tab?.id ?? null });
        return;
      }
      if (message.type === 'media/force-detect' && typeof message.tabId === 'number') {
        // Execute a scan script on the target tab to find any missed media URLs
        try {
          await chrome.scripting.executeScript({
            target: { tabId: message.tabId },
            func: () => {
              /** Decode HTML entities using browser's parser */
              const decode = (s: string) => {
                try {
                  const t = document.createElement('textarea');
                  t.innerHTML = s;
                  return t.value;
                } catch {
                  return s;
                }
              };
              const pageTitle = decode(
                document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ||
                  document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.content ||
                  document.title ||
                  '',
              );

              const found = new Set<string>();

              // 1. All video/audio element sources (non-blob)
              document.querySelectorAll<HTMLMediaElement>('video, audio').forEach(el => {
                [el.currentSrc, el.src].forEach(u => {
                  if (u && !u.startsWith('blob:') && u.startsWith('http')) found.add(u);
                });
                el.querySelectorAll<HTMLSourceElement>('source').forEach(s => {
                  if (s.src && !s.src.startsWith('blob:')) found.add(s.src);
                });
              });

              // 2. HLS.js instances attached to video elements
              document.querySelectorAll<HTMLVideoElement>('video').forEach(v => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const hls = (v as any)._hls || (v as any).__hls__ || (v as any).hls;
                if (hls?.url && typeof hls.url === 'string') found.add(hls.url);
              });

              // 3. Global player APIs
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const w = window as any;

                if (w.Hls?.instances)
                  Object.values(w.Hls.instances).forEach((h: unknown) => {
                    if ((h as { url?: string })?.url) found.add((h as { url: string }).url);
                  });
                if (w.jwplayer) {
                  try {
                    const item = w.jwplayer().getPlaylistItem();
                    if (item?.file) found.add(item.file);
                  } catch {
                    // jwplayer() might throw if instance not fully initialized
                  }
                }
                if (w.videojs) {
                  try {
                    Object.values(w.videojs.players || {}).forEach((p: unknown) => {
                      const s = (p as { currentSrc?: () => string })?.currentSrc?.();
                      if (s && !s.startsWith('blob:')) found.add(s);
                    });
                  } catch {
                    // videojs access might fail if not ready
                  }
                }
              } catch {
                // Global player detection can fail on some pages - ignore
              }

              // Send each found URL as a detection
              found.forEach(url => {
                chrome.runtime
                  .sendMessage({
                    type: 'media/detected',
                    payload: { url, source: 'element', title: pageTitle },
                  })
                  .catch(() => {});
              });

              return found.size;
            },
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }
      sendResponse({ ok: false, error: 'Unknown message type' });
    })().catch(error => {
      log.error('message.handler_failed', error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  });

  // ─── Tab listeners ───
  chrome.tabs.onRemoved.addListener(tabId => {
    void tabWork.close(tabId);
  });
  // tabs.onUpdated can report loading for a same-document URL change. Only a
  // committed main-frame navigation replaces the document and its detections.
  chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) void tabWork.navigationStarted(details.tabId, details.url);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') void tabWork.pageReady(tabId);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void chrome.tabs
      .get(tabId)
      .then(tab => tabWork.track(tabId, tab.status === 'complete', tab.url))
      .catch(() => undefined);
  });
  // ─── Context menu ───
  const createContextMenus = () => {
    // Idempotent — re-creating on service-worker restart throws "duplicate id".
    try {
      chrome.contextMenus.create({
        id: 'download-media',
        title: 'Download media',
        contexts: ['video', 'audio'],
      });
    } catch {
      // Already registered
    }
    try {
      chrome.contextMenus.create({
        id: 'send-link-to-vidsy',
        title: 'Send link to Vidsy',
        contexts: ['link'],
      });
    } catch {
      // Already registered
    }
  };

  chrome.runtime.onInstalled.addListener(createContextMenus);
  chrome.runtime.onStartup.addListener(createContextMenus);

  // ─── Hotkey: Alt+Shift+V activates the element picker on the active tab ───
  chrome.commands.onCommand.addListener(async command => {
    if (command !== 'activate-picker') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: MEDIA_MESSAGE.PICKER_ACTIVATE });
    } catch {
      // Tab may not have a content script (chrome://, web store, etc.)
    }
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'download-media') {
      const srcUrl = info.srcUrl;
      if (!srcUrl) return;
      const kind = deriveKind(srcUrl);
      if (kind === 'video' || kind === 'audio') {
        void handleDownload({
          url: srcUrl,
          kind,
          fileName: deriveFileName(srcUrl, tab?.title),
          title: tab?.title,
          tabId: tab?.id,
        });
      } else {
        void upsertDetection({ url: srcUrl, kind, source: 'element' }, tab?.id, tab?.url);
      }
      return;
    }
    if (info.menuItemId === 'send-link-to-vidsy') {
      const linkUrl = info.linkUrl;
      if (!linkUrl) return;
      void (async () => {
        const result = await classifyAndAddUrl(linkUrl, tab?.id, tab?.url);
        if (result.ok) {
          // Item is now in the per-tab detected list and the badge counter has
          // bumped automatically (see upsertDetection -> updateBadge). Try to
          // open the popup so the user lands on the result immediately.
          try {
            await chrome.action.openPopup();
          } catch {
            // openPopup() requires a recent user gesture in some Chrome
            // versions. The badge already signals the new item — user can
            // click the icon to open.
          }
        } else {
          log.warn('context_menu.send_link_failed', { error: result.error });
        }
      })();
    }
  });

  log.info('started');
};
