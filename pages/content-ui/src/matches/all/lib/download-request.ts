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
    key: item.url,
    kind: item.kind,
    fileName: item.fileName,
    title: item.title,
    tabId: tabId ?? undefined,
    outputFormat: enableHlsMerging ? (item.kind === 'audio' ? 'mp3' : 'mp4') : undefined,
    audioUrl: variant?.audioUrl ?? item.audioUrl,
    audioMimeType: variant?.audioMimeType ?? item.audioMimeType,
    item,
  },
});
