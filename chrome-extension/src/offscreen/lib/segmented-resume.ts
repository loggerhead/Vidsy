import { cacheFingerprint } from './cache-protocol';
import { discardWorkerJobFiles } from './worker-client';
import type { MediaDescriptor } from './media-processing';
import type { SegmentedSource, SegmentedSnapshot } from './segment-policy';

export const prepareSegmentedSource = async (
  key: string,
  identity: unknown,
  live: boolean,
  snapshot?: SegmentedSnapshot,
): Promise<SegmentedSource> => {
  const fingerprint = await cacheFingerprint(identity);
  const response = await chrome.runtime.sendMessage({ type: 'offscreen/segmented-state', payload: { key } });
  if (!response?.ok) throw new Error(response?.error ?? 'Cannot read segmented source identity');
  const prior: SegmentedSource | undefined = response.source;
  const changed = prior && prior.fingerprint !== fingerprint;
  const restartReason = changed
    ? 'Playlist or track identity changed (including sequence drift); cached segments were discarded. Download restarted from the new playlist.'
    : live && prior && !response.reuseSnapshot
      ? 'Live playlists cannot resume. Download restarted as a new snapshot of the current playlist.'
      : undefined;
  if (changed || (live && !response.reuseSnapshot)) await discardWorkerJobFiles(key);
  const source: SegmentedSource = {
    fingerprint,
    live,
    descriptor: !changed && (!live || response.reuseSnapshot) ? prior?.descriptor : undefined,
    snapshot,
  };
  const saved = await chrome.runtime.sendMessage({
    type: 'offscreen/segmented-state',
    payload: { key, source, restartReason },
  });
  if (!saved?.ok) throw new Error(saved?.error ?? 'Cannot persist segmented source identity');
  return source;
};

export const rememberSegmentedDescriptor = async (
  key: string,
  source: SegmentedSource,
  descriptor: MediaDescriptor,
): Promise<void> => {
  const response = await chrome.runtime.sendMessage({
    type: 'offscreen/segmented-state',
    payload: { key, source: { ...source, descriptor } },
  });
  if (!response?.ok) throw new Error(response?.error ?? 'Cannot persist media descriptor');
};

export const readFrozenSegmentedSnapshot = async (key: string): Promise<SegmentedSnapshot | undefined> => {
  const response = await chrome.runtime.sendMessage({ type: 'offscreen/segmented-state', payload: { key } });
  if (!response?.ok) throw new Error(response?.error ?? 'Cannot read completed snapshot identity');
  return response.reuseSnapshot ? response.source?.snapshot : undefined;
};

export { isLiveHls, isLiveDash } from './segment-policy';
export type { SegmentedSource } from './segment-policy';
