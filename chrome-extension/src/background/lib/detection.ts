import {
  applyPresentationMetadata,
  isVariantAuthority,
  reconcilePlayerEvidence,
  sameMainPlayerSession,
  reconcileHlsPlaylistEvidence,
  selectRicherVariants,
} from './detection-evidence';
import { handleFmp4RangeDetection, clearFmp4RangeDetectionsForTab } from './fmp4-range-detector';
import { findCapturedHeaders } from './header-capture';
import { dlLog } from './logger';
import { parseHlsVariants, parseDashVariants } from './manifest-parser';
import {
  createId,
  deriveKind,
  deriveFileName,
  htmlDecode,
  documentTitleFromUrl,
  isHlsSegment,
  isDashSegment,
  normalizeMediaUrl,
  MIN_MEDIA_SIZE_BYTES,
} from './media-utils';
import { mediaDetectionsStorage } from '@extension/storage';
import type { TabWorkLifecycle } from './tab-work-lifecycle';
import type { MediaItem, MediaVariant } from '@extension/shared';

let tabWorkLifecycle: TabWorkLifecycle | undefined;

const configureDetectionTabLifecycle = (lifecycle: TabWorkLifecycle) => {
  tabWorkLifecycle = lifecycle;
};

// Convert a remote image URL to a data URL so it can be displayed in the popup
// (the popup has COEP: require-corp which blocks cross-origin image loads)
const fetchThumbnailAsDataUrl = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // Convert to base64 in chunks to avoid stack overflow
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
};

// URLs we've already attempted a HEAD probe for, to avoid repeat requests
// when an item is patched / re-upserted. Set membership doesn't say whether
// the probe succeeded, only that we've tried.
const headProbedUrls = new Set<string>();

// One-shot HEAD probe to learn Content-Length for an HTTP video/audio URL
// the browser never fetched directly (e.g. an <a href> alt-quality download
// link). Patches the item via upsertDetection on success. Silent on failure.
const probeContentLength = async (url: string, tabId?: number, pageUrl?: string, generation?: number) => {
  if (headProbedUrls.has(url)) return;
  headProbedUrls.add(url);
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'omit', redirect: 'follow' });
    if (!res.ok) return;
    const cl = res.headers.get('content-length');
    const bytes = cl ? Number(cl) : NaN;
    if (!Number.isFinite(bytes) || bytes < MIN_MEDIA_SIZE_BYTES) return;
    await upsertDetection({ url, contentLength: bytes }, tabId, pageUrl, generation);
  } catch {
    // Server may reject HEAD, block CORS, or be offline — fine, just no size.
  }
};

const seenUrlsByTab = new Map<number, Set<string>>();
const seenHlsMasterDirsByTab = new Map<number, Set<string>>();
// Tabs where a content script has seen a rendered <video>/<audio> element
// above the "main player" size threshold. Used to gate network-sourced
// progressive video/audio detections: listing pages (Instagram saved-posts
// grid, TikTok feeds) preload post MP4s but have no active player, so
// dropping those detections avoids a flood of phantom entries. HLS/DASH
// manifests still pass through — they're valuable even without a visible
// player and rare on listing pages.
const tabsWithMainVideo = new Set<number>();

const ensureSeenCache = (tabId?: number) => {
  if (tabId === undefined) return undefined;
  if (!seenUrlsByTab.has(tabId)) {
    seenUrlsByTab.set(tabId, new Set());
  }
  return seenUrlsByTab.get(tabId);
};

