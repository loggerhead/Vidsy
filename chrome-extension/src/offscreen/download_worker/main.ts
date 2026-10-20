// Download worker — spawned from the offscreen document.
// Owns OPFS I/O so segment / range streams land on disk via FileSystemSyncAccessHandle
// without holding payloads in the JS heap. The main thread still drives ffmpeg.wasm
// and mounts OPFS Files via WORKERFS at mux time.

import { createLibAV, registerJsfetch, registerOutputDevice } from './libav';
import { opfs } from './opfs';
import { assertNonEmptyOutput, assertSuccessfulMux } from './output-validation';
import { RangeResumeRegistry } from './range-resume';
import {
  assertCompleteResponse,
  assertSuccessfulResponse,
  assertRangeResponse,
  RangeResponseError,
  expectedResponseBytes,
} from './response-validation';
import { errorInfo, flowLog, safeUrl } from '../lib/download-log';
import { decryptSegment } from '../lib/hls-crypto';
import { headersForFetch } from '../lib/hls-request';
import { buildMediaProcessingArgs } from '../lib/media-processing';
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
const MAX_RETRIES = 3;
const SEGMENT_TIMEOUT_MS = 30_000;

const post = (msg: WorkerResponse): void => {
  (self as unknown as Worker).postMessage(msg);
};
let authorizationCounter = 0;
const pendingAuthorization = new Map<string, { resolve: (key?: string) => void; reject: (error: Error) => void }>();
const authorizeResource = async (
  jobKey: string,
  url: string,
  headers?: Record<string, string>,
): Promise<() => void> => {
  if (!headers) return () => {};
  const authorizationId = `authorize-${++authorizationCounter}`;
  const downloadKey = await new Promise<string | undefined>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAuthorization.delete(authorizationId);
      reject(new Error('Request header authorization timed out'));
    }, 10_000);
    pendingAuthorization.set(authorizationId, {
      resolve: key => {
        clearTimeout(timeout);
        resolve(key);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    post({ type: 'authorize-url', authorizationId, jobKey, url });
  });
  return () => {
    if (downloadKey) post({ type: 'release-url', downloadKey, url });
  };
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
): Promise<ArrayBuffer> => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(SEGMENT_TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeoutSignal]);
      const res = await fetch(url, { signal: combined, credentials: 'include', headers: extraHeaders });
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
      // Fast path: no per-byte progress wanted — let fetch buffer the body
      // (slightly more efficient than streaming + concatenating manually).
      if (!onBytes && !maxBufferedBytes && !writeChunk) {
        const body = await res.arrayBuffer();
        assertCompleteResponse(res, body.byteLength);
        if (expectedRange) assertRangeResponse(res, expectedRange, body.byteLength);
        return body;
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
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
      flowLog('worker.fetch.retry', { url: safeUrl(url), attempt: attempt + 1, error: errorInfo(err) });
      if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      if (err instanceof RangeResponseError) throw err;
      if (attempt === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
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
  fetchOne: (i: number, signal: AbortSignal, onBytes?: (downloaded: number) => void) => Promise<ArrayBuffer>;
  stage: 'download-video' | 'download-audio';
  jobKey: string;
  signal: AbortSignal;
  totalEstimatedBytes?: number;
  chunkMeta?: Array<{ start: number; end: number }>;
  resumeChunks?: ChunkProgress[];
  maxConcurrent?: number;
  onChunkDone?: (chunk: ChunkProgress) => void;
  stagedPartName?: (index: number) => string;
}): Promise<void> => {
  const { jobId, opfsName, count, fetchOne, stage, jobKey, signal, totalEstimatedBytes, chunkMeta, resumeChunks } =
    args;
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
    return { i, start: m.start, end: m.end, downloaded: 0, status: 'pending' as const };
  });
  let completedCount = chunkStates?.filter(c => c.status === 'done').length ?? 0;

  const flushInOrder = (): void => {
    while (pending.has(nextToWrite)) {
      const buf = pending.get(nextToWrite)!;
      pending.delete(nextToWrite);
      if (typeof buf === 'string') {
        opfs.copyAppend(buf, opfsName);
        void opfs.remove(buf);
      } else opfs.append(opfsName, buf);
      nextToWrite++;
    }
  };

  const dispatchOne = async (index: number): Promise<void> => {
    // Skip chunks the resume hydration already marked done — their bytes are
    // already in OPFS from a previous run.
    if (chunkStates && chunkStates[index] && chunkStates[index].status === 'done') return;
    if (chunkStates && chunkStates[index]) chunkStates[index].status = 'fetching';
    const onBytes = (downloaded: number): void => {
      if (chunkStates && chunkStates[index]) chunkStates[index].downloaded = downloaded;
    };
    try {
      const data = await fetchOne(index, fetchSignal, onBytes);
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
        args.onChunkDone?.(chunkStates[index]);
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
        : opfs.size(opfsName);
      const estimatedBytes =
        totalEstimatedBytes ?? (completedCount > 0 ? Math.round((fetchedBytes / completedCount) * count) : undefined);
      post({
        type: 'progress',
        jobId,
        jobKey,
        stage,
        downloadedBytes: fetchedBytes,
        estimatedBytes,
        chunks: chunkStates ? chunkStates.map(c => ({ ...c })) : undefined,
      });
    } catch (err) {
      if (chunkStates && chunkStates[index]) chunkStates[index].status = 'error';
      errors.push(err instanceof Error ? err : new Error(String(err)));
      siblings.abort();
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
      : opfs.size(opfsName);
    const estBytes =
      totalEstimatedBytes ?? (completedCount > 0 ? Math.round((fetchedBytes / completedCount) * count) : undefined);
    post({
      type: 'progress',
      jobId,
      jobKey,
      stage,
      downloadedBytes: fetchedBytes,
      estimatedBytes: estBytes,
      chunks: chunkStates ? chunkStates.map(c => ({ ...c })) : undefined,
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
  if (errors.length > 0) throw new Error(`Failed ${errors.length} parts: ${errors[0].message}`);
  flushInOrder();
  // One final snapshot so the UI sees the post-flush state immediately.
  postSnapshot();
};

const handleFetchSegments = async (req: FetchSegmentsRequest): Promise<void> => {
  const controller = new AbortController();
  registerAbort(req.jobKey, controller);
  const { jobId, jobKey, opfsName, segments, initUrl, keyHeaders, stage } = req;
  const partNames = segments.map((_, index) => `${opfsName}.part-${index}`);

  try {
    await opfs.open(opfsName);

    if (initUrl) {
      const release = await authorizeResource(jobKey, initUrl, keyHeaders);
      try {
        const init = await fetchWithRetry(
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
        opfs.append(opfsName, init);
      } finally {
        release();
      }
    }

    const fetchOne = async (i: number, signal: AbortSignal): Promise<ArrayBuffer> => {
      const spec: SegmentSpec = segments[i];
      const release = await authorizeResource(jobKey, spec.url, keyHeaders);
      try {
        signal.throwIfAborted();
        if (spec.keyInfo?.method === 'AES-128') {
          let data = await fetchWithRetry(
            spec.url,
            signal,
            {
              ...headersForFetch(keyHeaders, spec.url),
              ...(spec.range ? { Range: `bytes=${spec.range.start}-${spec.range.end}` } : {}),
            },
            MAX_RETRIES,
            undefined,
            spec.range,
            32 * 1024 * 1024,
          );
          const releaseKey = spec.keyInfo.uri
            ? await authorizeResource(jobKey, spec.keyInfo.uri, keyHeaders)
            : () => {};
          try {
            data = await decryptSegment(data, spec.keyInfo, spec.sequenceNumber, keyHeaders, signal);
          } finally {
            releaseKey();
          }
          await opfs.open(partNames[i]);
          opfs.append(partNames[i], data);
        } else {
          // Stage out-of-order parts on disk, not in a JS Map of media buffers.
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
              await opfs.open(partNames[i]);
              const response = await fetch(spec.url, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(SEGMENT_TIMEOUT_MS)]),
                credentials: 'include',
                headers: {
                  ...headersForFetch(keyHeaders, spec.url),
                  ...(spec.range ? { Range: `bytes=${spec.range.start}-${spec.range.end}` } : {}),
                },
              });
              try {
                assertSuccessfulResponse(response);
                if (spec.range) assertRangeResponse(response, spec.range);
              } catch (error) {
                await response.body?.cancel();
                throw error;
              }
              if (!response.body) throw new Error('No segment response body');
              const reader = response.body.getReader();
              let bytes = 0;
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (spec.range && bytes + value.byteLength > spec.range.end - spec.range.start + 1) {
                  await reader.cancel();
                  throw new RangeResponseError('HLS range body exceeds the requested interval');
                }
                opfs.append(partNames[i], value);
                bytes += value.byteLength;
              }
              assertCompleteResponse(response, bytes);
              if (spec.range) assertRangeResponse(response, spec.range, bytes);
              assertNonEmptyOutput(bytes);
              break;
            } catch (error) {
              if (signal.aborted || attempt === MAX_RETRIES - 1) throw error;
            }
          }
        }
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
      stagedPartName: index => partNames[index],
    });

    const totalBytes = opfs.size(opfsName);
    assertNonEmptyOutput(totalBytes);
    await opfs.close(opfsName);
    post({ type: 'fetch-done', jobId, opfsName, totalBytes });
  } catch (err) {
    try {
      await opfs.remove(opfsName);
    } catch {
      /* ignore */
    }
    post({ type: 'error', jobId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    await Promise.all(partNames.map(name => opfs.remove(name)));
    unregisterAbort(jobKey, controller);
  }
};

const handleFetchRanges = async (req: FetchRangesRequest): Promise<void> => {
  const controller = new AbortController();
  registerAbort(req.jobKey, controller);
  const { jobId, jobKey, opfsName, url, ranges, stage, totalBytes: knownTotal, keyHeaders } = req;

  try {
    flowLog('worker.ranges.start', {
      url: safeUrl(url),
      jobKey: safeUrl(jobKey),
      rangeCount: ranges.length,
      totalBytes: knownTotal,
      headerNames: Object.keys(keyHeaders ?? {}),
    });
    await opfs.open(opfsName, true);
    const resumeChunks = rangeResume.begin(
      opfsName,
      { url, resourceVersion: req.resourceVersion, totalBytes: knownTotal, ranges },
      opfs.size(opfsName),
    );
    if (!resumeChunks) opfs.truncate(opfsName, 0);

    const fetchOne = (i: number, signal: AbortSignal, onBytes?: (downloaded: number) => void): Promise<ArrayBuffer> => {
      const { start, end } = ranges[i];
      return fetchWithRetry(
        url,
        signal,
        {
          ...headersForFetch(keyHeaders, url),
          Range: `bytes=${start}-${end}`,
          ...(req.resourceVersion ? { 'If-Range': req.resourceVersion } : {}),
        },
        MAX_RETRIES,
        onBytes,
        { start, end, total: knownTotal, resourceVersion: req.resourceVersion },
        undefined,
        (chunk, offset) => {
          opfs.writeAt(opfsName, start + offset, chunk);
        },
      );
    };

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
      onChunkDone: chunk => rangeResume.completed(opfsName, chunk),
    });

    const totalBytes = opfs.size(opfsName);
    if (totalBytes !== knownTotal)
      throw new Error(`Range output length mismatch: expected ${knownTotal}, received ${totalBytes}`);
    assertNonEmptyOutput(totalBytes);
    await opfs.close(opfsName);
    post({ type: 'fetch-done', jobId, opfsName, totalBytes });
    flowLog('worker.ranges.done', { url: safeUrl(url), totalBytes });
  } catch (err) {
    flowLog('worker.ranges.failed', { url: safeUrl(url), error: errorInfo(err) });
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    // Pause = abort. Keep the OPFS file so the next start can resume from
    // the chunks already on disk. Real failure = remove the partial file
    // (otherwise corrupted bytes would leak into future resume attempts).
    if (!isAbort) {
      rangeResume.remove(opfsName);
      try {
        await opfs.remove(opfsName);
      } catch {
        /* ignore */
      }
    }
    post({ type: 'error', jobId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    unregisterAbort(jobKey, controller);
  }
};

const PROGRESS_POLL_MS = 250;

const handleMux = async (req: MuxRequest): Promise<void> => {
  const log = createLogger('mux');
  const { jobId, jobKey, outputOpfsName, plan, input, stage, durationSeconds, estimatedBytes } = req;
  const ffmpegArgs = buildMediaProcessingArgs(plan, input, outputOpfsName);
  const controller = new AbortController();
  registerAbort(jobKey, controller);

  let libav: Awaited<ReturnType<typeof createLibAV>> | null = null;
  let pollHandle: ReturnType<typeof setInterval> | null = null;

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
    log.debug('starting', {
      planType: plan.type,
      inputCount: input.urls.length,
      inputFormat: input.formatHint ?? 'auto',
      outputContainer: plan.output.container,
    });
    libav = await createLibAV();
    controller.signal.throwIfAborted();
    log.debug('libav.created');
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

    const totalBytes = opfs.size(outputOpfsName);
    assertNonEmptyOutput(totalBytes);
    await opfs.close(outputOpfsName);
    log.debug('completed', { totalBytes });
    post({ type: 'mux-done', jobId, outputOpfsName, totalBytes });
  } catch (err) {
    log.error('failed', { error: err });
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
    try {
      await opfs.remove(outputOpfsName);
    } catch {
      /* ignore */
    }
    post({ type: 'error', jobId, error: err instanceof Error ? err.message : String(err) });
  } finally {
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

  try {
    flowLog('worker.stream.start', {
      url: safeUrl(url),
      jobKey: safeUrl(jobKey),
      headerNames: Object.keys(keyHeaders ?? {}),
    });
    await opfs.open(opfsName);
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: 'include',
      headers: headersForFetch(keyHeaders, url),
    });
    assertSuccessfulResponse(res);
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    let downloaded = 0;
    const estimatedBytes = expectedResponseBytes(res);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (controller.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      opfs.append(opfsName, value);
      downloaded += value.byteLength;
      post({ type: 'progress', jobId, jobKey, stage, downloadedBytes: downloaded, estimatedBytes });
    }

    assertCompleteResponse(res, downloaded);
    assertNonEmptyOutput(downloaded);
    await opfs.close(opfsName);
    post({ type: 'fetch-done', jobId, opfsName, totalBytes: downloaded });
    flowLog('worker.stream.done', { url: safeUrl(url), totalBytes: downloaded });
  } catch (err) {
    flowLog('worker.stream.failed', { url: safeUrl(url), error: errorInfo(err) });
    try {
      await opfs.remove(opfsName);
    } catch {
      /* ignore */
    }
    post({ type: 'error', jobId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    unregisterAbort(jobKey, controller);
  }
};

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  switch (req.type) {
    case 'url-authorized': {
      const pending = pendingAuthorization.get(req.authorizationId);
      pendingAuthorization.delete(req.authorizationId);
      if (req.error) pending?.reject(new Error(req.error));
      else pending?.resolve(req.downloadKey);
      return;
    }
    case 'ping':
      post({ type: 'pong' });
      return;

    case 'remove':
      rangeResume.remove(req.opfsName);
      try {
        await opfs.remove(req.opfsName);
        post({ type: 'remove-done', jobId: req.jobId });
      } catch (err) {
        post({ type: 'error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
      }
      return;

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
          await opfs.remove(req.opfsName);
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
