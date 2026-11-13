// Download worker — spawned from the offscreen document.
// Owns OPFS I/O so segment / range streams land on disk via FileSystemSyncAccessHandle
// without holding payloads in the JS heap. The main thread still drives ffmpeg.wasm
// and mounts OPFS Files via WORKERFS at mux time.

import { BufferedWriter } from './buffered-writer';
import { workerCacheCommand, receiveCacheResponse } from './cache-rpc';
import { CompletedInputRegistry } from './completed-inputs';
import { createLibAV, registerJsfetch, registerOutputDevice, flushOutputDevice } from './libav';
import { opfs } from './opfs';
import { assertNonEmptyOutput, assertSuccessfulMux } from './output-validation';
import { persistArtifact, restoreArtifact } from './persistent-artifact';
import { fetchCheckpointedRange, verifyRangeCache } from './range-fetch';
import { RangeResumeRegistry } from './range-resume';
import {
  assertCompleteResponse,
  assertSuccessfulResponse,
  assertRangeResponse,
  RangeResponseError,
  expectedResponseBytes,
} from './response-validation';
import { checkpointSegment } from './segment-checkpoints';
import { cacheFingerprint } from '../lib/cache-protocol';
import { DownloadFailure, failureKind } from '../lib/download-failure';
import { errorInfo, flowLog, safeUrl, setDownloadDiagnosticReporter } from '../lib/download-log';
import { decryptSegment } from '../lib/hls-crypto';
import { headersForFetch } from '../lib/hls-request';
import { canonicalHttpSource } from '../lib/http-validator';
import { buildMediaProcessingArgs } from '../lib/media-processing';
import {
  HttpRequestError,
  openDownloadResponse,
  retryableRequest,
  automaticallyRecoverable,
  waitForRetry,
} from '../lib/network-request';
import { downloadConnections, mergeSlots } from '../lib/resource-budget';
import { createLogger } from '@extension/shared';
import type {
  FetchRangesRequest,
  FetchSegmentsRequest,
  FetchUrlRequest,
  MuxRequest,
  SegmentSpec,
  WorkerRequest,
  WorkerResponse,
} from './messages';
import type { ExpectedRange } from './response-validation';
import type { ChunkProgress } from '@extension/shared';

const MAX_CONCURRENT = 8;
const rangeResume = new RangeResumeRegistry();
const completedInputs = new CompletedInputRegistry();
const restoreCompletedInput = async (name: string) => {
  const { record } = await workerCacheCommand({ operation: 'read', name });
  completedInputs.restore(name, record?.complete);
};
const rememberCompletedInput = async (
  name: string,
  source: string,
  file: Blob,
  signal: AbortSignal,
  jobKey: string,
  manifestHash?: string,
) => {
  await completedInputs.remember(name, source, file, signal);
  await workerCacheCommand({
    operation: 'write',
    name,
    jobKey,
    patch: {
      size: file.size,
      complete: completedInputs.snapshot(name),
      fingerprint: await cacheFingerprint(source),
      manifestHash,
    },
  });
};
const removeCachedFile = async (name: string) => {
  await opfs.remove(name);
  await workerCacheCommand({ operation: 'remove', name });
};
const removeCachedFamily = async (name: string) => {
  const { records = [] } = await workerCacheCommand({ operation: 'list' });
  const names = new Set([
    name,
    ...records
      .filter(record => record.name.startsWith(`${name}.part-`) || record.name === `${name}.init`)
      .map(record => record.name),
  ]);
  for (const entry of names) {
    rangeResume.remove(entry);
    completedInputs.remove(entry);
    await removeCachedFile(entry);
  }
};
const MAX_RETRIES = 3;

const rawPost = (msg: WorkerResponse): void => {
  (self as unknown as Worker).postMessage(msg);
};
const progressPending = new Map<
  string,
  { message: Extract<WorkerResponse, { type: 'progress' }>; timer: ReturnType<typeof setTimeout> }
>();
const diagnosticFiles = new Map<string, string>();
const diagnosticTimes = new Map<string, { bytes: number; lastReceivedAt: number; lastSnapshotAt: number }>();
const progressSent = new Map<string, { at: number; stage: string }>();
const post = (msg: WorkerResponse): void => {
  if (msg.type === 'progress') {
    const now = Date.now();
    const metric = diagnosticTimes.get(msg.jobId) ?? { bytes: 0, lastReceivedAt: now, lastSnapshotAt: 0 };
    if (msg.downloadedBytes !== metric.bytes) {
      metric.bytes = msg.downloadedBytes;
      metric.lastReceivedAt = now;
    }
    if (now - metric.lastSnapshotAt >= 10_000) {
      metric.lastSnapshotAt = now;
      flowLog('worker.download.snapshot', {
        key: msg.jobKey,
        stage: msg.stage,
        activity: msg.activity,
        downloadedBytes: msg.downloadedBytes,
        estimatedBytes: msg.estimatedBytes,
        lastReceivedAt: metric.lastReceivedAt,
        completedParts: msg.completedParts,
        totalParts: msg.totalParts,
        disk: opfs.stats(diagnosticFiles.get(msg.jobId) ?? ''),
      });
    }
    diagnosticTimes.set(msg.jobId, metric);
    const prior = progressSent.get(msg.jobId);
    const pending = progressPending.get(msg.jobId);
    if (!prior || prior.stage !== msg.stage || Date.now() - prior.at >= 350) {
      if (pending) clearTimeout(pending.timer);
      progressPending.delete(msg.jobId);
      progressSent.set(msg.jobId, { at: Date.now(), stage: msg.stage });
      rawPost(msg);
    } else if (pending) pending.message = msg;
    else {
      const entry = {
        message: msg,
        timer: setTimeout(
          () => {
            progressPending.delete(msg.jobId);
            progressSent.set(msg.jobId, { at: Date.now(), stage: entry.message.stage });
            rawPost(entry.message);
          },
          350 - (Date.now() - prior.at),
        ),
      };
      progressPending.set(msg.jobId, entry);
    }
    return;
  }
  if ('jobId' in msg) {
    const pending = progressPending.get(msg.jobId);
    if (pending) {
      clearTimeout(pending.timer);
      rawPost(pending.message);
      progressPending.delete(msg.jobId);
    }
    progressSent.delete(msg.jobId);
    diagnosticTimes.delete(msg.jobId);
    diagnosticFiles.delete(msg.jobId);
  }
  rawPost(msg);
};
setDownloadDiagnosticReporter((event, data) => rawPost({ type: 'diagnostic', event, data }));
let authorizationCounter = 0;
const pendingAuthorization = new Map<
  string,
  { resolve: (result: { key?: string; url: string }) => void; reject: (error: Error) => void }