const ensureSeenMasterDirCache = (tabId?: number) => {
  if (tabId === undefined) return undefined;
  if (!seenHlsMasterDirsByTab.has(tabId)) {
    seenHlsMasterDirsByTab.set(tabId, new Set());
  }
  return seenHlsMasterDirsByTab.get(tabId);
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const shortEdge = (r: { width: number; height: number }) => Math.min(r.width, r.height);

// Group same-host same-duration HTTP video items into a single MediaItem with
// a variants[] list. This is the lolpol/HD+SD case: a page exposes multiple
// direct MP4 URLs of the same video, one per quality. We pick the largest-
// resolution URL as the primary and attach the rest as variants so the UI can
// show a single row with a quality dropdown.
//
// Eligibility is intentionally loose: kind='video', http URL, known duration.
// Resolution is NOT required — some probes fail (CORS, referer-locked servers),
// and we still want to merge those items as variants rather than show duplicates.
//
// Re-mergeable: existing merged items (with variants[]) are decomposed back
// into per-variant streams and re-bucketed alongside any newly-detected URLs.
// This catches the case where a third URL is detected AFTER an initial HD+SD
// merge — without decomposition the new URL would be stuck as a standalone.
//
// Pre-existing audioUrl on any merged item gets cleared — variant-merge wins
// over a bogus earlier +A pair-detect.
const consolidateHttpVideoVariants = (items: MediaItem[]): MediaItem[] => {
  type Stream = {
    url: string;
    resolution?: { width: number; height: number };
    contentLength?: number;
    sourceIdx: number; // index of the source MediaItem in `items`
  };
  const buckets = new Map<string, Stream[]>();
  const eligibleIdx = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== 'video' || !it.duration || !it.url.startsWith('http')) continue;
    const host = hostOf(it.url);
    if (!host) continue;
    eligibleIdx.add(i);
    const key = `${host}|${Math.round(it.duration * 10)}`;
    const list = buckets.get(key) ?? [];
    if (!buckets.has(key)) buckets.set(key, list);

    if (it.variants && it.variants.length > 0) {
      // Decompose: each variant becomes a stream in the bucket.
      for (const v of it.variants) {
        list.push({
          url: v.url,
          resolution: v.resolution,
          contentLength: v.contentLength,
          sourceIdx: i,
        });
      }
    } else {
      list.push({
        url: it.url,
        resolution: it.resolution,
        contentLength: it.contentLength,
        sourceIdx: i,
      });
    }
  }

  // Decide which buckets actually need consolidation work. A bucket needs work
  // if it has >1 stream OR if its single stream lives inside a variants[] (so
  // it should be flattened back to a standalone item).
  const bucketsNeedingWork = new Map<string, Stream[]>();
  for (const [key, streams] of buckets.entries()) {
    if (streams.length > 1) {
      bucketsNeedingWork.set(key, streams);
      continue;
    }
    const onlySource = items[streams[0].sourceIdx];
    if (onlySource.variants && onlySource.variants.length > 1) {
      // Source had multiple variants but only one survives — flatten back.
      bucketsNeedingWork.set(key, streams);
    }
  }

  if (bucketsNeedingWork.size === 0) return items;

  // Build the rebuilt MediaItems keyed by the source index that should host them
  // (the lowest source index in each bucket — preserves list order).
  const rebuilt = new Map<number, MediaItem>();
  const consumedIdx = new Set<number>();

  for (const streams of bucketsNeedingWork.values()) {
    const sortedStreams = [...streams].sort((a, b) => {
      const aShort = a.resolution ? shortEdge(a.resolution) : -1;
      const bShort = b.resolution ? shortEdge(b.resolution) : -1;
      return bShort - aShort;
    });

    const hostIdx = Math.min(...streams.map(s => s.sourceIdx));
    streams.forEach(s => consumedIdx.add(s.sourceIdx));

    const hostItem = items[hostIdx];

    if (sortedStreams.length === 1) {
      // Single stream — emit as standalone (resolution/contentLength inlined).
      const s = sortedStreams[0];
      rebuilt.set(hostIdx, {
        ...hostItem,
        url: s.url,
        resolution: s.resolution,
        contentLength: s.contentLength,
        variants: undefined,
        audioUrl: undefined,
        audioMimeType: undefined,
      });
      continue;
    }

    // Multi-stream — merge as one item with variants[].
    const primary = sortedStreams[0];
    // Prefer the source item that owned the primary stream so we inherit its
    // title/thumbnail/duration, falling back to hostItem (the first source in
    // list order) when the primary's source no longer exists in `items`.
    const primarySource = items.find((_, i) => streams.some(s => s.url === primary.url && s.sourceIdx === i));
    const inheritFrom = primarySource ?? hostItem;

    const variants: MediaVariant[] = sortedStreams.map(s => ({
      url: s.url,
      resolution: s.resolution,
      contentLength: s.contentLength,
    }));

    rebuilt.set(hostIdx, {
      ...inheritFrom,
      url: primary.url,
      variants,
      contentLength: undefined,
      resolution: undefined,
      audioUrl: undefined,
      audioMimeType: undefined,
    });
  }

  // Emit in original order: pass-through ineligible items, replace eligible
  // ones with their bucket's rebuilt host (or skip if they've been consumed by
  // a host at a smaller index).
  const result: MediaItem[] = [];
  for (let i = 0; i < items.length; i++) {
    if (rebuilt.has(i)) {
      result.push(rebuilt.get(i)!);
    } else if (eligibleIdx.has(i) && consumedIdx.has(i)) {
      // Consumed by a bucket whose host is at a smaller index — already pushed.
      continue;
    } else {
      result.push(items[i]);
    }
  }
  return result;
};

// Find a video-only entry in `list` that looks like the missing half of an
// adaptive pair (same host, matching duration, no existing audioUrl) for the
// given `probe`. Returns its index, or -1. Called from both the insert path
// and the patch path — a network detection arrives without duration, so the
// pair-merge only becomes possible after the scripting callback patches
// duration in. Scanning on every patch is cheap (per-tab list is capped at 50).
//
// Guard against false pairing: if both streams have a known resolution (via the
// content-script metadata probe), they're both real video tracks — Instagram-
// style pairing only applies when one side is audio-only (no resolution after
// probe). Without this guard, sites that offer HD + SD MP4s of the same
// duration get incorrectly merged into a single "HTTP+A" item.
const findAdaptiveMateIdx = (
  list: MediaItem[],
  probe: { url: string; duration?: number; kind?: MediaItem['kind']; resolution?: MediaItem['resolution'] },
): number => {
  if (probe.kind !== 'video' || !probe.duration) return -1;
  const probeHost = hostOf(probe.url);
  if (!probeHost) return -1;
  return list.findIndex(
    item =>
      item.kind === 'video' &&
      !item.audioUrl &&
      item.url !== probe.url &&
      item.duration &&
      Math.abs(item.duration - (probe.duration ?? 0)) < 0.5 &&
      hostOf(item.url) === probeHost &&
      // Skip when both sides have been probed as full video tracks.
      !(probe.resolution && item.resolution),
  );
};

