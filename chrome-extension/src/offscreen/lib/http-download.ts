import { jsfetchInputForOpfs, preflightDiskSpace } from './libav-mux';
import { describeDirectFile } from './media-descriptor';
import { executeMuxPlan, requireExecutablePlan } from './media-executor';
import { planMediaProcessing } from './media-processing';
import { prepareOutputDelivery } from './output-delivery';
import { updateProgress, clearProgress } from './progress';
import { activeAbortControllers } from './segment-fetcher';
import {
  cancelWorkerJob,
  fetchRangesToOpfs,
  fetchUrlToOpfs,
  getOpfsFile,
  readMaxConnections,
  removeOpfs,
} from './worker-client';
import type { ProgressUpdate } from '../download_worker/messages';

const MIN_SIZE_FOR_PARALLEL = 5 * 1024 * 1024; // 5 MB
const TARGET_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB per range request
const MAX_PARALLEL_CHUNKS = 8;
const PROBE_TIMEOUT_MS = 10_000;

type RangeProbe = {
  supportsRange: boolean;
  totalBytes?: number;
  contentType: string;
};

type DownloadTransport = {
  mode: 'range' | 'stream';
  connectionLimit: number;
  totalBytes?: number;
  fallbackReason?: string;
};

const probeRangeSupport = async (url: string, signal: AbortSignal): Promise<RangeProbe> => {
  const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
  const res = await fetch(url, {
    method: 'GET',
    headers: { Range: 'bytes=0-0' },
    signal: combinedSignal,
    credentials: 'include',
  });
  await res.arrayBuffer().catch(() => undefined);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    throw new Error('URL returned HTML, not a media file');
  }

  if (res.status === 206) {
    const contentRange = res.headers.get('content-range') ?? '';
    const match = contentRange.match(/\/(\d+)$/);
    const totalBytes = match ? parseInt(match[1], 10) : undefined;
    return { supportsRange: true, totalBytes, contentType };
  }
  const contentLengthHeader = res.headers.get('content-length');
  const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
  return { supportsRange: false, totalBytes, contentType };
};

const computeRanges = (totalBytes: number): { start: number; end: number }[] => {
  const chunkCount = Math.min(Math.ceil(totalBytes / TARGET_CHUNK_SIZE), MAX_PARALLEL_CHUNKS * 8);
  const chunkSize = Math.ceil(totalBytes / chunkCount);
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, totalBytes - 1);
    if (start > end) break;
    ranges.push({ start, end });
  }
  return ranges;
};

// Deterministic OPFS filename per (key, tag, ext) so a paused download can be
// resumed: the next attempt opens the SAME file that holds the bytes already
// fetched. Across browser sessions the offscreen-doc startup GC purges the
// file regardless, but in-session pause / resume works.
const opfsNameFor = (key: string, tag: string, ext: string): string =>
  `http-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}.${ext}`;