>();
const authorizeResource = async (
  jobKey: string,
  url: string,
  headers?: Record<string, string>,
): Promise<(() => void) & { url: string }> => {
  if (!headers) return Object.assign(() => {}, { url });
  const authorizationId = `authorize-${++authorizationCounter}`;
  const authorized = await new Promise<{ key?: string; url: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAuthorization.delete(authorizationId);
      reject(new Error('Request header authorization timed out'));
    }, 10_000);
    pendingAuthorization.set(authorizationId, {
      resolve: result => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    post({ type: 'authorize-url', authorizationId, jobKey, url });
  });
  return Object.assign(
    () => {
      if (authorized.key) post({ type: 'release-url', downloadKey: authorized.key, url: authorized.url });
    },
    { url: authorized.url },
  );
};

const openAuthorizedResponse = async (
  jobKey: string,
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
  totalMs?: number,
  extraHeaders?: Record<string, string>,
) => {
  const releases: Array<() => void> = [];
  try {
    const request = await openDownloadResponse(url, {
      signal,
      headers,
      requestHeaders: extraHeaders,
      totalMs,
      authorizeUrl: headers
        ? async target => {
            const release = await authorizeResource(jobKey, target, headers);
            releases.push(release);
            return release.url || target;
          }
        : undefined,
    });
    return {
      ...request,
      dispose: () => {
        request.dispose();
        releases.forEach(release => release());
      },
    };
  } catch (error) {
    releases.forEach(release => release());
    throw error;
  }
};

const activeAborts = new Map<string, Set<AbortController>>();

const registerAbort = (jobKey: string, controller: AbortController): void => {
  const controllers = activeAborts.get(jobKey) ?? new Set<AbortController>();
  controllers.add(controller);
  activeAborts.set(jobKey, controllers);
};

const unregisterAbort = (jobKey: string, controller: AbortController): void => {
  const controllers = activeAborts.get(jobKey);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) activeAborts.delete(jobKey);
};

const fetchWithRetry = async (
  url: string,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
  retries = MAX_RETRIES,
  onBytes?: (downloadedSoFar: number) => void,
  expectedRange?: ExpectedRange,
  maxBufferedBytes?: number,
  writeChunk?: (chunk: Uint8Array, offset: number) => void,
  onActivity?: (activity: 'receiving' | 'retrying') => void,
): Promise<ArrayBuffer> => {
  for (let attempt = 0; attempt < retries; attempt++) {
    let request: Awaited<ReturnType<typeof openDownloadResponse>> | undefined;
    try {
      request = await openDownloadResponse(url, { signal, headers: extraHeaders, totalMs: 10 * 60_000 });
      const res = request.response;
      onActivity?.('receiving');
      if (!res.ok) {
        await res.body?.cancel();
        throw new HttpRequestError(res.status, url);
      }
      flowLog('worker.fetch.response', {
        url: safeUrl(url),
        attempt: attempt + 1,
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        contentLength: res.headers.get('content-length') ?? undefined,
        contentRange: res.headers.get('content-range') ?? undefined,
      });
      try {
        assertSuccessfulResponse(res);
        if (expectedRange) assertRangeResponse(res, expectedRange);
        if (maxBufferedBytes && (expectedResponseBytes(res) ?? 0) > maxBufferedBytes)
          throw new Error('Encrypted HLS segment exceeds the 32 MiB buffer limit');
      } catch (error) {
        await res.body?.cancel();
        throw error;
      }
      // Streaming path: read the body in chunks so the worker can report
      // bytes-per-connection live. Used by the HTTP range download path so
      // the standalone window can show "Fetching · 3.2/8 MB" per chunk.
      if (!res.body) {
        if (expectedRange) throw new RangeResponseError('Range response has no body');
        throw new Error('Media response has no body');
      }
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      onBytes?.(0); // signal "starting" so a retry resets a prior partial count
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          request.touch();
          if (expectedRange && total + value.byteLength > expectedRange.end - expectedRange.start + 1) {
            await reader.cancel();
            throw new RangeResponseError('Range response exceeded the requested interval');
          }
          if (writeChunk) writeChunk(value, total);
          else parts.push(value);
          total += value.byteLength;
          if (maxBufferedBytes && total > maxBufferedBytes) {
            await reader.cancel();
            throw new Error('Encrypted HLS segment exceeds the 32 MiB buffer limit');
          }
          onBytes?.(total);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      assertCompleteResponse(res, total);
      if (expectedRange) assertRangeResponse(res, expectedRange, total);
      if (writeChunk) return new ArrayBuffer(0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.byteLength;
      }
      return out.buffer;
    } catch (err) {
      const reason = request?.signal.aborted ? request.signal.reason : err;
      flowLog('worker.fetch.retry', { url: safeUrl(url), attempt: attempt + 1, error: errorInfo(reason) });
      if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      if (reason instanceof RangeResponseError) throw reason;
      if (attempt === retries - 1 || !retryableRequest(reason)) throw reason;
      onActivity?.('retrying');
      await waitForRetry(500 * 2 ** attempt, signal);
    } finally {
      request?.dispose();
    }
  }
  throw new Error('Unreachable');
};

