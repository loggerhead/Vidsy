import { formatBytes } from './media-helpers';
import { sanitizeLogData } from '@extension/shared';
import type { MediaDownloadProgress } from '@extension/shared';

type DownloadDetails = { title: string; description: string; facts: string[]; error?: string };

const failureDetails = (error?: string): DownloadDetails => {
  if (!error)
    return { title: 'Failed', description: 'The download failed, but no error details were recorded.', facts: [] };
  const safeError = String(sanitizeLogData(error));
  // A status-like number in a resource URL is not an HTTP error code.
  const message = safeError.replace(/\b(?:https?|blob):\S+/gi, '[URL]');
  const permission = message.match(/\b(401|403)\b/);
  let title = 'Failed',
    description = 'The download could not be completed.';
  if (permission || /unauthori[sz]ed|forbidden|permission denied|access denied/i.test(message)) {
    title = `Failed · Permission denied${permission ? ` (${permission[1]})` : ''}`;
    description = 'The server refused access. Refresh the video page, check that you can play it, and try again.';
  } else if (/quota|disk space|temporary storage|OPFS|FILE_NO_SPACE|FILE_ACCESS_DENIED/i.test(message)) {
    title = 'Failed · Storage problem';
    description =
      'The file could not be written or temporary storage is unavailable. Check available disk space and try again.';
  } else if (
    /ffmpeg|libav|mux|media processing|output (?:artifact|MP4|WebM|duration|container)|codec|video track|audio track|input container|moov|mdat|DRM/i.test(
      message,
    )
  ) {
    title = 'Failed · Video processing';
    description =
      'The video could not be processed, merged, or validated. It may be incomplete or use an unsupported format.';
  } else if (/\b(?:HTTP|playlist:|manifest:|status)\s*[45]\d\d\b/i.test(message)) {
    title = 'Failed · Server response';
    description = 'The server returned an error while fetching this video.';
  } else if (/failed to fetch|network|net::|connection|no data|timeout|timed out|DNS|ERR_/i.test(message)) {
    title = 'Failed · Network problem';
    description =
      'A request failed or stopped receiving data. Check the connection and try again; the site may also be blocking the request.';
  } else if (/browser download|browser_delivery|FILE_|USER_CANCELED|download record/i.test(message)) {
    title = 'Failed · Saving problem';
    description = 'Chrome could not finish saving the file. Check the browser download list for more information.';
  }
  return { title, description, facts: [], error: safeError };
};

export const describeDownloadDetails = (progress: MediaDownloadProgress | null, isBusy = false): DownloadDetails => {
  if (!progress)
    return {
      title: isBusy ? 'Starting download' : 'Ready to download',
      description: isBusy ? 'Preparing the download task.' : 'Click to choose a video quality and download.',
      facts: [],
    };
  if (progress.stage === 'failed') return failureDetails(progress.error);
  const stages: Record<string, [string, string]> = {
    queued: [
      'Download queued',
      progress.queuePosition
        ? `Position ${progress.queuePosition} in the download queue.`
        : 'Waiting for a download slot.',
    ],
    init: ['Starting download', 'Preparing the video source and download task.'],
    'fetch-manifest': [
      'Reading video source',
      'Fetching the playlist and checking the available video and audio tracks.',
    ],
    'download-video': ['Downloading video', 'Receiving the video data.'],
    'download-audio': ['Downloading audio', 'Receiving the audio track before merging.'],
    mux: [
      'Processing video',
      progress.muxPercent === undefined
        ? 'Merging or processing the downloaded tracks.'
        : `Processing progress: ${progress.muxPercent}% (estimated).`,
    ],
    finalize: ['Saving video', 'The file is ready. Waiting for Chrome to finish saving it.'],
    success: ['Download complete', 'Chrome has finished saving the file.'],
    paused: ['Download paused', 'The task is paused. Resume it from the download list.'],
    cancelled: ['Download cancelled', 'The task was cancelled. Start a new download to try again.'],
  };
  const activities: Record<string, [string, string]> = {
    'waiting-network': ['Waiting for a connection', 'Waiting for an available download connection.'],
    'waiting-mux': [
      'Waiting to merge',
      'Another video is being processed. This task will continue when the merge slot becomes available.',
    ],
    retrying: ['Retrying download', 'A request failed or timed out. Retrying the affected data.'],
    verifying: ['Checking video', 'Checking the file structure, tracks, and duration before saving.'],
  };
  const terminal = ['success', 'paused', 'cancelled'].includes(progress.stage);
  const [title, description] = (!terminal && progress.activity && activities[progress.activity]) ||
    stages[progress.stage] || ['Download status', progress.stage];
  const facts: string[] = [];
  if (progress.downloadedBytes > 0 && ['download-video', 'download-audio', 'paused'].includes(progress.stage)) {
    const total =
      progress.estimatedBytes && progress.estimatedBytes > 0 ? ` / ~${formatBytes(progress.estimatedBytes)}` : '';
    facts.push(`Received ${formatBytes(progress.downloadedBytes)}${total}`);
  }
  if (progress.totalParts && !terminal && progress.stage !== 'mux' && progress.stage !== 'finalize')
    facts.push(`Completed parts: ${progress.completedParts ?? 0} / ${progress.totalParts}`);
  if (progress.activeConnections !== undefined && ['download-video', 'download-audio'].includes(progress.stage))
    facts.push(
      `Connections: ${progress.activeConnections}${progress.connectionLimit ? ` / ${progress.connectionLimit}` : ''}`,
    );
  return { title, description, facts };
};

export type { DownloadDetails };