const dirKey = (url: string) => {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/');
    parts.pop();
    return `${parsed.origin}${parts.join('/')}/`;
  } catch {
    return undefined;
  }
};

const writeBadge = async (tabId: number, count: number) => {
  const text = count > 0 ? String(count) : '';
  try {
    await chrome.action.setBadgeText({ text, tabId });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#4c8dff', tabId });
    }
  } catch {
    // tab may no longer exist
  }
};

// Debounced per-tab badge updates. Instagram (and other adaptive sites)
// fire a burst of MP4 requests that we dedupe as durations arrive — without
// this, the badge flickers 1→2→1→2 during the settling window. 500ms gives
// the scripting.executeScript duration callback time to arrive on slower
// pages before the badge commits.
const BADGE_DEBOUNCE_MS = 500;
const badgeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const badgePending = new Map<number, number>();

const updateBadge = (tabId: number, count: number) => {
  badgePending.set(tabId, count);
  const existing = badgeTimers.get(tabId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    const finalCount = badgePending.get(tabId) ?? 0;
    badgeTimers.delete(tabId);
    badgePending.delete(tabId);
    void writeBadge(tabId, finalCount);
  }, BADGE_DEBOUNCE_MS);
  badgeTimers.set(tabId, timer);
};

// Debounced per-tab storage writes. The popup/side-panel re-renders on
// every storage change, so writing on each upsert-or-dedupe step produces
// visible flicker during the same settling window that affects the badge.
// In-memory cache is the source of truth until the flush timer fires; reads
// go through it so subsequent upserts within the window see the latest.
// Matches badge debounce so content-UI and badge commit together.
const TAB_WRITE_DEBOUNCE_MS = 500;
const pendingTabItems = new Map<string, MediaItem[]>();
const tabWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const presentationThumbnailRequests = new Map<string, string | null>();

const flushTabItems = async (tabKey: string) => {
  const items = pendingTabItems.get(tabKey);
  if (items === undefined) return;
  pendingTabItems.delete(tabKey);
  tabWriteTimers.delete(tabKey);
  const state = await mediaDetectionsStorage.get();
  await mediaDetectionsStorage.set({ ...state, [tabKey]: items });
};

const scheduleTabWrite = (tabKey: string) => {
  const existing = tabWriteTimers.get(tabKey);
  if (existing) clearTimeout(existing);
  tabWriteTimers.set(
    tabKey,
    setTimeout(() => {
      void flushTabItems(tabKey);
    }, TAB_WRITE_DEBOUNCE_MS),
  );
};

const getTabItems = async (tabKey: string): Promise<MediaItem[]> => {
  const pending = pendingTabItems.get(tabKey);
  if (pending) return pending;
  const state = await mediaDetectionsStorage.get();
  return state[tabKey] ?? [];
};

const setTabItems = (tabKey: string, items: MediaItem[]) => {
  pendingTabItems.set(tabKey, items);
  scheduleTabWrite(tabKey);
};

const updatePresentationMetadata = async (
  itemId: string,
  metadata: { thumbnailUrl: string | null; duration?: number },
  tabId: number,
): Promise<boolean> => {
  const requestKey = `${tabId}:${itemId}`;
  presentationThumbnailRequests.set(requestKey, metadata.thumbnailUrl);
  const thumbnail = metadata.thumbnailUrl ? await fetchThumbnailAsDataUrl(metadata.thumbnailUrl) : undefined;
  if (presentationThumbnailRequests.get(requestKey) !== metadata.thumbnailUrl) return false;
  const duration =
    metadata.duration !== undefined && Number.isFinite(metadata.duration) && metadata.duration > 0
      ? metadata.duration
      : undefined;
  if (duration === undefined && metadata.thumbnailUrl === null) {
    const tabKey = String(tabId);
    const current = await getTabItems(tabKey);
    const updated = applyPresentationMetadata(current, itemId, { thumbnail: null });
    if (!updated) return false;
    setTabItems(tabKey, updated);
    return true;
  }

  const tabKey = String(tabId);
  const current = await getTabItems(tabKey);
  const updated = applyPresentationMetadata(current, itemId, {
    thumbnail: thumbnail ?? null,
    ...(duration !== undefined ? { duration } : {}),
  });
  if (!updated) return false;
  setTabItems(tabKey, updated);
  return true;
};