// Fetch `count` items in parallel (bounded by MAX_CONCURRENT), append their
// buffers to OPFS in strict index order, and report progress along the way.
// Used by both segment and range download paths.
//
// When `chunkMeta` is supplied (HTTP-range case), per-chunk progress is
// included on each `progress` message so the standalone download window can
// render a multi-band position bar plus a connections table.
const parallelFetchToOpfs = async (args: {
  jobId: string;
  opfsName: string;
  count: number;
  fetchOne: (
    i: number,
    signal: AbortSignal,
    onBytes?: (downloaded: number) => void,
    onActivity?: (activity: 'receiving' | 'retrying') => void,
  ) => Promise<ArrayBuffer>;
  stage: 'download-video' | 'download-audio';
  jobKey: string;
  signal: AbortSignal;
  totalEstimatedBytes?: number;
  chunkMeta?: Array<{ start: number; end: number }>;
  resumeChunks?: ChunkProgress[];
  maxConcurrent?: number;
  onChunkDone?: (chunk: ChunkProgress) => void | Promise<void>;
  stagedPartName?: (index: number) => string;
  onPartAppended?: (index: number) => void;
  retainStagedParts?: boolean;
}): Promise<void> => {
  const { jobId, opfsName, count, fetchOne, stage, jobKey, signal, totalEstimatedBytes, chunkMeta, resumeChunks } =
    args;
  const resumedBytes = resumeChunks?.reduce((sum, chunk) => sum + chunk.downloaded, 0) ?? 0;
  const resumeNotice =
    resumedBytes > 0
      ? `Resumed from ${totalEstimatedBytes ? Math.floor((resumedBytes / totalEstimatedBytes) * 100) : 0}% (${resumedBytes} cached bytes verified)`
      : undefined;
  const siblings = new AbortController();
  const fetchSignal = AbortSignal.any([signal, siblings.signal]);
  // Effective concurrency: caller-provided (range downloads with a setting),
  // else worker default. Clamped to a safe band so a corrupted setting
  // can't DoS the server or starve the dispatcher.
  const maxConcurrent = Math.max(1, Math.min(16, args.maxConcurrent ?? MAX_CONCURRENT));

  const pending = new Map<number, Uint8Array | string>();
  let nextToWrite = 0;
  let inFlight = 0;
  let cursor = 0;
  let finishedDispatching = false;
  const errors: Error[] = [];

  // Build chunk states, hydrating any chunks that already completed in a
  // prior run from `resumeChunks` so we can skip them. For range downloads
  // the OPFS file persists across pauses and each completed chunk has
  // already been written at its byte position, so 'done' here means
  // "no fetch or write needed for this chunk on resume".
  const chunkStates: ChunkProgress[] | undefined = chunkMeta?.map((m, i) => {
    const prior = resumeChunks?.find(c => c.i === i && c.start === m.start && c.end === m.end);
    if (prior?.status === 'done') {
      return { i, start: m.start, end: m.end, downloaded: m.end - m.start + 1, status: 'done' as const };
    }
    return { i, start: m.start, end: m.end, downloaded: prior?.downloaded ?? 0, status: 'pending' as const };
  });
  let completedCount = chunkStates?.filter(c => c.status === 'done').length ?? 0;
  const partialBytes = new Map<number, number>();
  const activities = new Map<number, 'waiting-network' | 'receiving' | 'retrying'>();
  let completedBytes = chunkStates?.filter(c => c.status === 'done').reduce((sum, c) => sum + c.downloaded, 0) ?? 0;
  const receivedBytes = () => completedBytes + [...partialBytes.values()].reduce((sum, bytes) => sum + bytes, 0);

  const flushInOrder = (): void => {
    while (pending.has(nextToWrite)) {
      const buf = pending.get(nextToWrite)!;
      pending.delete(nextToWrite);
      if (typeof buf === 'string') {
        if (buf) {
          opfs.copyAppend(buf, opfsName);
          if (!args.retainStagedParts) void opfs.remove(buf);
        }
      } else opfs.append(opfsName, buf);
      args.onPartAppended?.(nextToWrite);
      nextToWrite++;
    }
  };

  const dispatchOne = async (index: number): Promise<void> => {
    // Skip chunks the resume hydration already marked done — their bytes are
    // already in OPFS from a previous run.
    if (chunkStates && chunkStates[index] && chunkStates[index].status === 'done') return;
    if (chunkStates && chunkStates[index]) chunkStates[index].status = 'fetching';
    const onBytes = (downloaded: number): void => {
      partialBytes.set(index, downloaded);
      if (chunkStates && chunkStates[index]) chunkStates[index].downloaded = downloaded;
    };
    let release: (() => void) | undefined;
    activities.set(index, 'waiting-network');
    try {
      release = await downloadConnections.acquire(jobKey, fetchSignal);
      activities.set(index, 'receiving');
      fetchSignal.throwIfAborted();
      const data = await fetchOne(index, fetchSignal, onBytes, activity => activities.set(index, activity));
      completedBytes += partialBytes.get(index) ?? data.byteLength;
      partialBytes.delete(index);
      if (chunkMeta) {
        // Range download: write each chunk directly at its byte offset so
        // chunks can complete out of order without head-of-line blocking,
        // and the OPFS file is correctly laid out even if a pause/resume
        // happened mid-flight.
        opfs.writeAt(opfsName, chunkMeta[index].start, new Uint8Array(data));
      } else {
        // Segment download: must append in sequential order.
        pending.set(index, args.stagedPartName?.(index) ?? new Uint8Array(data));
        flushInOrder();
      }
      completedCount++;
      if (chunkStates && chunkStates[index]) {
        chunkStates[index].status = 'done';
        opfs.flush(opfsName);
        await args.onChunkDone?.(chunkStates[index]);
      }
      // For Range downloads (chunkStates present) we report the sum of bytes
      // across all chunks that have completed fetching, not opfs.size(). The
      // two diverge when a low-indexed chunk is slow — its peers complete
      // and sit in memory waiting for the in-order flush, so opfs.size lags
      // by hundreds of MB. The chunk sum reflects real throughput and keeps
      // speed / ETA / status honest. Other paths still use the write cursor.
      const fetchedBytes = chunkStates
        ? chunkStates.reduce((sum, c) => {
            if (c.status === 'done') return sum + (c.end - c.start + 1);
            if (c.status === 'fetching') return sum + c.downloaded;
            return sum;
          }, 0)
        : receivedBytes();
      const estimatedBytes =
        totalEstimatedBytes ??
        (completedCount > 0
          ? Math.round(((chunkStates ? fetchedBytes : completedBytes) / completedCount) * count)
          : undefined);
      post({
        type: 'progress',
        jobId,
        jobKey,
        stage,
        resumeNotice,
        downloadedBytes: fetchedBytes,
        estimatedBytes,
        chunks: chunkStates ? chunkStates.map(c => ({ ...c })) : undefined,
        completedParts: completedCount,
        totalParts: count,
        activity:
          [...activities.values()].includes('receiving') || activities.size === 0
            ? 'receiving'
            : [...activities.values()].includes('retrying')
              ? 'retrying'
              : 'waiting-network',
      });
    } catch (err) {
      if (chunkStates && chunkStates[index]) chunkStates[index].status = 'error';
      errors.push(err instanceof Error ? err : new Error(String(err)));
      siblings.abort(err);
    } finally {
      activities.delete(index);
      release?.();
    }
  };

  // Periodic snapshot tick — keeps the UI's stats panel live even when no
  // chunk has completed in the last few hundred ms (slow links, big chunks).
  // The dispatchOne post fires on chunk completion; this fires on a 500ms
  // wall-clock cadence with the latest accumulated byte count + chunk states.
  const postSnapshot = (): void => {
    const fetchedBytes = chunkStates
      ? chunkStates.reduce((sum, c) => {
          if (c.status === 'done') return sum + (c.end - c.start + 1);
          if (c.status === 'fetching') return sum + c.downloaded;
          return sum;
        }, 0)
      : receivedBytes();
    const estBytes =
      totalEstimatedBytes ??
      (completedCount > 0
        ? Math.round(((chunkStates ? fetchedBytes : completedBytes) / completedCount) * count)
        : undefined);
    post({
      type: 'progress',
      jobId,
      jobKey,
      stage,
      resumeNotice,
      downloadedBytes: fetchedBytes,
      estimatedBytes: estBytes,
      chunks: chunkStates ? chunkStates.map(c => ({ ...c })) : undefined,
      completedParts: completedCount,
      totalParts: count,
      activity:
        [...activities.values()].includes('receiving') || activities.size === 0
          ? 'receiving'
          : [...activities.values()].includes('retrying')
            ? 'retrying'
            : 'waiting-network',
    });
  };
  const snapshotHandle: ReturnType<typeof setInterval> = setInterval(postSnapshot, 500);

  try {
    await new Promise<void>(resolve => {
      const tick = (): void => {
        if (signal.aborted || errors.length > 0) {
          if (inFlight === 0) resolve();
          return;
        }
        // A slow prefix cannot cause the whole playlist to be prefetched.
        while (inFlight < maxConcurrent && cursor < count && (chunkMeta || cursor < nextToWrite + maxConcurrent)) {
          const i = cursor++;
          inFlight++;
          dispatchOne(i).finally(() => {
            inFlight--;
            if (finishedDispatching && inFlight === 0) resolve();
            else tick();
          });
        }
        if (cursor >= count) {
          finishedDispatching = true;
          if (inFlight === 0) resolve();
        }
      };
      tick();
    });
  } finally {
    clearInterval(snapshotHandle);
    pending.clear();
  }

  if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
  if (errors.length > 0) throw errors[0];
  flushInOrder();
  // One final snapshot so the UI sees the post-flush state immediately.
  postSnapshot();
};

