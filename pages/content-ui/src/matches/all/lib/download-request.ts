import { MEDIA_MESSAGE } from '@extension/shared';
import type { MediaItem, MediaMessage, MediaVariant } from '@extension/shared';

export const buildDownloadMessage = (
  item: MediaItem,
  variant: MediaVariant | undefined,
  tabId: number | null,
  enableHlsMerging: boolean | undefined,
): Extract<MediaMessage, { type: typeof MEDIA_MESSAGE.DOWNLOAD }> => ({
  type: MEDIA_MESSAGE.DOWNLOAD,
  payload: {
    url: variant?.url ?? item.url,
    // A new user action is an independent request. The media item id remains
    // in the snapshot so the UI can relate progress back to its source.
    key: crypto.randomUUID(),
    kind: item.kind,
    fileName: item.fileName,
    title: item.title,
    tabId: tabId ?? undefined,
    outputFormat: enableHlsMerging ? (item.kind === 'audio' ? 'mp3' : 'mp4') : undefined,
    audioUrl: variant?.audioUrl ?? item.audioUrl,
    audioMimeType: variant?.audioMimeType ?? item.audioMimeType,
    item: {
      ...item,
      url: variant?.url ?? item.url,
      mimeType: variant?.mimeType ?? item.mimeType,
      resolution: variant?.resolution ?? item.resolution,
    },
  },
});
