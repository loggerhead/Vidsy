import { errorInfo, flowLog, safeUrl } from './download-log';
import { jsfetchInputForOpfs, preflightDiskSpace } from './libav-mux';
import { describeDirectFile } from './media-descriptor';
import { executeMuxPlan, requireExecutablePlan } from './media-executor';
import { planMediaProcessing } from './media-processing';
import { opfsJobName } from './opfs-job-name';
import { prepareOutputDelivery } from './output-delivery';
import { updateProgress } from './progress';
import { probeRangeSupport } from './range-probe';
import { activeAbortControllers, downloadStopIntents } from './segment-fetcher';
import {
  cancelWorkerJob,
  fetchRangesToOpfs,
  fetchUrlToOpfs,
  getOpfsFile,
  readMaxConnections,
  removeOpfs,
} from './worker-client';
import type { RangeProbe } from './range-probe';
import type { ProgressUpdate } from '../download_worker/messages';

const MIN_SIZE_FOR_PARALLEL = 5 * 1024 * 1024; // 5 MB
const TARGET_CHUNK_SIZE = 4 * 1024 * 1024; // Bounded payload independent of file size.

type DownloadTransport = {
  mode: 'range' | 'stream';
  connectionLimit: number;
  totalBytes?: number;
  fallbackReason?: string;
};

const computeRanges = (totalBytes: number): { start: number; end: number }[] => {
  const chunkCount = Math.ceil(totalBytes / TARGET_CHUNK_SIZE);
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
// Download a URL into OPFS, returning the resulting File + resolved content-type.
// Picks Range-parallel when the server supports it and the payload is large enough,
// with the streaming fallback routed through the same worker.
const downloadUrlToOpfs = async (args: {
  url: string;
  jobKey: string;
  opfsName: string;
  headers?: Record<string, string>;
  stage: 'download-video' | 'download-audio';
  signal: AbortSignal;
  maxConnections?: number;
  reportProgress?: boolean;
  onProgress?: (progress: ProgressUpdate) => void;
  onTransport?: (transport: DownloadTransport) => void | Promise<void>;
}): Promise<{ file: File; contentType: string; totalBytes: number; transport: DownloadTransport }> => {
  const { url, jobKey, opfsName, stage, signal, headers } = args;
  flowLog('http.start', { url: safeUrl(url), stage, key: safeUrl(jobKey), headerNames: Object.keys(headers ?? {}) });

  let probe: RangeProbe | null = null;
  let fallbackReason: string | undefined;
  try {
    probe = await probeRangeSupport(url, signal, headers);
  } catch (err) {
    if (signal.aborted) throw err;
    probe = null;
    fallbackReason = err instanceof Error ? `Range probe failed: ${err.message}` : 'Range probe failed';
  }

  const canUseRanges = !!probe && probe.supportsRange && probe.totalBytes !== undefined && probe.totalBytes > 0;

  if (canUseRanges && probe?.totalBytes) {
    try {
      const ranges =
        probe.totalBytes < MIN_SIZE_FOR_PARALLEL
          ? [{ start: 0, end: probe.totalBytes - 1 }]
          : computeRanges(probe.totalBytes);
      const configuredConnections = args.maxConnections ?? (await readMaxConnections());
      const connectionLimit = Math.max(1, Math.min(configuredConnections, ranges.length));
      const transport: DownloadTransport = { mode: 'range', connectionLimit, totalBytes: probe.totalBytes };
      await args.onTransport?.(transport);
      const { totalBytes } = await fetchRangesToOpfs({
        jobKey,
        opfsName,
        url,
        keyHeaders: headers,
        ranges,
        totalBytes: probe.totalBytes,
        resourceVersion: probe.resourceVersion,
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
      flowLog('http.range.fallback', { url: safeUrl(url), error: errorInfo(err) });
      try {
        await removeOpfs(opfsName);
      } catch {
        /* ignore */
      }
    }
  } else if (!fallbackReason) {
    if (!probe?.supportsRange) fallbackReason = 'Server did not accept byte ranges';
    else if (probe.totalBytes === undefined) fallbackReason = 'Server did not report the file size';
    else fallbackReason = 'Source has no media bytes';
  }

  const transport: DownloadTransport = {
    mode: 'stream',
    connectionLimit: 1,
    totalBytes: probe?.totalBytes,
    fallbackReason,
  };
  flowLog('http.transport', { url: safeUrl(url), ...transport });
  await args.onTransport?.(transport);
  const { totalBytes } = await fetchUrlToOpfs({
    jobKey,
    opfsName,
    url,
    keyHeaders: headers,
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
  headers?: Record<string, string>,
): ReturnType<typeof prepareOutputDelivery> => {
  const abortController = new AbortController();
  activeAbortControllers.set(key, abortController);
  abortController.signal.addEventListener('abort', () => cancelWorkerJob(key));

  const inputOpfsName = await opfsJobName('http', key, 'in', 'bin');
  let outputOpfsName: string | null = null;
  let inputBlobUrl: string | null = null;

  try {
    await updateProgress(key, { stage: 'download-video', downloadedBytes: 0 });

    const { file: inputFile, totalBytes } = await downloadUrlToOpfs({
      url,
      jobKey: key,
      opfsName: inputOpfsName,
      stage: 'download-video',
      signal: abortController.signal,
      headers,
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
    flowLog('http.descriptor', { url: safeUrl(url), totalBytes, descriptor });
    const plan = requireExecutablePlan(planMediaProcessing(descriptor, output === 'mp3' ? 'mp3' : 'media'));

    if (plan.type !== 'passthrough') {
      if (plan.type === 'concatenate-fmp4') throw new Error('Unexpected concatenate plan for direct media');
      await preflightDiskSpace(totalBytes);
      outputOpfsName = await opfsJobName('http', key, 'out', plan.output.container);
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
      await removeOpfs(inputOpfsName).catch(() => undefined);

      const outputFile = await getOpfsFile(outputOpfsName);
      const delivery = await prepareOutputDelivery({ jobKey: key, file: outputFile, opfsName: outputOpfsName, plan });
      return delivery;
    }

    outputOpfsName = inputOpfsName;
    const delivery = await prepareOutputDelivery({ jobKey: key, file: inputFile, opfsName: outputOpfsName, plan });
    return delivery;
  } catch (err) {
    flowLog('http.failed', { url: safeUrl(url), error: errorInfo(err) });
    if (inputBlobUrl) {
      try {
        URL.revokeObjectURL(inputBlobUrl);
      } catch {
        /* ignore */
      }
    }
    if (downloadStopIntents.get(key) !== 'pause') await removeOpfs(inputOpfsName).catch(() => undefined);
    if (outputOpfsName && outputOpfsName !== inputOpfsName) {
      await removeOpfs(outputOpfsName).catch(() => undefined);
    }
    throw err;
  } finally {
    activeAbortControllers.delete(key);
    if (abortController.signal.aborted) {
      await updateProgress(key, { stage: 'cancelled', downloadedBytes: 0 });
    }
  }
};

const discardHttpResume = async (key: string) => removeOpfs(await opfsJobName('http', key, 'in', 'bin'));
export { downloadHttpDirect, downloadUrlToOpfs, discardHttpResume };
export type { DownloadTransport };