const handleFetchSegments = async (req: FetchSegmentsRequest): Promise<void> => {
  const controller = new AbortController();
  registerAbort(req.jobKey, controller);
  const { jobId, jobKey, opfsName, segments, initUrl, keyHeaders, stage } = req;
  const partNames = segments.map((_, index) => `${opfsName}.part-${index}`);
  const initName = `${opfsName}.init`;
  let discardParts = false;
  let terminal: WorkerResponse | undefined;

  diagnosticFiles.set(jobId, opfsName);
  try {
    const manifestHash = req.manifestIdentity ? await cacheFingerprint(req.manifestIdentity) : undefined;
    const source = await cacheFingerprint({ segments, initUrl, initRange: req.initRange, manifestHash, keyHeaders });
    await restoreCompletedInput(opfsName);
    const cachedBytes = await completedInputs.reuse(opfsName, source, () => opfs.getFile(opfsName), controller.signal);
    if (cachedBytes !== undefined) {
      await workerCacheCommand({ operation: 'write', name: opfsName, jobKey, patch: { size: cachedBytes } });
      post({
        type: 'progress',
        jobId,
        jobKey,
        stage,
        downloadedBytes: cachedBytes,
        estimatedBytes: cachedBytes,
        activity: 'verifying',
        completedParts: segments.length,
        totalParts: segments.length,
      });
      terminal = { type: 'fetch-done', jobId, opfsName, totalBytes: cachedBytes };
      return;
    }
    await opfs.open(opfsName);

    if (initUrl) {
      await restoreCompletedInput(initName);
      const cachedInit = await completedInputs.reuse(initName, source, () => opfs.getFile(initName), controller.signal);
      if (cachedInit !== undefined) {
        await workerCacheCommand({ operation: 'write', name: initName, jobKey, patch: { size: cachedInit } });
        await opfs.open(initName, true);
        opfs.copyAppend(initName, opfsName);
        await opfs.close(initName);
      } else {
        const releaseConnection = await downloadConnections.acquire(jobKey, controller.signal);
        const release = await authorizeResource(jobKey, initUrl, keyHeaders).catch(error => {
          releaseConnection();
          throw error;
        });
        try {
          const base = req.initRange?.start ?? 0;
          const checkpointed = await checkpointSegment({
            name: initName,
            jobKey,
            url: initUrl,
            identity: `${source}:init`,
            range: req.initRange,
            signal: controller.signal,
            cache: workerCacheCommand,
            open: (start, end, signal, version) =>
              openAuthorizedResponse(jobKey, initUrl, keyHeaders, signal, 10 * 60_000, {
                Range: `bytes=${start}-${end}`,
                ...(version ? { 'If-Range': version } : {}),
              }),
            disk: {
              open: () => opfs.open(initName, true),
              size: () => opfs.size(initName),
              truncate: () => opfs.truncate(initName, 0),
              io: {
                read: (at, length) => opfs.readAt(initName, at - base, length),
                write: (at, bytes) => opfs.writeAt(initName, at - base, bytes),
                flush: () => opfs.flush(initName),
              },
            },
          });
          let init: ArrayBuffer;
          if (checkpointed) {
            const file = await opfs.getFile(initName);
            if (file.size > 32 * 1024 * 1024)
              throw new Error('Initialization segment exceeds the 32 MiB processing limit');
            init = await file.arrayBuffer();
          } else
            init = await fetchWithRetry(
              initUrl,
              controller.signal,
              {
                ...headersForFetch(keyHeaders, initUrl),
                ...(req.initRange ? { Range: `bytes=${req.initRange.start}-${req.initRange.end}` } : {}),
              },
              MAX_RETRIES,
              undefined,
              req.initRange,
              32 * 1024 * 1024,
            );
          if (!checkpointed) {
            await opfs.open(initName);
            opfs.append(initName, init);
          }
          await rememberCompletedInput(
            initName,
            source,
            await opfs.getFile(initName),
            controller.signal,
            jobKey,
            manifestHash,
          );
          opfs.append(opfsName, init);
        } finally {
          release();
          releaseConnection();
        }
      }
    }
    const fetchOne = async (
      i: number,
      signal: AbortSignal,
      onBytes?: (bytes: number) => void,
      onActivity?: (activity: 'receiving' | 'retrying') => void,
    ): Promise<ArrayBuffer> => {
      const spec: SegmentSpec = segments[i];
      await restoreCompletedInput(partNames[i]);
      const cached = await completedInputs.reuse(
        partNames[i],
        `${source}:${i}`,
        () => opfs.getFile(partNames[i]),
        signal,
      );
      if (cached !== undefined) {
        await workerCacheCommand({ operation: 'write', name: partNames[i], jobKey, patch: { size: cached } });
        await opfs.open(partNames[i], true);
        onBytes?.(cached);
        return new ArrayBuffer(0);
      }
      const release = await authorizeResource(jobKey, spec.url, keyHeaders);
      try {
        signal.throwIfAborted();
        const checkpointName = spec.keyInfo?.method === 'AES-128' ? `${partNames[i]}.wire` : partNames[i];
        const base = spec.range?.start ?? 0;
        const checkpointed = await checkpointSegment({
          name: checkpointName,
          jobKey,
          url: spec.url,
          identity: `${source}:${i}`,
          range: spec.range,
          signal,
          cache: workerCacheCommand,
          open: (start, end, signal, version) =>
            openAuthorizedResponse(jobKey, spec.url, keyHeaders, signal, 10 * 60_000, {
              Range: `bytes=${start}-${end}`,
              ...(version ? { 'If-Range': version } : {}),
            }),
          disk: {
            open: () => opfs.open(checkpointName, true),
            size: () => opfs.size(checkpointName),
            truncate: () => opfs.truncate(checkpointName, 0),
            io: {
              read: (at, length) => opfs.readAt(checkpointName, at - base, length),
              write: (at, bytes) => opfs.writeAt(checkpointName, at - base, bytes),
              flush: () => opfs.flush(checkpointName),
            },
          },
          progress: onBytes,
          activity: onActivity,
        });
        if (spec.keyInfo?.method === 'AES-128') {
          let data: ArrayBuffer;
          if (checkpointed) {
            const file = await opfs.getFile(checkpointName);
            if (file.size > 32 * 1024 * 1024) throw new Error('Encrypted segment exceeds the 32 MiB processing limit');
            data = await file.arrayBuffer();
          } else
            data = await fetchWithRetry(
              spec.url,
              signal,
              {
                ...headersForFetch(keyHeaders, spec.url),
                ...(spec.range ? { Range: `bytes=${spec.range.start}-${spec.range.end}` } : {}),
              },
              MAX_RETRIES,
              onBytes,
              spec.range,
              32 * 1024 * 1024,
            );
          const releaseKey = spec.keyInfo.uri
            ? await authorizeResource(jobKey, spec.keyInfo.uri, keyHeaders)
            : () => {};
          try {
            data = await decryptSegment(data, spec.keyInfo, spec.sequenceNumber, keyHeaders, signal).catch(cause => {
              if (signal.aborted) throw cause;
              throw new DownloadFailure('integrity', 'HLS segment decryption failed', { cause });
            });
          } finally {
            releaseKey();
          }
          await opfs.open(partNames[i]);
          opfs.append(partNames[i], data);
        } else if (!checkpointed) {
          const destination = partNames[i];
          const start = 0;
          const writer = new BufferedWriter((position, bytes) => opfs.writeAt(destination, position, bytes));
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            let request: Awaited<ReturnType<typeof openDownloadResponse>> | undefined;
            try {
              writer.discard();
              await opfs.open(destination);
              onBytes?.(0);
              request = await openAuthorizedResponse(
                jobKey,
                spec.url,
                keyHeaders,
                signal,
                10 * 60_000,
                spec.range ? { Range: `bytes=${spec.range.start}-${spec.range.end}` } : undefined,
              );
              const response = request.response;
              onActivity?.('receiving');
              if (!response.ok) {
                await response.body?.cancel();
                throw new HttpRequestError(response.status, spec.url);
              }
              if (spec.range) assertRangeResponse(response, spec.range);
              if (!response.body) throw new Error('No segment response body');
              const reader = response.body.getReader();
              let bytes = 0;
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  request.touch();
                  if (spec.range && bytes + value.byteLength > spec.range.end - spec.range.start + 1)
                    throw new RangeResponseError('HLS range body exceeds the requested interval');
                  writer.writeAt(start + bytes, value);
                  bytes += value.byteLength;
                  onBytes?.(bytes);
                }
              } finally {
                await reader.cancel();
              }
              assertCompleteResponse(response, bytes);
              if (spec.range) assertRangeResponse(response, spec.range, bytes);
              assertNonEmptyOutput(bytes);
              writer.flush();

              break;
            } catch (error) {
              writer.discard();
              const reason = request?.signal.aborted ? request.signal.reason : error;
              flowLog('hls.segment.retry', {
                jobKey,
                part: i,
                url: spec.url,
                attempt: attempt + 1,
                error: errorInfo(reason),
              });
              if (
                signal.aborted ||
                attempt === MAX_RETRIES - 1 ||
                reason instanceof RangeResponseError ||
                !retryableRequest(reason)
              )
                throw reason;
              onActivity?.('retrying');
              await waitForRetry(500 * 2 ** attempt, signal);
            } finally {
              request?.dispose();
            }
          }
        }
        await rememberCompletedInput(
          partNames[i],
          `${source}:${i}`,
          await opfs.getFile(partNames[i]),
          signal,
          jobKey,
          manifestHash,
        );
        if (checkpointName !== partNames[i]) await removeCachedFile(checkpointName);
        await opfs.open(partNames[i], true);
        return new ArrayBuffer(0);
      } finally {
        release();
      }
    };

    await parallelFetchToOpfs({
      jobId,
      opfsName,
      count: segments.length,
      fetchOne,
      stage,
      jobKey,
      signal: controller.signal,
      maxConcurrent: req.maxConnections,
      stagedPartName: index => partNames[index],
      retainStagedParts: true,
    });

    const totalBytes = opfs.size(opfsName);
    assertNonEmptyOutput(totalBytes);
    await opfs.close(opfsName);
    await rememberCompletedInput(
      opfsName,
      source,
      await opfs.getFile(opfsName),
      controller.signal,
      jobKey,
      manifestHash,
    );
    discardParts = true;
    terminal = { type: 'fetch-done', jobId, opfsName, totalBytes };
  } catch (err) {
    discardParts = failureKind(err) === 'integrity';
    if (discardParts) {
      completedInputs.remove(opfsName);
      await removeCachedFamily(opfsName);
    } else await opfs.close(opfsName);
    terminal = {
      type: 'error',
      jobId,
      error: err instanceof Error ? err.message : String(err),
      failureKind: failureKind(err),
      retryable: automaticallyRecoverable(err),
    };
  } finally {
    if (discardParts) await completedInputs.removeRelated(opfsName, name => removeCachedFile(name));
    const { records = [] } = await workerCacheCommand({ operation: 'list' });
    const checkpointed = new Set(
      records
        .filter(
          record =>
            record.jobKey === jobKey &&
            record.ranges &&
            (record.ranges.done.length || record.ranges.checkpoints?.length),
        )
        .map(record => record.name),
    );
    await Promise.all(
      [...partNames, initName, ...partNames.map(name => `${name}.wire`)].map(async name => {
        if (discardParts || (!completedInputs.has(name) && !checkpointed.has(name))) {
          completedInputs.remove(name);
          await removeCachedFile(name);
        } else await opfs.close(name);
      }),
    );
    unregisterAbort(jobKey, controller);
    if (terminal) post(terminal);
  }
};

