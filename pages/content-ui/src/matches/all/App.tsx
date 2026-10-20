import { DropdownPanel } from './components/DropdownPanel';
import { InterceptModal } from './components/InterceptModal';
import { PillBar } from './components/PillBar';
import { FONT } from './components/tokens';
import { buildDownloadMessage } from './lib/download-request';
import { ACTIVE_STAGES, pickBestVariant, buildRows } from './lib/media-helpers';
import { resolvePlayerMedia, selectVisiblePlayer, visiblePlayerArea } from './lib/player-media';
import { createLogger, MEDIA_MESSAGE, useStorage } from '@extension/shared';
import { mediaDetectionsStorage, mediaDownloadsStorage, mediaSettingsStorage } from '@extension/storage';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { VideoEntry } from './lib/media-helpers';
import type { MediaDownloadProgress, MediaItem, MediaVariant } from '@extension/shared';

const log = createLogger('content-ui');

const App = () => {
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
  const [videos, setVideos] = useState<Array<VideoEntry & { playing: boolean; sourceKey: string }>>([]);
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
        const next = Array.from(document.querySelectorAll<HTMLVideoElement>('video'))
          .filter(el => el.offsetWidth > 100 && el.offsetHeight > 60)
          .map(el => ({
            el,
            id: getId(el),
            rect: el.getBoundingClientRect(),
            playing: !el.paused && !el.ended,
            sourceKey: JSON.stringify([el.currentSrc, el.src, el.poster, el.duration]),
          }));
        setVideos(previous => {
          const unchanged =
            previous.length === next.length &&
            previous.every(
              (entry, index) =>
                entry.el === next[index].el &&
                entry.sourceKey === next[index].sourceKey &&
                entry.playing === next[index].playing,
            );
          const selected = (entries: typeof next) =>
            selectVisiblePlayer(entries, window.innerWidth, window.innerHeight)?.el;
          // Scrolling positions the existing overlay directly; React only
          // needs a render when the selected player or its media changes.
          return unchanged && selected(previous) === selected(next) ? previous : next;
        });
      });
    };
    const mo = new MutationObserver(measure);
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'poster', 'style', 'class'],
    });
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    document.addEventListener('play', measure, true);
    document.addEventListener('pause', measure, true);
    document.addEventListener('loadedmetadata', measure, true);
    measure();
    const t = setInterval(measure, 800);
    return () => {
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      document.removeEventListener('play', measure, true);
      document.removeEventListener('pause', measure, true);
      document.removeEventListener('loadedmetadata', measure, true);
      if (rAF !== null) cancelAnimationFrame(rAF);
      clearInterval(t);
    };
  }, []);

  /* UI state */
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
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevVideoRef = useRef<VideoEntry | undefined>(undefined);

  useEffect(
    () => () => {
      if (hoverCloseTimerRef.current !== null) clearTimeout(hoverCloseTimerRef.current);
    },
    [],
  );

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
      if (!video.isConnected || visiblePlayerArea(rect, window.innerWidth, window.innerHeight) === 0) {
        overlay.style.visibility = 'hidden';
        return;
      }

      const x = Math.min(rect.right + 1, window.innerWidth - overlay.offsetWidth - 1);
      overlay.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(Math.max(0, rect.top))}px, 0)`;
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
  }, [videos, tabItems, isHovered, open, busyUrl]);

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
        if (response?.ok && response.key) setBusyUrl(response.key);
        else setBusyUrl(null);
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
    if (prog && ['success', 'failed', 'cancelled', 'paused'].includes(prog.stage)) {
      const t = setTimeout(() => setBusyUrl(null), 2000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [downloads, busyUrl]);

  const interceptModal = intercept ? <InterceptModal intercept={intercept} onClose={() => setIntercept(null)} /> : null;

  const mainVideo = selectVisiblePlayer(videos, window.innerWidth, window.innerHeight);
  const previous = prevVideoRef.current;
  const holdPrevious =
    (open || isHovered) &&
    previous?.el.isConnected &&
    visiblePlayerArea(previous.el.getBoundingClientRect(), window.innerWidth, window.innerHeight) > 0;
  const effectiveVideo = holdPrevious ? previous : mainVideo;
  prevVideoRef.current = effectiveVideo;
  positionedVideoRef.current = effectiveVideo?.el ?? null;

  const player = effectiveVideo?.el;
  const playerResolution = player
    ? resolvePlayerMedia(tabItems, {
        sourceUrls: [
          player.currentSrc,
          player.src,
          ...Array.from(player.querySelectorAll('source')).map(source => source.src),
        ],
        posterUrl: player.poster,
        pageUrl: window.location.href,
        playerCount: videos.length,
      })
    : undefined;
  const primary = playerResolution?.item;
  const resolvedItemId = primary?.id;
  const resolutionAuthority = playerResolution?.authority;
  const playerPoster = player?.poster;
  const playerDuration = player?.duration;

  useEffect(() => {
    if (!resolvedItemId || resolutionAuthority === 'unique-presentation') return;
    const thumbnailUrl = playerPoster || null;
    const duration = Number.isFinite(playerDuration) && (playerDuration ?? 0) > 0 ? playerDuration : undefined;
    chrome.runtime
      .sendMessage({
        type: MEDIA_MESSAGE.PRESENTATION_METADATA,
        payload: { itemId: resolvedItemId, thumbnailUrl, duration },
      })
      .catch(() => undefined);
  }, [playerDuration, playerPoster, resolutionAuthority, resolvedItemId]);

  // A recycled DOM player can change asset without changing its element.
  useEffect(() => {
    setOpen(false);
    setIsHovered(false);
  }, [primary?.id]);

  if (!effectiveVideo || !primary) return interceptModal;
  const currentProgress = Object.values(downloads)
    .filter(entry => entry.item?.id === primary.id)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  const hasActiveProgress = !!currentProgress && ACTIVE_STAGES.has(currentProgress.stage);
  const isBusy = hasActiveProgress || busyUrl === primary.id || (!!busyUrl && currentProgress?.key === busyUrl);
  const prog = isBusy ? (currentProgress ?? null) : null;
  const rows = buildRows([primary]);
  const bestVariant = primary.variants?.length ? pickBestVariant(primary.variants) : undefined;
  const expanded = isHovered || open;

  return (
    <>
      {interceptModal}
      <div
        ref={ref}
        onMouseEnter={() => {
          if (hoverCloseTimerRef.current !== null) {
            clearTimeout(hoverCloseTimerRef.current);
            hoverCloseTimerRef.current = null;
          }
          setIsHovered(true);
        }}
        onMouseLeave={() => {
          hoverCloseTimerRef.current = setTimeout(() => {
            hoverCloseTimerRef.current = null;
            setIsHovered(false);
            setOpen(false);
          }, 180);
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
