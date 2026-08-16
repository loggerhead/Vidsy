import { DropdownPanel } from './components/DropdownPanel';
import { InterceptModal } from './components/InterceptModal';
import { PillBar } from './components/PillBar';
import { FONT } from './components/tokens';
import { buildDownloadMessage } from './lib/download-request';
import { ACTIVE_STAGES, pickBestVariant, buildRows } from './lib/media-helpers';
import { createLogger, MEDIA_MESSAGE, useStorage } from '@extension/shared';
import { mediaDetectionsStorage, mediaDownloadsStorage, mediaSettingsStorage } from '@extension/storage';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { VideoEntry } from './lib/media-helpers';
import type { MediaDownloadProgress, MediaItem, MediaVariant } from '@extension/shared';

const App = () => {
  const log = createLogger('content-ui');
  const detections = useStorage(mediaDetectionsStorage);
  const rawDownloads = useStorage(mediaDownloadsStorage);
  const downloads = useMemo(() => (rawDownloads ?? {}) as Record<string, MediaDownloadProgress>, [rawDownloads]);
  const settings = useStorage(mediaSettingsStorage);

  /* tab ID via background message (chrome.tabs not available in content scripts) */
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'media/get-tab-id' })
      .then((r: { tabId: number | null }) => {
        if (r?.tabId != null) setTabId(r.tabId);
      })
      .catch(() => {});
  }, []);

  const tabItems = useMemo<MediaItem[]>(() => {
    if (!detections || tabId === null) return [];
    return detections[String(tabId)] ?? [];
  }, [detections, tabId]);

  /* video element tracking */
  const [videos, setVideos] = useState<VideoEntry[]>([]);
  useEffect(() => {
    let n = 0;
    const ids = new WeakMap<HTMLVideoElement, string>();
    const getId = (el: HTMLVideoElement) => {
      if (!ids.has(el)) ids.set(el, `v${n++}`);
      return ids.get(el)!;
    };
    let rAF: number | null = null;
    const measure = () => {
      if (rAF !== null) return;
      rAF = requestAnimationFrame(() => {
        rAF = null;
        setVideos(
          Array.from(document.querySelectorAll<HTMLVideoElement>('video'))
            .filter(el => el.offsetWidth > 100 && el.offsetHeight > 60)
            .map(el => ({ el, id: getId(el), rect: el.getBoundingClientRect() })),
        );
      });
    };
    const mo = new MutationObserver(measure);
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'style', 'class'],
    });
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    window.addEventListener('resize', measure);
    measure();
    const t = setInterval(measure, 800);
    return () => {
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener('resize', measure);
      clearInterval(t);
    };
  }, []);

  /* UI state */
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busyUrl, setBusyUrl] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [intercept, setIntercept] = useState<{
    url: string;
    fileName?: string;
    mime?: string;
    fileSize?: number;
    referrer?: string;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const positionedVideoRef = useRef<HTMLVideoElement | null>(null);
  const requestPositionRef = useRef<() => void>(() => {});
  const prevVideoRef = useRef<VideoEntry | undefined>(undefined);

  /* Keep the overlay attached to its player without putting scroll updates
     through React. This runs at most once per animation frame and only reads
     the selected video's box before writing a compositor-friendly transform. */
  useLayoutEffect(() => {
    let frame: number | null = null;
    const position = () => {
      frame = null;
      const overlay = ref.current;
      const video = positionedVideoRef.current;
      if (!overlay || !video) return;

      const rect = video.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0) {
        overlay.style.visibility = 'hidden';
        return;
      }

      const x = Math.min(rect.right + 1, window.innerWidth - overlay.offsetWidth - 1);
      overlay.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(rect.top)}px, 0)`;
      overlay.style.visibility = 'visible';
    };
    const requestPosition = () => {
      if (frame === null) frame = requestAnimationFrame(position);
    };

    requestPositionRef.current = requestPosition;
    window.addEventListener('scroll', requestPosition, { capture: true, passive: true });
    window.addEventListener('resize', requestPosition, { passive: true });
    requestPosition();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', requestPosition, true);
      window.removeEventListener('resize', requestPosition);
      requestPositionRef.current = () => {};
    };
  }, []);

  useLayoutEffect(() => {
    requestPositionRef.current();
  }, [videos, isHovered, open, busyUrl]);

  /* Download intercept: background cancels a media download and asks us to
     show a modal so the user can route it through Vidsy or open in browser. */
  useEffect(() => {
    const handler = (message: { type?: string; payload?: unknown }) => {
      if (message?.type === MEDIA_MESSAGE.INTERCEPT_SHOW) {
        setIntercept(message.payload as typeof intercept);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  /* Outside-click closes dropdown
     IMPORTANT: The content-ui runs inside a shadow DOM. At document level,
     event.target is retargeted to the shadow host, so ref.current.contains()
     always returns false for clicks INSIDE our component, causing the handler
     to close the dropdown on every internal click (including dropdown rows).
     Fix: use e.composedPath() which correctly includes shadow DOM internals. */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const path = e.composedPath();
      if (ref.current && !path.includes(ref.current as unknown as EventTarget)) setOpen(false);
    };
    const tid = setTimeout(() => document.addEventListener('mousedown', handler, true), 0);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('mousedown', handler, true);
    };
  }, [open]);

  /* download helpers */
  const doDownload = useCallback(
    async (item: MediaItem, variant?: MediaVariant) => {
      log.debug('download.click', {
        itemId: item.id,
        variantIndex: variant ? item.variants?.findIndex(v => v.url === variant.url) : undefined,
        kind: item.kind,
        itemUrl: (() => {
          try {
            const url = new URL(variant?.url ?? item.url);
            return `${url.origin}${url.pathname}`;
          } catch {
            return '[invalid-url]';
          }
        })(),
        resolution: variant?.resolution ?? item.resolution,
        hasAudio: Boolean(variant?.audioUrl ?? item.audioUrl),
      });
      // MSE-fed players have no fetchable source — the badge still shows so the
      // user knows we saw the video, but the action is a no-op.
      if (item.kind === 'mse') {
        log.warn('download.skipped_mse');
        return;
      }
      setBusyUrl(item.id);
      setOpen(false);
      try {
        const response = await chrome.runtime.sendMessage(
          buildDownloadMessage(item, variant, tabId, settings?.enableHlsMerging),
        );
        log.debug('download.response', {
          itemId: item.id,
          ok: response?.ok,
          queued: response?.queued,
          error: response?.error,
        });
      } catch (error) {
        log.error('download.send_failed', {
          itemId: item.id,
          name: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      // Keep busyUrl until storage reports success/fail
    },
    [settings, tabId],
  );

  /* clear busyUrl once storage reports terminal stage */
  useEffect(() => {
    if (!busyUrl) return undefined;
    const prog = downloads[busyUrl];
    if (prog?.stage === 'success' || prog?.stage === 'failed') {
      const t = setTimeout(() => setBusyUrl(null), 2000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [downloads, busyUrl]);

  /* Recover active download after page refresh */
  useEffect(() => {
    if (busyUrl) return; // already tracking something
    const activeEntry = Object.entries(downloads).find(([, p]) => ACTIVE_STAGES.has(p.stage));
    if (activeEntry) setBusyUrl(activeEntry[0]);
    // Only run on first mount (when downloads first becomes available)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloads]);

  const interceptModal = intercept ? <InterceptModal intercept={intercept} onClose={() => setIntercept(null)} /> : null;

  if (tabItems.length === 0 || dismissed) return interceptModal;

  /* active progress */
  const primary = tabItems[0];
  const activeItem = busyUrl
    ? (tabItems.find(it => it.id === busyUrl) ??
      tabItems.find(it => {
        const stage = downloads[busyUrl]?.stage;
        return stage != null && ACTIVE_STAGES.has(stage) && it.kind !== 'mse';
      }))
    : tabItems.find(it => {
        const p = downloads[it.id];
        return p != null && ACTIVE_STAGES.has(p.stage);
      });
  const isBusy = !!activeItem;

  /* positioning */
  const MIN_W = 280,
    MIN_H = 160;
  const mainVideo = videos
    .filter(v => v.rect.width >= MIN_W && v.rect.height >= MIN_H)
    .reduce<
      VideoEntry | undefined
    >((b, c) => (!b ? c : c.rect.width * c.rect.height > b.rect.width * b.rect.height ? c : b), undefined);

  /* Hysteresis */
  let effectiveVideo = mainVideo;
  if (!mainVideo && (open || isHovered || isBusy)) {
    effectiveVideo = prevVideoRef.current;
  }
  if (effectiveVideo) {
    prevVideoRef.current = effectiveVideo;
  }
  positionedVideoRef.current = effectiveVideo?.el ?? null;

  if (!effectiveVideo) return interceptModal;

  const prog = busyUrl ? downloads[busyUrl] : null;

  const rows = buildRows(tabItems);
  const bestVariant = primary.variants?.length ? pickBestVariant(primary.variants) : undefined;
  const expanded = isHovered || open;

  return (
    <>
      {interceptModal}
      <div
        ref={ref}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          setOpen(false);
        }}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 2147483647,
          pointerEvents: 'auto',
          fontFamily: FONT,
          visibility: 'hidden',
          willChange: 'transform',
        }}>
        <PillBar isBusy={isBusy} prog={prog} onExpand={() => setOpen(true)} />

        {expanded && !isBusy && (
          <DropdownPanel rows={rows} primary={primary} bestVariant={bestVariant} onDownload={doDownload} />
        )}
      </div>
    </>
  );
};

export default App;