const handleFetchRanges = async (req: FetchRangesRequest): Promise<void> => {
  const controller = new AbortController();
  registerAbort(req.jobKey, controller);
  const { jobId, jobKey, opfsName, url, ranges, stage, totalBytes: knownTotal, keyHeaders } = req;

  diagnosticFiles.set(jobId, opfsName);
  try {
    flowLog('worker.ranges.start', {
      url: safeUrl(url),
      jobKey: safeUrl(jobKey),
      rangeCount: ranges.length,
      totalBytes: knownTotal,
      headerNames: Object.keys(keyHeaders ?? {}),
    });
    const { record } = await workerCacheCommand({ operation: 'read', name: opfsName });
    if (record?.ranges && record.fingerprint && (await cacheFingerprint(record.ranges.source)) !== record.fingerprint)
      throw new DownloadFailure('integrity', 'Persisted range fingerprint does not match its identity');
    rangeResume.restore(opfsName, record?.ranges);
    await opfs.open(opfsName, true);
    const rangeSource = {
      url,
      resourceVersion: req.resourceVersion,
      weakEtag: req.weakEtag,
      validationMethod: req.validationMethod,
      totalBytes: knownTotal,
      ranges,
    };
    const io = {
      write: (at: number, bytes: Uint8Array) => {
        opfs.writeAt(opfsName, at, bytes);
      },
      read: (at: number, length: number) => opfs.readAt(opfsName, at, length),
      flush: () => opfs.flush(opfsName),
    };
    const open = (start: number, end: number, signal: AbortSignal) =>
      openAuthorizedResponse(jobKey, url, keyHeaders, signal, 24 * 60 * 60 * 1000, {
        Range: `bytes=${start}-${end}`,
        ...(req.resourceVersion ? { 'If-Range': req.resourceVersion } : {}),
      });
    const expected = {
      start: 0,
      end: knownTotal - 1,
      total: knownTotal,
      resourceVersion: req.resourceVersion,
      weakEtag: req.weakEtag,
      validationMethod: req.validationMethod,
    };
    let samplesValidated = false;
    const releaseValidation = await downloadConnections.acquire(jobKey, controller.signal);
    try {
      samplesValidated = await verifyRangeCache({
        record: record?.ranges,
        range: expected,
        io,
        open,
        signal: controller.signal,
      });
    } finally {
      releaseValidation();
    }
    const resumeChunks = rangeResume.begin(opfsName, rangeSource, opfs.size(opfsName), samplesValidated);
    if (!resumeChunks) opfs.truncate(opfsName, 0);
    else
      await workerCacheCommand({
        operation: 'write',
        name: opfsName,
        jobKey,
        patch: {
          size: opfs.size(opfsName),
          ranges: rangeResume.snapshot(opfsName),
          fingerprint: await cacheFingerprint(rangeResume.snapshot(opfsName)!.source),
        },
      });
    await opfs.reserve(opfsName, knownTotal);

    const fetchOne = (
      i: number,
      signal: AbortSignal,
      onBytes?: (downloaded: number) => void,
      onActivity?: (activity: 'receiving' | 'retrying') => void,
    ): Promise<ArrayBuffer> =>
      fetchCheckpointedRange({
        i,
        range: { ...expected, ...ranges[i] },
        checkpoint: rangeResume.snapshot(opfsName)?.checkpoints?.find(checkpoint => checkpoint.i === i),
        io,
        open,
        signal,
        retries: MAX_RETRIES,
        progress: onBytes,
        activity: onActivity,
        commit: async (checkpoint, done) => {
          rangeResume.checkpoint(opfsName, checkpoint);
          if (done)
            rangeResume.completed(opfsName, { i, ...ranges[i], downloaded: checkpoint.downloaded, status: 'done' });
          const current = rangeResume.snapshot(opfsName)!;
          await workerCacheCommand({
            operation: 'write',
            name: opfsName,
            jobKey,
            patch: { size: opfs.size(opfsName), ranges: current, fingerprint: await cacheFingerprint(current.source) },
          });
        },
      });

    await parallelFetchToOpfs({
      jobId,
      opfsName,
      count: ranges.length,
      fetchOne,
      stage,
      jobKey,
      signal: controller.signal,
      totalEstimatedBytes: knownTotal,
      chunkMeta: ranges,
      resumeChunks,
      maxConcurrent: req.maxConnections,
    });

    if (req.validationMethod && req.validationMethod !== 'etag') {
      post({
        type: 'progress',
        jobId,
        jobKey,
        stage,
        downloadedBytes: knownTotal,
        estimatedBytes: knownTotal,
        activity: 'verifying',
      });
      const release = await downloadConnections.acquire(jobKey, controller.signal);
      try {
        await verifyRangeCache({
          record: rangeResume.snapshot(opfsName),
          range: expected,
          io,
          open,
          signal: controller.signal,
        });
      } finally {
        release();
      }
    }
    const totalBytes = opfs.size(opfsName);
    if (totalBytes !== knownTotal)
      throw new DownloadFailure(
        'integrity',
        `Range output length mismatch: expected ${knownTotal}, received ${totalBytes}`,
      );
    assertNonEmptyOutput(totalBytes);
    await opfs.close(opfsName);
    post({ type: 'fetch-done', jobId, opfsName, totalBytes });
    flowLog('worker.ranges.done', { url: safeUrl(url), totalBytes });
  } catch (err) {
    flowLog('worker.ranges.failed', { url: safeUrl(url), error: errorInfo(err) });
    if (failureKind(err) === 'integrity') {
      rangeResume.remove(opfsName);
      await removeCachedFamily(opfsName);
    } else {
      // Completed chunks have already been flushed and recorded. Partial
      // chunks remain untrusted and are overwritten by the next attempt.
      await opfs.close(opfsName);
    }
    post({
      type: 'error',
      jobId,
      error: err instanceof Error ? err.message : String(err),
      failureKind: failureKind(err),
      retryable: automaticallyRecoverable(err),
    });
  } finally {
    unregisterAbort(jobKey, controller);
  }
};

