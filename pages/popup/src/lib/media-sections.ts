import type { MediaDownloadProgress, MediaItem } from '@extension/shared';

type MediaRow =
  | { type: 'media'; key: string; item: MediaItem }
  | { type: 'download'; key: string; entry: MediaDownloadProgress };

// Include the source tab in the identity: two pages can detect the same URL.
const identity = (item: MediaItem) => `${item.tabId ?? 'unknown'}:${item.id}`;

export const buildMediaSections = (tabId: number | null, media: MediaItem[], downloads: MediaDownloadProgress[]) => {
  const current: MediaRow[] = [];
  const other: MediaRow[] = [];
  const downloading = new Set(downloads.flatMap(entry => (entry.item ? [identity(entry.item)] : [])));
  const append = (sourceTabId: number | undefined, row: MediaRow) => {
    (tabId !== null && sourceTabId === tabId ? current : other).push(row);
  };

  for (const item of media) {
    if (tabId !== null && item.tabId === tabId && !downloading.has(identity(item))) {
      append(item.tabId, { type: 'media', key: identity(item), item });
    }
  }
  for (const entry of downloads) {
    append(entry.item?.tabId, { type: 'download', key: entry.key, entry });
  }
  return { current, other };
};

export type { MediaRow };
