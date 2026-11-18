import { selectMediaPageTab } from './active-media-tab';
import { LICENSE_MESSAGE, MEDIA_MESSAGE, useStorage, pickBestVariant } from '@extension/shared';
import {
  mediaDetectionsStorage,
  mediaDownloadsStorage,
  mediaHistoryStorage,
  mediaSettingsStorage,
  exampleThemeStorage,
} from '@extension/storage';
import { useEffect, useMemo, useState } from 'react';
import type {
  DownloadState,
  MediaDetectionState,
  MediaDownloadProgress,
  MediaHistoryItem,
  MediaItem,
  MediaSettings,
} from '@extension/shared';

export const useMediaPage = () => {
  const detections = useStorage(mediaDetectionsStorage) as MediaDetectionState;
  const history = (useStorage(mediaHistoryStorage) ?? []) as MediaHistoryItem[];
  const settings = useStorage(mediaSettingsStorage) as MediaSettings;
  const downloads = (useStorage(mediaDownloadsStorage) ?? {}) as Record<string, MediaDownloadProgress>;
  const { isLight } = useStorage(exampleThemeStorage);

  const [tabId, setTabId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [downloadState, setDownloadState] = useState<DownloadState>({ busyUrl: null, error: null });
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  // Allow callers to deep-link to a specific view via URL hash, e.g. when the
  // popup HTML is opened as a standalone window via chrome.windows.create
  // (used by the download interceptor to show the standalone progress window).
  type View = 'main' | 'settings' | 'history' | 'downloads' | 'download-details';
  const initialView = ((): View => {
    if (typeof window === 'undefined') return 'main';
    const hash = window.location.hash.replace('#', '');
    if (
      hash === 'downloads' ||
      hash === 'settings' ||
      hash === 'history' ||
      hash === 'main' ||
      hash === 'download-details'
    )
      return hash;
    return 'main';
  })();
  const [view, setView] = useState<View>(initialView);
  const [moreMenuId, setMoreMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  useEffect(() => {
    void Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.tabs.query({ active: true }),
      chrome.tabs.query({}),
    ])
      .then(([currentWindowTabs, activeTabs, allTabs]) => {
        setTabId(selectMediaPageTab(currentWindowTabs, activeTabs, allTabs)?.id ?? null);
      })
      .catch(() => setTabId(null))
      .finally(() => setIsLoading(false));
  }, []);

  const currentMedia = useMemo(() => {
    if (!tabId || !detections) return [] as MediaItem[];
    return detections[String(tabId)] ?? [];
  }, [tabId, detections]);

  useEffect(() => {
    const next: Record<string, string> = {};
    currentMedia.forEach(item => {
      if (item.variants && item.variants.length > 0) {
        const best = pickBestVariant(item.variants);
        if (best) next[item.id] = best.url;
      }
    });
    setSelectedVariants(prev => ({ ...next, ...prev }));
  }, [currentMedia]);

  useEffect(() => {
    if (downloadState.busyUrl) return;
    // Note: 'queued' deliberately excluded so the popup doesn't peg busyUrl to a
    // queued item — users should be able to start more downloads while one runs.
    const ACTIVE = new Set(['init', 'fetch-manifest', 'download-video', 'download-audio', 'mux', 'finalize']);
    const entry = Object.entries(downloads).find(([, p]) => ACTIVE.has(p.stage));
    if (entry) setDownloadState({ busyUrl: entry[0], error: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloads]);

  const onDownload = async (item: MediaItem, outputFormat?: 'mp4' | 'mp3') => {
    setMoreMenuId(null);
    setDownloadState({ busyUrl: item.id, error: null });
    const chosenVariant =
      item.variants && item.variants.length > 0
        ? (item.variants.find(v => v.url === selectedVariants[item.id]) ?? item.variants[0])
        : undefined;
    let chosenUrl = chosenVariant?.url ?? item.url;
    // Audio pairing for YouTube adaptive formats: prefer variant-level, fall back to item-level.
    let audioUrl: string | undefined;
    let audioMimeType: string | undefined;
    if (outputFormat === 'mp3') {
      // For MP3 output, skip the video track entirely — fetch only the audio URL
      // (paired audio for video-only items, or the item itself if already audio)
      // and let the offscreen pipeline transcode it.
      const audioOnly = chosenVariant?.audioUrl ?? item.audioUrl;
      if (audioOnly) chosenUrl = audioOnly;
    } else {
      audioUrl = chosenVariant?.audioUrl ?? item.audioUrl;
      audioMimeType = chosenVariant?.audioMimeType ?? item.audioMimeType;
    }
    const response = await chrome.runtime.sendMessage({
      type: MEDIA_MESSAGE.DOWNLOAD,
      payload: {
        url: chosenUrl,
        key: crypto.randomUUID(),
        kind: item.kind,
        fileName: item.fileName,
        title: item.title,
        tabId: item.tabId ?? tabId ?? undefined,
        outputFormat,
        audioUrl,
        audioMimeType,
        item: {
          ...item,
          tabId: item.tabId ?? tabId ?? undefined,
          url: chosenUrl,
          mimeType: chosenVariant?.mimeType ?? item.mimeType,
          resolution: chosenVariant?.resolution ?? item.resolution,
        },
      },
    });
    if (!response?.ok) {
      if (response?.code === 'PAYMENT_REQUIRED') {
        setDownloadState({
          busyUrl: null,
          error: null,
          paywall: {
            free: response.free,
            credits: response.credits,
            subscription: response.subscription ?? null,
            upgrade: response.upgrade,
          },
        });
      } else {
        setDownloadState({ busyUrl: null, error: response?.error ?? 'Download failed' });
      }
    } else {
      setDownloadState({ busyUrl: null, error: null });
    }
  };

  const closePaywall = () => setDownloadState(prev => ({ ...prev, paywall: null }));

  const buyProduct = async (productKey: string) => {
    const response = await chrome.runtime.sendMessage({
      type: LICENSE_MESSAGE.CHECKOUT,
      payload: { productKey },
    });
    if (!response?.ok)
      setDownloadState(prev => ({ ...prev, error: response?.error ?? 'Checkout could not be started' }));
  };

  const restorePurchase = () => {
    setDownloadState(prev => ({ ...prev, paywall: null }));
    void chrome.tabs.create({ url: `${chrome.runtime.getURL('options.html')}#license` });
  };

  const manageSubscription = async () => {
    const response = await chrome.runtime.sendMessage({ type: LICENSE_MESSAGE.PORTAL });
    if (!response?.ok)
      setDownloadState(prev => ({ ...prev, error: response?.error ?? 'Could not open the customer portal' }));
  };

  const onCancel = async (key: string) => {
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CANCEL, payload: { key, intent: 'cancel' } });
    setDownloadState({ busyUrl: null, error: null });
  };

  const onPause = async (key: string) => {
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CANCEL, payload: { key, intent: 'pause' } });
    setDownloadState({ busyUrl: null, error: null });
  };

  const onRetry = async (entry: MediaDownloadProgress) => {
    if (!entry.item) return;
    if (entry.stage === 'paused' || entry.stage === 'failed') {
      await chrome.runtime.sendMessage({
        type: MEDIA_MESSAGE.CONTROL,
        payload: { key: entry.key, intent: entry.stage === 'paused' ? 'resume' : 'retry' },
      });
    } else {
      await chrome.runtime.sendMessage({
        type: MEDIA_MESSAGE.CONTROL,
        payload: { key: entry.key, intent: 'again', requestId: crypto.randomUUID() },
      });
    }
  };

  const onClearDownloads = async (keys?: string[]) => {
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.CLEAR_DOWNLOADS, payload: { keys } });
  };

  const onReorder = async (key: string, direction: 'up' | 'down') => {
    await chrome.runtime.sendMessage({ type: MEDIA_MESSAGE.QUEUE_REORDER, payload: { key, direction } });
  };

  const clearDetectionsForTab = (sourceTabId: number) => {
    chrome.runtime
      .sendMessage({ type: MEDIA_MESSAGE.CLEAR_TAB, payload: { tabId: sourceTabId } })
      .catch(() => undefined);
  };
  const clearTabDetections = () => {
    if (tabId !== null) clearDetectionsForTab(tabId);
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).catch(() => undefined);
    setMoreMenuId(null);
  };

  const startEdit = (item: MediaItem) => {
    setEditingId(item.id);
    setEditName(item.fileName ?? item.url);
  };

  const toggleHlsMerge = () =>
    mediaSettingsStorage.set(prev => ({ ...prev, enableHlsMerging: !prev.enableHlsMerging }));

  const clearHistory = () => chrome.runtime.sendMessage({ type: 'media/clear-history' });

  // Theme classes
  const bg = isLight ? 'bg-white' : 'bg-[#0f1117]';
  const text = isLight ? 'text-gray-900' : 'text-gray-100';
  const textMuted = isLight ? 'text-gray-400' : 'text-gray-500';
  const hoverBg = isLight ? 'hover:bg-gray-100' : 'hover:bg-white/[0.06]';
  const borderB = isLight ? 'border-gray-200' : 'border-white/[0.06]';

  return {
    tabId,
    currentMedia,
    isLoading,
    downloadState,
    setDownloadState,
    selectedVariants,
    setSelectedVariants,
    view,
    setView,
    moreMenuId,
    setMoreMenuId,
    editingId,
    setEditingId,
    editName,
    setEditName,
    downloads,
    settings,
    history,
    isLight,
    onDownload,
    closePaywall,
    buyProduct,
    restorePurchase,
    manageSubscription,
    onCancel,
    onPause,
    onRetry,
    onClearDownloads,
    onReorder,
    clearTabDetections,
    clearDetectionsForTab,
    copyUrl,
    startEdit,
    toggleHlsMerge,
    clearHistory,
    bg,
    text,
    textMuted,
    borderB,
    hoverBg,
  };
};