const PROGRESS_POLL_MS = 250;

const handleMux = async (req: MuxRequest): Promise<void> => {
  const log = createLogger('mux');
  const { jobId, jobKey, outputOpfsName, plan, input, stage, durationSeconds, estimatedBytes } = req;
  diagnosticFiles.set(jobId, outputOpfsName);
  const ffmpegArgs = buildMediaProcessingArgs(plan, input, outputOpfsName);
  const controller = new AbortController();
  registerAbort(jobKey, controller);

  let releaseMux: (() => void) | undefined;
  let libav: Awaited<ReturnType<typeof createLibAV>> | null = null;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let stalledTimer: ReturnType<typeof setInterval> | undefined;

  const onAbort = (): void => {
    // libav.terminate() rejects the in-flight ffmpeg() promise on the next tick.
    try {
      libav?.terminate();
    } catch {
      /* ignore */
    }
  };
  controller.signal.addEventListener('abort', onAbort);

  try {
    post({ type: 'progress', jobId, jobKey, stage, downloadedBytes: 0, estimatedBytes, activity: 'waiting-mux' });
    releaseMux = await mergeSlots.acquire(jobKey, controller.signal);
    controller.signal.throwIfAborted();
    log.debug('starting', {
      planType: plan.type,
      inputCount: input.urls.length,
      inputFormat: input.formatHint ?? 'auto',
      outputContainer: plan.output.container,
    });
    libav = await createLibAV();
    controller.signal.throwIfAborted();
    log.debug('libav.created');
    await opfs.reserve(outputOpfsName, estimatedBytes ?? 0);
    await registerOutputDevice(libav, outputOpfsName);
    await registerJsfetch(libav, {});
    controller.signal.throwIfAborted();
    log.debug('ffmpeg.invoking');

    // Emit one mux-stage event immediately so the UI flips off the stale
    // download-audio 100% and into the indeterminate "Processing…" state. The
    // per-tick poll below only fires when ffmpeg_get_out_time_ms is available
    // in the build; without it this is the only progress event the UI gets
    // during mux.
    post({
      type: 'progress',
      jobId,
      jobKey,
      stage,
      downloadedBytes: 0,
      estimatedBytes,
      muxPercent: undefined,
    });

    // MP3 transcode has output_size << input_size, so any size-ratio estimate
    // is misleading there — keep the indeterminate "Processing…" for MP3.
    // Stream-copy mux (.mp4 etc.) produces output ≈ input, so OPFS file size
    // is a reliable proxy.
    const isMp3Transcode = outputOpfsName.endsWith('.mp3');
    let lastOutputAt = Date.now();
    let previousWrites = 0;
    stalledTimer = setInterval(() => {
      const writes = opfs.stats(outputOpfsName)?.bytesWritten ?? 0;
      if (writes !== previousWrites) {
        previousWrites = writes;
        lastOutputAt = Date.now();
      } else if (Date.now() - lastOutputAt >= 120_000)
        controller.abort(new Error('Media processing stalled: no output for 120 seconds'));
    }, 1000);

    pollHandle = setInterval(() => {
      (async () => {
        try {
          if (!libav) return;
          // libav.ffmpeg_get_out_time_ms / get_total_size_bytes are an
          // extension some libav.js builds carry; the vendored web-media-remux-cli
          // build doesn't expose them. We try those first, then fall back to
          // the OPFS output file size (which the custom output device writes
          // to as the mux runs) for stream-copy.
          const getOutTime = libav.ffmpeg_get_out_time_ms as (() => Promise<number>) | undefined;
          const getTotalBytes = libav.ffmpeg_get_total_size_bytes as (() => Promise<number>) | undefined;
          const hasLibavProgress = typeof getOutTime === 'function' && typeof getTotalBytes === 'function';

          let outTimeMs = 0;
          let totalBytes = 0;
          if (hasLibavProgress) {
            outTimeMs = await getOutTime!.call(libav);
            totalBytes = await getTotalBytes!.call(libav);
          } else {
            totalBytes = opfs.size(outputOpfsName);
          }

          let muxPercent: number | undefined;
          if (durationSeconds && durationSeconds > 0 && outTimeMs > 0) {
            muxPercent = Math.min(99, Math.round((outTimeMs / 1000 / durationSeconds) * 100));
          } else if (!isMp3Transcode && estimatedBytes && estimatedBytes > 0 && totalBytes > 0) {
            muxPercent = Math.min(99, Math.round((totalBytes / estimatedBytes) * 100));
          }

          // Skip the post if we have nothing useful to report (avoid spamming
          // the storage with 0/undefined updates that overwrite a prior value).
          if (muxPercent === undefined && totalBytes === 0) return;

          post({
            type: 'progress',
            jobId,
            jobKey,
            stage,
            downloadedBytes: totalBytes,
            estimatedBytes,
            muxPercent,
          });
        } catch (pollErr) {
          log.warn('poll_failed', {
            errorName: pollErr instanceof Error ? pollErr.name : 'UnknownError',
          });
        }
      })();
    }, PROGRESS_POLL_MS);

    const rc = await libav.ffmpeg(...ffmpegArgs);
    log.debug('ffmpeg.returned', { rc });
    assertSuccessfulMux(rc);

    // ffmpeg() returned — tear down poll, close OPFS, report size.
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;

    flushOutputDevice(libav);
    const totalBytes = opfs.size(outputOpfsName);
    assertNonEmptyOutput(totalBytes);
    await opfs.close(outputOpfsName);
    log.debug('completed', { totalBytes });
    post({ type: 'mux-done', jobId, outputOpfsName, totalBytes });
  } catch (err) {
    const reason = controller.signal.aborted ? controller.signal.reason : err;
    flowLog('mux.failed', { key: jobKey, error: errorInfo(reason) });
    log.error('failed', { error: reason });
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
    try {
      await removeCachedFile(outputOpfsName);
    } catch {
      /* ignore */
    }
    post({
      type: 'error',
      jobId,
      error: reason instanceof Error ? reason.message : String(reason),
      failureKind: failureKind(reason, 'processing'),
    });
  } finally {
    clearInterval(stalledTimer);
    releaseMux?.();
    controller.signal.removeEventListener('abort', onAbort);
    if (pollHandle) clearInterval(pollHandle);
    try {
      libav?.terminate();
    } catch {
      /* already torn down */
    }
    unregisterAbort(jobKey, controller);
  }
};