const normalizeDetection = (candidate: Partial<MediaItem>, tabId?: number, pageUrl?: string): MediaItem => {
  const kind = candidate.kind ?? deriveKind(candidate.url!, candidate.mimeType);
  return {
    id: candidate.id ?? createId(),
    url: candidate.url!,
    mimeType: candidate.mimeType,
    title: candidate.title ?? documentTitleFromUrl(pageUrl),
    pageUrl,
    tabId,
    detectedAt: candidate.detectedAt ?? Date.now(),
    source: candidate.source ?? 'element',
    fileName: candidate.fileName ?? deriveFileName(candidate.url!, candidate.title),
    contentLength: candidate.contentLength,
    kind,
    variants: candidate.variants,
    hlsChildUrls: candidate.hlsChildUrls,
    resolution: candidate.resolution,
    thumbnail: candidate.thumbnail,
    duration: candidate.duration,
    audioUrl: candidate.audioUrl,
    audioMimeType: candidate.audioMimeType,
    subtitles: candidate.subtitles,
    isDrmProtected: candidate.isDrmProtected,
  };
};

export const upsertDetection = async (
  candidate: Partial<MediaItem>,
  tabId?: number,
  pageUrl?: string,
  generation?: number,
) => {
  if (tabId !== undefined && generation !== undefined && !tabWorkLifecycle?.isCurrent(tabId, generation)) return;
  if (!candidate.url) {
    dlLog('detect.drop.missing_url', { tabId, pageUrl, candidate });
    return;
  }
  dlLog('detect.upsert.start', {
    tabId,
    pageUrl,
    url: candidate.url,
    source: candidate.source,
    kind: candidate.kind,
    resolution: candidate.resolution,
    variantCount: candidate.variants?.length ?? 0,
    hasAudio: Boolean(candidate.audioUrl),
  });

  // Normalize CDN byte-range URLs (e.g. Instagram's ?bytestart=...&byteend=...)
  // so each chunk of the same video collapses to a single entry and the
  // download target is the full-file URL.
  candidate.url = normalizeMediaUrl(candidate.url);

  // Convert remote thumbnail URLs to data URLs upfront
  if (candidate.thumbnail && !candidate.thumbnail.startsWith('data:')) {
    const dataUrl = await fetchThumbnailAsDataUrl(candidate.thumbnail);
    if (tabId !== undefined && generation !== undefined && !tabWorkLifecycle?.isCurrent(tabId, generation)) return;
    candidate.thumbnail = dataUrl ?? undefined;
  }

  const tabKey = tabId !== undefined ? String(tabId) : 'unknown';
  let current = await getTabItems(tabKey);
  const normalizedCandidate = normalizeDetection(candidate, tabId, pageUrl);
  dlLog('detect.upsert.normalized', {
    tabId,
    itemId: normalizedCandidate.id,
    kind: normalizedCandidate.kind,
    url: normalizedCandidate.url,
    currentCount: current.length,
    variantCount: normalizedCandidate.variants?.length ?? 0,
    variants: normalizedCandidate.variants?.map(v => ({ resolution: v.resolution, url: v.url })),
  });

  const hlsReconciliation = reconcileHlsPlaylistEvidence(current, normalizedCandidate);
  if (hlsReconciliation.consumed) return;
  current = hlsReconciliation.items;

  // A provider extractor that supplies a complete variants list is the
  // authority for that page's player. Its signed CDN URLs change on refresh,
  // so URL-only dedup would leave an old item beside the new one. Replace any
  // prior authority for the same page and suppress lower-level network/MSE
  // evidence once the authoritative item exists.
  if (isVariantAuthority(normalizedCandidate)) {
    const counterpart = current.find(item => sameMainPlayerSession(item, normalizedCandidate));
    const replacement = counterpart
      ? {
          ...normalizedCandidate,
          id: counterpart.id,
          thumbnail: counterpart.thumbnail ?? normalizedCandidate.thumbnail,
          duration: counterpart.duration ?? normalizedCandidate.duration,
          detectedAt: Math.min(counterpart.detectedAt, normalizedCandidate.detectedAt),
        }
      : normalizedCandidate;
    const remaining = current.filter(item => !sameMainPlayerSession(item, normalizedCandidate));
    const updated = [replacement, ...remaining].slice(0, 50);
    setTabItems(tabKey, updated);
    if (tabId !== undefined) updateBadge(tabId, updated.length);
    dlLog('detect.upsert.authority', {
      tabId,
      itemId: replacement.id,
      replacedItemId: counterpart?.id,
      count: updated.length,
      variantCount: replacement.variants?.length ?? 0,
      variants: replacement.variants?.map(v => ({ resolution: v.resolution, url: v.url })),
    });
    return;
  }

  const existingAuthority = current.find(
    item => isVariantAuthority(item) && sameMainPlayerSession(item, normalizedCandidate),
  );
  if (
    existingAuthority &&
    (normalizedCandidate.source === 'network' ||
      normalizedCandidate.kind === 'mse' ||
      normalizedCandidate.kind === 'audio')
  ) {
    if (
      normalizedCandidate.kind === 'mse' &&
      ((normalizedCandidate.thumbnail && !existingAuthority.thumbnail) ||
        (normalizedCandidate.duration && normalizedCandidate.duration !== existingAuthority.duration))
    ) {
      const updated = current.map(item =>
        item.id === existingAuthority.id
          ? {
              ...item,
              thumbnail: item.thumbnail ?? normalizedCandidate.thumbnail,
              duration: normalizedCandidate.duration ?? item.duration,
            }
          : item,
      );
      setTabItems(tabKey, updated);
    }
    return;
  }

  // Un-pair safety net: if this candidate's probe just revealed a real
  // resolution AND its URL is currently bound as another item's audioUrl, the
  // earlier pair-detect was wrong (two video tracks got merged as if one were
  // audio). Clear the audioUrl on the primary so this URL re-emerges below as
  // a standalone item.
  if (candidate.resolution) {
    const stolenByIdx = current.findIndex(it => it.audioUrl === candidate.url);
    if (stolenByIdx !== -1) {
      const primary = current[stolenByIdx];
      const cleared: MediaItem = { ...primary, audioUrl: undefined, audioMimeType: undefined };
      current = current.map((it, i) => (i === stolenByIdx ? cleared : it));
      setTabItems(tabKey, current);
    }
  }

  // Variant-aware patch: if this URL is already a variant of an existing
  // merged item, patch the variant in place. Catches:
  // - HEAD probe results landing after the variant-merge
  // - Late metadata probe sending resolution
  // - Element re-scans firing for a URL that's already merged in
  const variantOwnerIdx = current.findIndex(it => it.variants?.some(v => v.url === candidate.url));
  if (variantOwnerIdx !== -1) {
    if (candidate.contentLength || candidate.resolution) {
      const owner = current[variantOwnerIdx];
      const newVariants = (owner.variants ?? []).map(v =>
        v.url === candidate.url
          ? {
              ...v,
              contentLength: v.contentLength ?? candidate.contentLength,
              resolution: v.resolution ?? candidate.resolution,
            }
          : v,
      );
      const updated = current.map((it, i) => (i === variantOwnerIdx ? { ...it, variants: newVariants } : it));
      setTabItems(tabKey, updated);
      if (tabId !== undefined) updateBadge(tabId, updated.length);
    }
    // No richer data to add — drop the duplicate detection on the floor.
    return;
  }

  const existingIdx = current.findIndex(item => item.url === candidate.url);
  const mainPlayerReconciliation = reconcilePlayerEvidence(current, normalizedCandidate);
  if (mainPlayerReconciliation.consumed) {
    setTabItems(tabKey, mainPlayerReconciliation.items);
    if (tabId !== undefined) updateBadge(tabId, mainPlayerReconciliation.items.length);
    return;
  }

  if (existingIdx !== -1) {
    // Patch existing entry with richer data (thumbnail, duration, variants) if we now have it
    const existing = current[existingIdx];
    const patch: Partial<MediaItem> = {};
    if (candidate.thumbnail && !existing.thumbnail) patch.thumbnail = candidate.thumbnail;
    if (candidate.duration && !existing.duration) patch.duration = candidate.duration;
    if (candidate.resolution && !existing.resolution) patch.resolution = candidate.resolution;
    if (candidate.contentLength && !existing.contentLength) patch.contentLength = candidate.contentLength;
    const variants = selectRicherVariants(existing.variants, candidate.variants);
    if (variants !== existing.variants) patch.variants = variants;
    if (candidate.hlsChildUrls?.length) patch.hlsChildUrls = candidate.hlsChildUrls;
    if (candidate.audioUrl && !existing.audioUrl) {
      patch.audioUrl = candidate.audioUrl;
      patch.audioMimeType = candidate.audioMimeType;
    }
    if (candidate.subtitles?.length && !existing.subtitles?.length) patch.subtitles = candidate.subtitles;
    if (
      candidate.title &&
      (!existing.title || existing.title === existing.pageUrl || existing.title?.match(/^[\w.-]+\.\w{2,}$/))
    ) {
      patch.title = candidate.title;
      // Always re-derive fileName from the updated title (regardless of what old fileName looks like)
      patch.fileName = deriveFileName(existing.url, candidate.title);
    }
    if (Object.keys(patch).length === 0) return;

    let updatedList = [...current];
    const patched = { ...existing, ...patch };
    updatedList[existingIdx] = patched;

    // Duration just became known — handle adaptive-stream dedup. Instagram
    // serves 3+ MP4s per post (multiple video qualities + one audio), all
    // inserted into storage without duration. Once duration lands here:
    //   a) If an already-paired sibling exists (same host+duration, has
    //      audioUrl), the patched item is a redundant quality variant — drop
    //      it. This covers patches that fire AFTER another merge completed.
    //   b) Otherwise, look for a standalone same-host+same-duration mate and
    //      pair them; then drop any other unpaired siblings we collect.
    if (patch.duration && patched.kind === 'video' && !patched.audioUrl) {
      const probeHost = hostOf(patched.url);
      const probeDur = patched.duration;
      const pairedSiblingExists = updatedList.some(
        (it, i) =>
          i !== existingIdx &&
          it.kind === 'video' &&
          it.audioUrl &&
          it.duration &&
          probeDur &&
          Math.abs(it.duration - probeDur) < 0.5 &&
          hostOf(it.url) === probeHost,
      );
      if (pairedSiblingExists) {
        updatedList = updatedList.filter((_, i) => i !== existingIdx);
      } else {
        const mateIdx = findAdaptiveMateIdx(updatedList, patched);
        if (mateIdx !== -1 && mateIdx !== existingIdx) {
          const [keepIdx, mergeIdx] = mateIdx < existingIdx ? [mateIdx, existingIdx] : [existingIdx, mateIdx];
          const primary = updatedList[keepIdx];
          const secondary = updatedList[mergeIdx];
          const merged = { ...primary, audioUrl: secondary.url, audioMimeType: secondary.mimeType };
          const keepHost = hostOf(merged.url);
          const keepDur = merged.duration;
          updatedList = updatedList
            .filter((_, i) => i !== mergeIdx)
            .filter(it => {
              if (it.url === merged.url) return true;
              if (it.kind !== 'video' || it.audioUrl) return true;
              if (!it.duration || !keepDur) return true;
              if (Math.abs(it.duration - keepDur) >= 0.5) return true;
              if (hostOf(it.url) !== keepHost) return true;
              return false;
            });
          const finalKeepIdx = updatedList.findIndex(it => it.url === merged.url);
          if (finalKeepIdx !== -1) updatedList[finalKeepIdx] = merged;
        }
      }
    }

    const consolidated = consolidateHttpVideoVariants(updatedList);
    setTabItems(tabKey, consolidated);
    if (tabId !== undefined) updateBadge(tabId, consolidated.length);
    return;
  }

  // Once a real stream exists, element/MSE observations are player-side
  // evidence rather than additional downloadable artifacts. Presentation
  // metadata reaches the exact item through PRESENTATION_METADATA after the
  // player-facing resolver has established ownership.
  if (
    (candidate.kind === 'video' || candidate.kind === 'audio' || candidate.kind === 'mse') &&
    current.some(item => item.kind === 'hls' || item.kind === 'dash' || item.kind === 'mss')
  ) {
    return;
  }

  // Pair-detect Instagram-style adaptive delivery: two MP4 URLs on the same
  // host with matching duration are video-only + audio-only tracks of the
  // same stream. This runs on insert when duration is already known; the
  // network path arrives without duration and is handled by the patch-branch
  // re-run above once the scripting callback supplies duration.
  if (candidate.kind === 'video' && candidate.mimeType?.startsWith('video/') && candidate.duration) {
    const mateIdx = findAdaptiveMateIdx(current, {
      url: candidate.url,
      duration: candidate.duration,
      kind: candidate.kind,
      resolution: candidate.resolution,
    });
    if (mateIdx !== -1) {
      const updatedList = [...current];
      updatedList[mateIdx] = { ...current[mateIdx], audioUrl: candidate.url, audioMimeType: candidate.mimeType };
      setTabItems(tabKey, updatedList);
      if (tabId !== undefined) updateBadge(tabId, updatedList.length);
      return;
    }
  }

  const seenSet = ensureSeenCache(tabId);
  const normalized = normalizedCandidate;
  // When an HLS/DASH/MSS manifest arrives, drop any pre-existing video/audio/MSE
  // entries for this tab — they are almost certainly player-side requests or the
  // MediaSource shell for the same stream (Instagram, for example, fires
  // progressive-MP4 requests before the MPD).
  const cleaned =
    normalized.kind === 'hls' || normalized.kind === 'dash' || normalized.kind === 'mss'
      ? current.filter(item => item.kind !== 'video' && item.kind !== 'audio' && item.kind !== 'mse')
      : current;
  const inserted = [normalized, ...cleaned].slice(0, 50);
  const updatedList = consolidateHttpVideoVariants(inserted);
  setTabItems(tabKey, updatedList);
  seenSet?.add(candidate.url);
  dlLog('detect.upsert.inserted', {
    tabId,
    itemId: normalized.id,
    count: updatedList.length,
    kind: normalized.kind,
    variantCount: normalized.variants?.length ?? 0,
    variants: normalized.variants?.map(v => ({ resolution: v.resolution, url: v.url })),
  });

  // HEAD probe for HTTP video/audio items the browser didn't fetch directly,
  // so the row can still display a size. HLS/DASH/MSS use the manifest path;
  // MSE has no fetchable source.
  if (
    (normalized.kind === 'video' || normalized.kind === 'audio') &&
    normalized.contentLength === undefined &&
    normalized.url.startsWith('http')
  ) {
    void probeContentLength(normalized.url, tabId, pageUrl, generation);
  }

  if (tabId !== undefined) {
    updateBadge(tabId, updatedList.length);
    // Grab page-level title from the tab via scripting. Player duration and
    // thumbnail are intentionally excluded: page metadata cannot identify a
    // presentation on multi-player documents.
    chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => {
          // ─── Title (priority: JSON-LD > og:title > document.title with suffix stripped) ───
          let title: string | null = null;
          const ldScripts = document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]');
          for (const s of Array.from(ldScripts)) {
            try {
              const d = JSON.parse(s.textContent ?? '');
              const n = d?.name || d?.headline;
              if (n && typeof n === 'string' && n.length > 3) {
                title = n;
                break;
              }
            } catch {
              /* ignore */
            }
          }
          if (!title) {
            title = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? null;
          }
          if (!title) {
            title = document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.content ?? null;
          }
          if (!title) {
            title =
              document.title.replace(/\s*[-|\u2013\u2014]\s*[^-|\u2013\u2014]{1,40}$/, '') || document.title || null;
          }
          // Decode ALL HTML entities using the browser's native parser (textarea trick)
          if (title && title.includes('&')) {
            try {
              const _ta = document.createElement('textarea');
              _ta.innerHTML = title;
              title = _ta.value;
            } catch {
              /* keep as-is */
            }
          }

          return { title };
        },
      })
      .then(results => {
        if (!results || results.length === 0) return;
        // Page title belongs to the top-level document.
        const top = results.find(r => r.frameId === 0)?.result ?? null;
        const merged = { title: top?.title ?? null };
        const patch: Parameters<typeof upsertDetection>[0] = { url: normalized.url };
        // Update title if we have a better one — current title may be just a hostname
        if (merged.title) {
          const decoded = htmlDecode(merged.title);
          if (!normalized.title || normalized.title.match(/^[\w.-]+\.\w{2,}$/)) {
            patch.title = decoded;
          }
        }
        if (Object.keys(patch).length > 1) void upsertDetection(patch, tabId, undefined, generation);
      })
      .catch(() => undefined);
  }
};

