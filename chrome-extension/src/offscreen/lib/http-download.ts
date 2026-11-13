import { cacheCommand } from './cache-client';
import { cacheFingerprint } from './cache-protocol';
import { DownloadFailure, failureKind, shouldDiscardInput } from './download-failure';
import { errorInfo, flowLog, safeUrl } from './download-log';
import { canonicalHttpSource } from './http-validator';
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
  adoptHttpSource,
  fetchRangesToOpfs,
  fetchUrlToOpfs,
  getOpfsFile,
  readMaxConnections,
  removeOpfs,
} from './worker-client';
import { CompletedInputRegistry } from '../download_worker/completed-inputs';
import type { RangeProbe } from './range-probe';
import type { ProgressUpdate } from '../download_worker/messages';

const MIN_SIZE_FOR_PARALLEL = 5 * 1024 * 1024; // 5 MB
const TARGET_CHUNK_SIZE = 4 * 1024 * 1024; // Bounded payload independent of file size.

type DownloadTransport = {
  validationMethod?: RangeProbe['validationMethod'];
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
// fetched. The persistent checkpoint determines whether retained bytes
// can be reused after an offscreen or browser restart.
// Download a URL into OPFS, returning the resulting File + resolved content-type.
// Picks Range-parallel when the server supports it and the payload is large enough,
// with the streaming fallback routed through the same worker.
const fetchUrlIntoOpfs = async (args: {
  url: string;
  jobKey: string;
  opfsName: string;
  headers?: Record<string, string>;
  stage: 'download-video' | 'download-audio';
  signal: AbortSignal;
  revalidateCompleted?: boolean;
  preflightProbe?: RangeProbe;
  priorSource?: { url: string; resourceVersion?: string; totalBytes: number };
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
    probe = args.preflightProbe ?? (await probeRangeSupport(url, signal, headers, args.priorSource));
  } catch (err) {
    if (signal.aborted || args.priorSource || failureKind(err) === 'integrity') throw err;
    probe = null;
    fallbackReason = err instanceof Error ? `Range probe failed: ${err.message}` : 'Range probe failed';
  }

  const canUseRanges = !!probe && probe.supportsRange && probe.totalBytes !== undefined && probe.totalBytes > 0;
  if (args.priorSource && !canUseRanges)
    throw new DownloadFailure('integrity', 'Source no longer accepts byte ranges; Retry must download again');

  if (canUseRanges && probe?.totalBytes) {
    try {
      const ranges =
        probe.totalBytes < MIN_SIZE_FOR_PARALLEL
          ? [{ start: 0, end: probe.totalBytes - 1 }]
          : computeRanges(probe.totalBytes);
      const configuredConnections = args.maxConnections ?? (await readMaxConnections());
      const connectionLimit = Math.max(1, Math.min(configuredConnections, ranges.length));
      const transport: DownloadTransport = {
        mode: 'range',
        connectionLimit,
        totalBytes: probe.totalBytes,
        validationMethod: probe.validationMethod,
      };
      await args.onTransport?.(transport);
      const { totalBytes } = await fetchRangesToOpfs({
        jobKey,
        opfsName,
        url,
        keyHeaders: headers,
        ranges,
        totalBytes: probe.totalBytes,
        resourceVersion: probe.resourceVersion,
        weakEtag: probe.weakEtag,
        validationMethod: probe.validationMethod,
        stage,
        maxConnections: connectionLimit,
        reportProgress: args.reportProgress,
        onProgress: args.onProgress,
      });
      const file = await getOpfsFile(opfsName);
      return { file, contentType: probe.contentType, totalBytes, transport };
    } catch (err) {
      if (signal.aborted) throw err;
      // A transfer failure must not erase completed ranges or silently turn
      // Retry into a full stream download. Integrity failures are surfaced.
      throw err;
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

const completedHttpInputs = new CompletedInputRegistry();
const completedHttpMetadata = new Map<string, { contentType: string; transport: DownloadTransport }>();
const downloadUrlToOpfsAttempt = async (
  args: Parameters<typeof fetchUrlIntoOpfs>[0],
): ReturnType<typeof fetchUrlIntoOpfs> => {
  const source = canonicalHttpSource(args.url, args.headers);
  let { record } = await cacheCommand({ operation: 'read', name: args.opfsName });
  if (record?.ranges && record.fingerprint && (await cacheFingerprint(record.ranges.source)) !== record.fingerprint)
    throw new DownloadFailure('integrity', 'Persisted resource fingerprint does not match the source ledger');
  if (record?.ranges && (record.ranges.source.url !== args.url || args.revalidateCompleted)) {
    const fresh = await probeRangeSupport(args.url, args.signal, args.headers);
    if (!fresh.supportsRange || !fresh.totalBytes)
      throw new DownloadFailure('integrity', 'Renewed source no longer supports validated byte ranges');
    await adoptHttpSource(
      args.jobKey,
      args.opfsName,
      {
        ...record.ranges.source,
        url: args.url,
        totalBytes: fresh.totalBytes,
        resourceVersion: fresh.resourceVersion,
        weakEtag: fresh.weakEtag,
        validationMethod: fresh.validationMethod,
      },
      args.headers,
    );
    completedHttpInputs.remove(args.opfsName);
    record = (await cacheCommand({ operation: 'read', name: args.opfsName })).record;
  }
  if (args.revalidateCompleted && record?.complete && record.ranges) {
    const fresh = await probeRangeSupport(args.url, args.signal, args.headers, record.ranges.source);
    if (
      !fresh.supportsRange ||
      (fresh.validationMethod ?? 'etag') !== (record.ranges.source.validationMethod ?? 'etag') ||
      fresh.resourceVersion !== record.ranges.source.resourceVersion ||
      fresh.weakEtag !== record.ranges.source.weakEtag ||
      fresh.totalBytes !== record.complete.size
    )
      throw new DownloadFailure(
        'integrity',
        'Detected resource version or length changed; cached input cannot be reused',
      );
  }
  if (
    args.revalidateCompleted &&
    record?.complete &&
    record.ranges &&
    record.ranges.source.validationMethod &&
    record.ranges.source.validationMethod !== 'etag'
  ) {
    await fetchRangesToOpfs({
      jobKey: args.jobKey,
      opfsName: args.opfsName,
      url: args.url,
      keyHeaders: args.headers,
      ranges: record.ranges.source.ranges,
      totalBytes: record.ranges.source.totalBytes,
      resourceVersion: record.ranges.source.resourceVersion,
      weakEtag: record.ranges.source.weakEtag,
      validationMethod: record.ranges.source.validationMethod,
      stage: args.stage,
      maxConnections: 1,
      reportProgress: args.reportProgress,
      onProgress: args.onProgress,
    });
  }

  if (record?.httpMetadata && record.complete) {
    const completed = structuredClone(record.complete);
    if (completed.source !== source) {
      try {
        const legacy = JSON.parse(completed.source);
        if (
          typeof legacy.url === 'string' &&
          (legacy.headers === undefined ||
            (legacy.headers &&
              typeof legacy.headers === 'object' &&
              !Array.isArray(legacy.headers) &&
              Object.values(legacy.headers).every(value => typeof value === 'string'))) &&
          canonicalHttpSource(legacy.url, legacy.headers) === source
        )
          completed.source = source;
      } catch {
        /* An incompatible source is rejected by the immutable-input registry. */
      }
    }
    completedHttpInputs.restore(args.opfsName, completed);
    completedHttpMetadata.set(args.opfsName, record.httpMetadata);
  }
  const totalBytes = await completedHttpInputs.reuse(
    args.opfsName,
    source,
    () => getOpfsFile(args.opfsName),
    args.signal,
  );
  const metadata = completedHttpMetadata.get(args.opfsName);
  if (totalBytes !== undefined && metadata) {
    await cacheCommand({
      operation: 'write',
      name: args.opfsName,
      jobKey: args.jobKey,
      patch: { size: totalBytes, complete: completedHttpInputs.snapshot(args.opfsName) },
    });
    await args.onTransport?.(metadata.transport);
    const progress: ProgressUpdate = {
      type: 'progress',
      jobId: 'cached-input',
      resumeNotice: 'Complete input verified; processing continues without downloading media.',
      jobKey: args.jobKey,
      stage: args.stage,
      downloadedBytes: totalBytes,
      estimatedBytes: totalBytes,
      activity: 'verifying',
    };
    args.onProgress?.(progress);
    if (args.reportProgress !== false) await updateProgress(args.jobKey, progress);
    return { file: await getOpfsFile(args.opfsName), totalBytes, ...metadata };
  }
  const result = await fetchUrlIntoOpfs({ ...args, priorSource: record?.ranges?.source });
  await completedHttpInputs.remember(args.opfsName, source, result.file, args.signal);
  const nextMetadata = { contentType: result.contentType, transport: result.transport };
  completedHttpMetadata.set(args.opfsName, nextMetadata);
  const latest = await cacheCommand({ operation: 'read', name: args.opfsName });
  await cacheCommand({
    operation: 'write',
    name: args.opfsName,
    jobKey: args.jobKey,
    patch: {
      size: result.totalBytes,
      complete: completedHttpInputs.snapshot(args.opfsName),
      httpMetadata: nextMetadata,
      fingerprint: latest.record?.fingerprint ?? (await cacheFingerprint(source)),
    },
  });
  return result;
};

const downloadUrlToOpfs = async (args: Parameters<typeof fetchUrlIntoOpfs>[0]): ReturnType<typeof fetchUrlIntoOpfs> => {
  try {
    return await downloadUrlToOpfsAttempt(args);
  } catch (error) {
    if (failureKind(error) !== 'integrity' || args.signal.aborted || downloadStopIntents.has(args.jobKey)) throw error;
    await discardCompletedHttpInput(args.opfsName);
    const reason = `Cached input validation failed; the affected input was discarded and download restarted. ${error instanceof Error ? error.message : String(error)}`;
    const response = await chrome.runtime.sendMessage({
      type: 'offscreen/input-restarted',
      payload: { key: args.jobKey, reason },
    });
    if (!response?.ok) throw new Error('Download stopped before restarting invalid input');
    return downloadUrlToOpfsAttempt(args);
  }
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
  revalidateCompleted = false,
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
      revalidateCompleted,
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
          validationMethod: value.validationMethod,
          resumeCapability: value.mode === 'range' ? 'range' : 'restart',
        }),
    });

    await updateProgress(key, {
      stage: 'mux',
      downloadedBytes: totalBytes,
      estimatedBytes: totalBytes,
      resumeCapability: 'complete-input',
      validationMethod: 'local-checksums',
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
      const outputFile = await getOpfsFile(outputOpfsName);
      const delivery = await prepareOutputDelivery({
        signal: abortController.signal,
        jobKey: key,
        file: outputFile,
        opfsName: outputOpfsName,
        plan,
      });
      await discardCompletedHttpInput(inputOpfsName).catch(() => undefined);
      return delivery;
    }

    outputOpfsName = inputOpfsName;
    const delivery = await prepareOutputDelivery({
      signal: abortController.signal,
      jobKey: key,
      file: inputFile,
      opfsName: outputOpfsName,
      plan,
    });
    completedHttpInputs.remove(inputOpfsName);
    completedHttpMetadata.delete(inputOpfsName);
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
    if (shouldDiscardInput(err, downloadStopIntents.get(key))) {
      completedHttpInputs.remove(inputOpfsName);
      completedHttpMetadata.delete(inputOpfsName);
      await discardCompletedHttpInput(inputOpfsName).catch(() => undefined);
    }
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

const discardHttpResume = async (key: string) => discardCompletedHttpInput(await opfsJobName('http', key, 'in', 'bin'));
const discardCompletedHttpInput = async (name: string): Promise<void> => {
  completedHttpInputs.remove(name);
  completedHttpMetadata.delete(name);
  await removeOpfs(name);
};
export { downloadHttpDirect, downloadUrlToOpfs, discardHttpResume, discardCompletedHttpInput };
export type { DownloadTransport };