const handleFetchUrl = async (req: FetchUrlRequest): Promise<void> => {
  const controller = new AbortController();
  registerAbort(req.jobKey, controller);
  const { jobId, jobKey, opfsName, url, stage, keyHeaders } = req;
  let request: Awaited<ReturnType<typeof openDownloadResponse>> | undefined;
  let releaseConnection: (() => void) | undefined;
  const writer = new BufferedWriter((position, bytes) => opfs.writeAt(opfsName, position, bytes));

  diagnosticFiles.set(jobId, opfsName);
  try {
    flowLog('worker.stream.start', {
      url: safeUrl(url),
      jobKey: safeUrl(jobKey),
      headerNames: Object.keys(keyHeaders ?? {}),
    });
    await opfs.open(opfsName);
    releaseConnection = await downloadConnections.acquire(jobKey, controller.signal);
    request = await openAuthorizedResponse(jobKey, url, keyHeaders, controller.signal);
    const res = request.response;
    assertSuccessfulResponse(res);
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    let downloaded = 0;
    const estimatedBytes = expectedResponseBytes(res);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (controller.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      request.touch();
      writer.writeAt(downloaded, value);
      downloaded += value.byteLength;
      post({ type: 'progress', jobId, jobKey, stage, downloadedBytes: downloaded, estimatedBytes });
    }

    assertCompleteResponse(res, downloaded);
    assertNonEmptyOutput(downloaded);
    writer.flush();
    await opfs.close(opfsName);
    post({ type: 'fetch-done', jobId, opfsName, totalBytes: downloaded });
    flowLog('worker.stream.done', { url: safeUrl(url), totalBytes: downloaded });
  } catch (err) {
    flowLog('worker.stream.failed', { url: safeUrl(url), error: errorInfo(err) });
    const reason = request?.signal.aborted
      ? request.signal.reason
      : controller.signal.aborted
        ? controller.signal.reason
        : err;
    if (failureKind(reason) === 'integrity') await removeCachedFile(opfsName);
    else {
      writer.discard();
      await opfs.close(opfsName);
    }
    const message = reason instanceof Error ? reason.message : String(reason);
    post({
      type: 'error',
      jobId,
      error: `Stream restart required: this source has no byte-offset checkpoint. Retry will download again. ${message}`,
      failureKind: failureKind(reason),
      retryable: automaticallyRecoverable(reason),
    });
  } finally {
    request?.dispose();
    releaseConnection?.();
    writer.discard();
    unregisterAbort(jobKey, controller);
  }
};

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  switch (req.type) {
    case 'cache-response':
      receiveCacheResponse(req.cacheId, req.response);
      return;
    case 'url-authorized': {
      const pending = pendingAuthorization.get(req.authorizationId);
      pendingAuthorization.delete(req.authorizationId);
      if (req.error) pending?.reject(new Error(req.error));
      else pending?.resolve({ key: req.downloadKey, url: req.url ?? '' });
      return;
    }
    case 'ping':
      post({ type: 'pong' });
      return;

    case 'remove':
      rangeResume.remove(req.opfsName);
      completedInputs.remove(req.opfsName);
      try {
        await completedInputs.removeRelated(req.opfsName, name => removeCachedFile(name));
        await removeCachedFamily(req.opfsName);
        post({ type: 'remove-done', jobId: req.jobId });
      } catch (err) {
        post({ type: 'error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
      }
      return;

    case 'adopt-http-source': {
      const controller = new AbortController();
      registerAbort(req.jobKey, controller);
      try {
        const { record } = await workerCacheCommand({ operation: 'read', name: req.opfsName });
        if (!record?.ranges || record.jobKey !== req.jobKey)
          throw new DownloadFailure('integrity', 'Renewed source has no verifiable Range checkpoint');
        const old = record.ranges.source,
          fresh = req.source;
        if (
          old.totalBytes !== fresh.totalBytes ||
          old.resourceVersion !== fresh.resourceVersion ||
          old.weakEtag !== fresh.weakEtag ||
          (old.validationMethod ?? 'etag') !== (fresh.validationMethod ?? 'etag')
        )
          throw new DownloadFailure('integrity', 'Renewed source validator or length changed');
        if (record.complete) {
          const registry = new CompletedInputRegistry();
          registry.restore(req.opfsName, record.complete);
          await registry.reuse(
            req.opfsName,
            record.complete.source,
            () => opfs.getFile(req.opfsName),
            controller.signal,
          );
        }
        rangeResume.restore(req.opfsName, record.ranges);
        await opfs.open(req.opfsName, true);
        const release = await downloadConnections.acquire(req.jobKey, controller.signal);
        try {
          await verifyRangeCache({
            record: record.ranges,
            range: {
              start: 0,
              end: fresh.totalBytes - 1,
              total: fresh.totalBytes,
              resourceVersion: fresh.resourceVersion,
              weakEtag: fresh.weakEtag,
              validationMethod: fresh.validationMethod === 'last-modified' ? 'last-modified' : 'boundary-sample',
            },
            io: {
              read: (at, length) => opfs.readAt(req.opfsName, at, length),
              write: () => {
                throw new Error('Source validation cannot write payload');
              },
              flush: () => {},
            },
            open: (start, end, signal) =>
              openAuthorizedResponse(req.jobKey, fresh.url, req.headers, signal, 24 * 60 * 60 * 1000, {
                Range: `bytes=${start}-${end}`,
                ...(fresh.resourceVersion ? { 'If-Range': fresh.resourceVersion } : {}),
              }),
            signal: controller.signal,
          });
        } finally {
          release();
        }
        controller.signal.throwIfAborted();
        const ranges = { ...record.ranges, source: { ...old, url: fresh.url } };
        await workerCacheCommand({
          operation: 'write',
          name: req.opfsName,
          jobKey: req.jobKey,
          patch: {
            size: record.size,
            ranges,
            fingerprint: await cacheFingerprint(ranges.source),
            ...(record.complete
              ? { complete: { ...record.complete, source: canonicalHttpSource(fresh.url, req.headers) } }
              : {}),
          },
        });
        completedInputs.remove(req.opfsName);
        rangeResume.remove(req.opfsName);
        post({ type: 'remove-done', jobId: req.jobId });
      } catch (error) {
        post({
          type: 'error',
          jobId: req.jobId,
          error: error instanceof Error ? error.message : String(error),
          failureKind: failureKind(error),
          retryable: false,
        });
      } finally {
        await opfs.close(req.opfsName);
        unregisterAbort(req.jobKey, controller);
      }
      return;
    }

    case 'persist-artifact':
    case 'restore-artifact': {
      const controller = new AbortController();
      registerAbort(req.jobKey, controller);
      try {
        if (req.type === 'persist-artifact') {
          await persistArtifact(
            req.jobKey,
            req.artifact,
            {
              read: name => opfs.getFile(name),
              cache: workerCacheCommand,
            },
            controller.signal,
          );
          post({ type: 'remove-done', jobId: req.jobId });
        } else {
          const file = await restoreArtifact(
            req.jobKey,
            req.opfsName,
            {
              read: name => opfs.getFile(name),
              cache: workerCacheCommand,
            },
            controller.signal,
          );
          post({ type: 'get-file-done', jobId: req.jobId, file });
        }
      } catch (err) {
        if (req.type === 'restore-artifact' && failureKind(err) === 'integrity') await removeCachedFamily(req.opfsName);
        post({
          type: 'error',
          jobId: req.jobId,
          error: err instanceof Error ? err.message : String(err),
          failureKind: failureKind(err),
          retryable: false,
        });
      } finally {
        unregisterAbort(req.jobKey, controller);
      }
      return;
    }

    case 'get-file':
      try {
        const file = await opfs.getFile(req.opfsName);
        post({ type: 'get-file-done', jobId: req.jobId, file });
      } catch (err) {
        post({ type: 'error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
      }
      return;

    case 'write-bytes':
      try {
        await opfs.open(req.opfsName);
        opfs.append(req.opfsName, new Uint8Array(req.bytes));
        const file = await opfs.getFile(req.opfsName);
        post({ type: 'get-file-done', jobId: req.jobId, file });
      } catch (err) {
        try {
          await removeCachedFile(req.opfsName);
        } catch {
          /* ignore */
        }
        post({ type: 'error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
      }
      return;

    case 'cancel': {
      const controllers = activeAborts.get(req.jobKey);
      controllers?.forEach(controller => controller.abort());
      return;
    }

    case 'fetch-segments':
      void handleFetchSegments(req);
      return;

    case 'fetch-ranges':
      void handleFetchRanges(req);
      return;

    case 'fetch-url':
      void handleFetchUrl(req);
      return;

    case 'mux':
      void handleMux(req);
      return;

    default: {
      const _exhaustive: never = req;
      void _exhaustive;
    }
  }
});
