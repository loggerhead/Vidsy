import { BufferedWriter } from './buffered-writer';
import { RANGE_CHECKPOINT_BYTES } from './range-resume';
import { assertRangeResponse, assertCompleteResponse, RangeResponseError } from './response-validation';
import { DownloadFailure } from '../lib/download-failure';
import { HttpRequestError, retryableRequest, waitForRetry } from '../lib/network-request';
import type { RangeCheckpoint, RangeResumeRecord } from './range-resume';
import type { ExpectedRange } from './response-validation';
import type { openDownloadResponse } from '../lib/network-request';

type RangeIo = {
  write: (at: number, bytes: Uint8Array) => void;
  read: (at: number, length: number) => Uint8Array;
  flush: () => void;
};
type RangeOpen = (start: number, end: number, signal: AbortSignal) => ReturnType<typeof openDownloadResponse>;
const digest = async (bytes: Uint8Array): Promise<string> => {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer));
  return [...hash].map(value => value.toString(16).padStart(2, '0')).join('');
};

export const verifyRangeCache = async (args: {
  record?: RangeResumeRecord;
  range: ExpectedRange;
  io: RangeIo;
  open: RangeOpen;
  signal: AbortSignal;
}): Promise<boolean> => {
  const { record, io, signal } = args;
  if (!record) return false;
  for (const chunk of record.done) {
    const proof = record.checkpoints?.find(checkpoint => checkpoint.i === chunk.i);
    if (!proof || proof.downloaded !== chunk.downloaded)
      throw new RangeResponseError(
        'Legacy completed range has no durable block checksums; an explained restart is required',
      );
  }
  for (const checkpoint of record.checkpoints ?? []) {
    for (let offset = 0, block = 0; offset < checkpoint.downloaded; offset += RANGE_CHECKPOINT_BYTES, block++) {
      signal.throwIfAborted();
      let bytes: Uint8Array;
      try {
        bytes = io.read(checkpoint.start + offset, Math.min(RANGE_CHECKPOINT_BYTES, checkpoint.downloaded - offset));
      } catch {
        throw new RangeResponseError('Cached checkpoint file is unavailable or truncated');
      }
      if ((await digest(bytes)) !== checkpoint.hashes[block])
        throw new RangeResponseError('Cached checkpoint bytes changed');
    }
  }
  if (!args.range.validationMethod || args.range.validationMethod === 'etag') return false;
  const intervals = new Map(record.done.map(chunk => [chunk.i, { start: chunk.start, end: chunk.end }]));
  for (const checkpoint of record.checkpoints ?? [])
    if (!intervals.has(checkpoint.i))
      intervals.set(checkpoint.i, { start: checkpoint.start, end: checkpoint.start + checkpoint.downloaded - 1 });
  for (const interval of intervals.values()) {
    const sampleBytes = Math.min(32 * 1024, interval.end - interval.start + 1);
    const samples = new Map([
      [interval.start, { start: interval.start, end: interval.start + sampleBytes - 1 }],
      [interval.end - sampleBytes + 1, { start: interval.end - sampleBytes + 1, end: interval.end }],
    ]);
    for (const sample of samples.values()) {
      signal.throwIfAborted();
      const request = await args.open(sample.start, sample.end, signal);
      try {
        assertRangeResponse(request.response, { ...args.range, ...sample });
        if (!request.response.body) throw new RangeResponseError('Boundary sample has no response body');
        const bytes = new Uint8Array(sample.end - sample.start + 1);
        const reader = request.response.body.getReader();
        let count = 0;
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            request.touch();
            if (count + result.value.length > bytes.length)
              throw new RangeResponseError('Boundary sample exceeds its requested interval');
            bytes.set(result.value, count);
            count += result.value.length;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        assertRangeResponse(request.response, { ...args.range, ...sample }, count);
        const retained = io.read(sample.start, bytes.length);
        if (bytes.some((value, index) => value !== retained[index]))
          throw new RangeResponseError('Remote boundary sample does not match cached bytes');
      } finally {
        await request.response.body?.cancel().catch(() => undefined);
        request.dispose();
      }
    }
  }
  return intervals.size > 0;
};