// Download a URL into OPFS, returning the resulting File + resolved content-type.
// Picks Range-parallel when the server supports it and the payload is large enough,
// with the streaming fallback routed through the same worker.
const downloadUrlToOpfs = async (args: {
  url: string;
  jobKey: string;
  opfsName: string;
  stage: 'download-video' | 'download-audio';
  signal: AbortSignal;
  maxConnections?: number;
  reportProgress?: boolean;
  onProgress?: (progress: ProgressUpdate) => void;
  onTransport?: (transport: DownloadTransport) => void | Promise<void>;
}): Promise<{ file: File; contentType: string; totalBytes: number; transport: DownloadTransport }> => {
  const { url, jobKey, opfsName, stage, signal } = args;

  let probe: RangeProbe | null = null;
  let fallbackReason: string | undefined;
  try {
    probe = await probeRangeSupport(url, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    probe = null;
    fallbackReason = err instanceof Error ? `Range probe failed: ${err.message}` : 'Range probe failed';
  }

  const canParallelize =
    !!probe && probe.supportsRange && probe.totalBytes !== undefined && probe.totalBytes >= MIN_SIZE_FOR_PARALLEL;

  if (canParallelize && probe?.totalBytes) {
    try {
      const ranges = computeRanges(probe.totalBytes);
      const configuredConnections = args.maxConnections ?? (await readMaxConnections());
      const connectionLimit = Math.max(1, Math.min(configuredConnections, ranges.length));
      const transport: DownloadTransport = { mode: 'range', connectionLimit, totalBytes: probe.totalBytes };
      await args.onTransport?.(transport);
      const { totalBytes } = await fetchRangesToOpfs({
        jobKey,
        opfsName,
        url,
        ranges,
        totalBytes: probe.totalBytes,
        stage,
        maxConnections: connectionLimit,
        reportProgress: args.reportProgress,
        onProgress: args.onProgress,
      });
      const file = await getOpfsFile(opfsName);
      return { file, contentType: probe.contentType, totalBytes, transport };
    } catch (err) {
      if (signal.aborted) throw err;
      // Range-parallel failed; fall back to streaming.
      fallbackReason = err instanceof Error ? `Parallel ranges failed: ${err.message}` : 'Parallel ranges failed';
      try {
        await removeOpfs(opfsName);
      } catch {
        /* ignore */
      }
    }
  } else if (!fallbackReason) {
    if (!probe?.supportsRange) fallbackReason = 'Server did not accept byte ranges';
    else if (probe.totalBytes === undefined) fallbackReason = 'Server did not report the file size';
    else fallbackReason = 'File is smaller than 5 MB';
  }

  const transport: DownloadTransport = {
    mode: 'stream',
    connectionLimit: 1,
    totalBytes: probe?.totalBytes,
    fallbackReason,
  };
  await args.onTransport?.(transport);
  const { totalBytes } = await fetchUrlToOpfs({
    jobKey,
    opfsName,
    url,
    stage,
    reportProgress: args.reportProgress,
    onProgress: args.onProgress,
  });
  const file = await getOpfsFile(opfsName);
  return { file, contentType: probe?.contentType ?? '', totalBytes, transport };
};

/**
 * HTTP direct download. Streams bytes into OPFS via the download worker, then
 * hands the disk-backed File to chrome.downloads (MP4) or transcodes in-place
 * through libav+OPFS (MP3). Peak JS heap stays near zero regardless of size.
 */
const downloadHttpDirect = async (
  url: string,
  key: string,
  output: 'mp4' | 'mp3' = 'mp4',
): ReturnType<typeof prepareOutputDelivery> => {
  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const inputOpfsName = opfsNameFor(key, 'in', 'bin');
  let outputOpfsName: string | null = null;
  let inputBlobUrl: string | null = null;

  try {
    await updateProgress(key, { stage: 'download-video', downloadedBytes: 0 });

    const {
      file: inputFile,
      totalBytes,
    } = await downloadUrlToOpfs({
      url,
      jobKey: key,
      opfsName: inputOpfsName,
      stage: 'download-video',
      signal: abortController.signal,
      onTransport: value =>
        updateProgress(key, {
          stage: 'download-video',
          downloadedBytes: 0,
          transferMode: value.mode,
          activeConnections: value.connectionLimit,
          connectionLimit: value.connectionLimit,
          fallbackReason: value.fallbackReason,
        }),
    });

    const descriptor = await describeDirectFile(inputFile, 'direct');
    const plan = requireExecutablePlan(planMediaProcessing(descriptor, output === 'mp3' ? 'mp3' : 'media'));

    if (plan.type !== 'passthrough') {
      if (plan.type === 'concatenate-fmp4') throw new Error('Unexpected concatenate plan for direct media');
      await preflightDiskSpace(totalBytes);
      outputOpfsName = opfsNameFor(key, 'out', plan.output.container);
      const { jsfetchUrl, blobUrl } = await jsfetchInputForOpfs(inputOpfsName);
      inputBlobUrl = blobUrl;
      await executeMuxPlan({
        jobKey: key,
        outputOpfsName,
        plan,
        input: { urls: [jsfetchUrl] },
        estimatedBytes: totalBytes,
      });
      URL.revokeObjectURL(inputBlobUrl);
      inputBlobUrl = null;
      void removeOpfs(inputOpfsName).catch(() => undefined);

      const outputFile = await getOpfsFile(outputOpfsName);
      const delivery = await prepareOutputDelivery({ file: outputFile, opfsName: outputOpfsName, plan });
      await clearProgress(key);
      return delivery;
    }

    outputOpfsName = inputOpfsName;
    const delivery = await prepareOutputDelivery({ file: inputFile, opfsName: outputOpfsName, plan });
    await clearProgress(key);
    return delivery;
  } catch (err) {
    if (inputBlobUrl) {
      try {
        URL.revokeObjectURL(inputBlobUrl);
      } catch {
        /* ignore */
      }
    }
    void removeOpfs(inputOpfsName).catch(() => undefined);
    if (outputOpfsName && outputOpfsName !== inputOpfsName) {
      void removeOpfs(outputOpfsName).catch(() => undefined);
    }
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};

export { downloadHttpDirect, downloadUrlToOpfs };
export type { DownloadTransport };