export const clearTabDetections = async (tabId: number) => {
  const tabKey = String(tabId);
  const pendingWrite = tabWriteTimers.get(tabKey);
  if (pendingWrite) {
    clearTimeout(pendingWrite);
    tabWriteTimers.delete(tabKey);
  }
  pendingTabItems.delete(tabKey);
  for (const key of presentationThumbnailRequests.keys()) {
    if (key.startsWith(`${tabId}:`)) presentationThumbnailRequests.delete(key);
  }
  const state = await mediaDetectionsStorage.get();
  if (state[tabKey]) {
    const next = { ...state };
    delete next[tabKey];
    await mediaDetectionsStorage.set(next);
  }
  seenUrlsByTab.delete(tabId);
  seenHlsMasterDirsByTab.delete(tabId);
  clearFmp4RangeDetectionsForTab(tabId);
  tabsWithMainVideo.delete(tabId);
  const pendingBadge = badgeTimers.get(tabId);
  if (pendingBadge) {
    clearTimeout(pendingBadge);
    badgeTimers.delete(tabId);
    badgePending.delete(tabId);
  }
  void writeBadge(tabId, 0);
};

export const handleNetworkDetection = async (details: chrome.webRequest.WebResponseHeadersDetails) => {
  const url = details.url;
  const tabId = details.tabId;
  const generation = tabId === undefined ? undefined : tabWorkLifecycle?.generationForCapture(tabId);
  if (tabId !== undefined && generation === undefined) return;
  // `onResponseStarted` can precede the replacement document's load event.
  // Retain that early event, but do not let it write until the previous
  // generation has finished clearing its detections and captured headers.
  if (tabId !== undefined && generation !== undefined) {
    const ready = await tabWorkLifecycle?.waitForCapture(tabId, generation);
    if (!ready) return;
  }
  dlLog('detect.network.received', {
    tabId,
    url,
    type: details.type,
    initiator: details.initiator,
    statusCode: details.statusCode,
    responseHeaders: details.responseHeaders?.filter(h =>
      ['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(h.name.toLowerCase()),
    ),
  });
  if (tabId !== undefined && tabId < 0) {
    dlLog('detect.network.drop.invalid_tab', { tabId, url });
    return;
  }
  // Skip data: and chrome-extension: URLs
  if (url.startsWith('data:') || url.startsWith('chrome-extension:') || url.startsWith('chrome:')) {
    dlLog('detect.network.drop.internal_url', { tabId, url });
    return;
  }

  const contentType = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value;
  const contentLengthHeader = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-length')?.value;
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;

  // Use actual tab URL (details.initiator is only the scheme+host, not the full path).
  let pageUrl = details.initiator;
  if (tabId !== undefined && tabId >= 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) pageUrl = tab.url;
    } catch {
      // tab may not exist
    }
  }

  const fmp4 = await handleFmp4RangeDetection({
    url,
    tabId,
    pageUrl,
    responseHeaders: details.responseHeaders,
    requestHeaders: findCapturedHeaders(url, undefined, tabId),
    mimeType: contentType,
  });
  dlLog('detect.network.fmp4_result', {
    tabId,
    url,
    handled: fmp4.handled,
    hasCandidate: Boolean(fmp4.candidate),
    candidate: fmp4.candidate && {
      kind: fmp4.candidate.kind,
      resolution: fmp4.candidate.resolution,
      contentLength: fmp4.candidate.contentLength,
      url: fmp4.candidate.url,
    },
  });
  if (fmp4.candidate) await upsertDetection(fmp4.candidate, tabId, pageUrl, generation);
  if (fmp4.handled) return;

  const kind = deriveKind(url, contentType);
  dlLog('detect.network.classified', { tabId, url, kind, contentType, contentLength, pageUrl });
  if (kind === 'other') {
    dlLog('detect.network.drop.other', { tabId, url });
    return;
  }
  if (isHlsSegment(url, contentType)) {
    dlLog('detect.network.drop.hls_segment', { tabId, url });
    return;
  }

  if (isDashSegment(url, contentType)) {
    const dashFmp4 = await handleFmp4RangeDetection({
      url,
      tabId,
      pageUrl,
      responseHeaders: details.responseHeaders,
      requestHeaders: findCapturedHeaders(url, undefined, tabId),
      mimeType: contentType,
    });
    if (dashFmp4.candidate) await upsertDetection(dashFmp4.candidate, tabId, pageUrl, generation);
    dlLog('detect.network.dash_segment', {
      tabId,
      url,
      handled: dashFmp4.handled,
      hasCandidate: Boolean(dashFmp4.candidate),
    });
    return;
  }

  // Skip small payloads for direct media (not manifests) — avoids tracker noise
  if ((kind === 'video' || kind === 'audio') && contentLength !== undefined && contentLength < MIN_MEDIA_SIZE_BYTES) {
    dlLog('detect.network.drop.small_media', { tabId, url, kind, contentLength });
    return;
  }

  let variants: MediaVariant[] | undefined;
  let hlsChildUrls: string[] | undefined;
  let isDrmProtected = false;
  if (kind === 'hls') {
    const parsed = await parseHlsVariants(url);
    variants = parsed.variants;
    hlsChildUrls = parsed.childUrls;
    isDrmProtected = parsed.isDrmProtected;
    dlLog('detect.manifest.hls_parsed', {
      tabId,
      url,
      variantCount: variants.length,
      variants: variants.map(v => ({ resolution: v.resolution, bandwidth: v.bandwidth, url: v.url })),
      isDrmProtected,
    });
    if (variants && variants.length > 1) {
      variants = variants.slice().sort((a, b) => {
        const aRes = a.resolution?.height ?? 0;
        const bRes = b.resolution?.height ?? 0;
        if (aRes !== bRes) return bRes - aRes;
        const aBw = a.bandwidth ?? 0;
        const bBw = b.bandwidth ?? 0;
        return bBw - aBw;
      });
    }
  }

  if (kind === 'dash') {
    const dirSet = ensureSeenMasterDirCache(tabId);
    const directory = dirKey(url);
    if (directory) {
      if (dirSet?.has(directory)) return;
      dirSet?.add(directory);
    }

    const parsed = await parseDashVariants(url);
    variants = parsed.variants;
    isDrmProtected = parsed.isDrmProtected;
    dlLog('detect.manifest.dash_parsed', {
      tabId,
      url,
      variantCount: variants.length,
      variants: variants.map(v => ({ resolution: v.resolution, bandwidth: v.bandwidth, codecs: v.codecs, url: v.url })),
      isDrmProtected,
    });
    if (variants && variants.length > 1) {
      variants = variants.slice().sort((a, b) => {
        const aRes = a.resolution?.height ?? 0;
        const bRes = b.resolution?.height ?? 0;
        if (aRes !== bRes) return bRes - aRes;
        const aBw = a.bandwidth ?? 0;
        const bBw = b.bandwidth ?? 0;
        return bBw - aBw;
      });
    }
  }

  await upsertDetection(
    {
      url,
      mimeType: contentType,
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      source: 'network',
      kind,
      variants,
      hlsChildUrls,
      isDrmProtected: isDrmProtected || undefined,
    },
    tabId,
    pageUrl,
    generation,
  );
};

export const setMainVideoPresent = (tabId: number, present: boolean) => {
  if (present) tabsWithMainVideo.add(tabId);
  else tabsWithMainVideo.delete(tabId);
};

export const hasMainVideo = (tabId: number) => tabsWithMainVideo.has(tabId);

export { configureDetectionTabLifecycle, updatePresentationMetadata };