export const fetchCheckpointedRange = async (args: {
  i: number;
  range: ExpectedRange;
  checkpoint?: RangeCheckpoint;
  io: RangeIo;
  open: RangeOpen;
  signal: AbortSignal;
  commit: (checkpoint: RangeCheckpoint, done: boolean) => Promise<void>;
  progress?: (bytes: number) => void;
  activity?: (activity: 'receiving' | 'retrying') => void;
  retries?: number;
}): Promise<ArrayBuffer> => {
  const { range, io, signal } = args;
  const size = range.end - range.start + 1;
  let prefix = args.checkpoint?.downloaded ?? 0;
  const hashes = [...(args.checkpoint?.hashes ?? [])];
  const commit = async (checkpoint: RangeCheckpoint, done: boolean) => {
    try {
      await args.commit(checkpoint, done);
    } catch (cause) {
      throw new DownloadFailure(
        'transport',
        'Checkpoint could not be persisted; valid cached progress is retained. Retry after storage recovers.',
        { cause },
        false,
      );
    }
  };
  if (prefix === size) return new ArrayBuffer(0);
  for (let attempt = 0; attempt < (args.retries ?? 3); attempt++) {
    signal.throwIfAborted();
    const writer = new BufferedWriter(io.write);
    const requestedStart = range.start + prefix;
    const requested = { ...range, start: requestedStart };
    let request: Awaited<ReturnType<RangeOpen>> | undefined;
    let received = prefix;
    try {
      request = await args.open(requestedStart, range.end, signal);
      if (!request.response.ok)
        throw new HttpRequestError(request.response.status, request.response.url || 'https://download.invalid/');
      assertRangeResponse(request.response, requested);
      if (!request.response.body) throw new RangeResponseError('Range response has no body');
      args.activity?.('receiving');
      args.progress?.(prefix);
      const reader = request.response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          request.touch();
          if (received + value.byteLength > size)
            throw new RangeResponseError('Range body exceeds its requested interval');
          let cursor = 0;
          while (cursor < value.length) {
            const length = Math.min(
              value.length - cursor,
              RANGE_CHECKPOINT_BYTES - (received % RANGE_CHECKPOINT_BYTES),
            );
            writer.writeAt(range.start + received, value.subarray(cursor, cursor + length));
            received += length;
            cursor += length;
            if (received % RANGE_CHECKPOINT_BYTES === 0 && received < size) {
              writer.flush();
              io.flush();
              hashes.push(await digest(io.read(range.start + prefix, received - prefix)));
              await commit(
                { i: args.i, start: range.start, end: range.end, downloaded: received, hashes: [...hashes] },
                false,
              );
              prefix = received;
            }
            args.progress?.(received);
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      assertCompleteResponse(request.response, received - (requestedStart - range.start));
      assertRangeResponse(request.response, requested, received - (requestedStart - range.start));
      writer.flush();
      io.flush();
      if (received > prefix) hashes.push(await digest(io.read(range.start + prefix, received - prefix)));
      await commit({ i: args.i, start: range.start, end: range.end, downloaded: received, hashes: [...hashes] }, true);
      return new ArrayBuffer(0);
    } catch (error) {
      writer.discard();
      const reason = request?.signal.aborted ? request.signal.reason : error;
      if (signal.aborted || !retryableRequest(reason) || attempt === (args.retries ?? 3) - 1) throw reason;
      args.activity?.('retrying');
      await waitForRetry(500 * 2 ** attempt, signal);
    } finally {
      await request?.response.body?.cancel().catch(() => undefined);
      request?.dispose();
    }
  }
  throw new Error('Range retries exhausted');
};

export type { RangeIo, RangeOpen };
