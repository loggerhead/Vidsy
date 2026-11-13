import { fetchCheckpointedRange, verifyRangeCache } from './range-fetch';
import { RANGE_CHECKPOINT_BYTES, RangeResumeRegistry } from './range-resume';
import { openDownloadResponse } from '../lib/network-request';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { RangeCheckpoint, RangeResumeRecord } from './range-resume';

const size = 3 * RANGE_CHECKPOINT_BYTES;
const data = Uint8Array.from({ length: size }, (_, index) => index % 251);
const ioFixture = () => {
  const bytes = new Uint8Array(size);
  let writes = 0,
    flushed = false,
    maxWrite = 0;
  return {
    bytes,
    get writes() {
      return writes;
    },
    get flushed() {
      return flushed;
    },
    get maxWrite() {
      return maxWrite;
    },
    io: {
      write: (at: number, value: Uint8Array) => {
        bytes.set(value, at);
        writes++;
        flushed = false;
        maxWrite = Math.max(maxWrite, at + value.length);
      },
      read: (at: number, length: number) => bytes.slice(at, at + length),
      flush: () => {
        flushed = true;
      },
    },
  };
};
const checkpoint = async (): Promise<RangeCheckpoint> => {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice(0, RANGE_CHECKPOINT_BYTES).buffer));
  return {
    i: 0,
    start: 0,
    end: size - 1,
    downloaded: RANGE_CHECKPOINT_BYTES,
    hashes: [[...hash].map(value => value.toString(16).padStart(2, '0')).join('')],
  };
};

test('legacy completed ranges without full durable checksum coverage cannot silently reuse bytes', async () => {
  const fixture = ioFixture();
  await assert.rejects(
    verifyRangeCache({
      record: {
        source: {
          url: 'https://fixture.test/video',
          totalBytes: size,
          ranges: [{ start: 0, end: size - 1 }],
          resourceVersion: '"v1"',
        },
        done: [{ i: 0, start: 0, end: size - 1, downloaded: size, status: 'done' }],
      },
      io: fixture.io,
      range: { start: 0, end: size - 1, total: size, resourceVersion: '"v1"' },
      open: async () => {
        throw new Error('Unverified legacy bytes must not dispatch payload');
      },
      signal: new AbortController().signal,
    }),
    /no durable block checksums/,
  );
});

test('a real reset after 1.5 MiB retries from the flushed 1 MiB checkpoint and reproduces every byte', async () => {
  const requests: { start: number; ifRange?: string }[] = [];
  let reset = true;
  const server = createServer((request, response) => {
    const [start, end] = request.headers.range!.slice(6).split('-').map(Number);
    requests.push({ start, ifRange: request.headers['if-range'] as string });
    response.writeHead(206, {
      etag: '"v1"',
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    let cursor = start;
    const fail = reset;
    reset = false;
    const timer = setInterval(() => {
      const next = Math.min(cursor + 64 * 1024, end + 1);
      response.write(data.subarray(cursor, next));
      cursor = next;
      if (fail && cursor >= 1.5 * RANGE_CHECKPOINT_BYTES) {
        clearInterval(timer);
        response.destroy();
      } else if (cursor > end) {
        clearInterval(timer);
        response.end();
      }
    }, 2);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/reset`;
  const fixture = ioFixture();
  const persisted: RangeCheckpoint[] = [];
  try {
    await fetchCheckpointedRange({
      i: 0,
      range: { start: 0, end: size - 1, total: size, resourceVersion: '"v1"', validationMethod: 'etag' },
      io: fixture.io,
      signal: new AbortController().signal,
      open: (start, end, signal) =>
        openDownloadResponse(url, { signal, headers: { Range: `bytes=${start}-${end}`, 'If-Range': '"v1"' } }),
      commit: async checkpoint => {
        assert.equal(fixture.flushed, true);
        persisted.push(structuredClone(checkpoint));
      },
    });
    assert.deepEqual(fixture.bytes, data);
    assert.deepEqual(requests, [
      { start: 0, ifRange: '"v1"' },
      { start: RANGE_CHECKPOINT_BYTES, ifRange: '"v1"' },
    ]);
    assert.ok(1.5 * RANGE_CHECKPOINT_BYTES - requests[1].start <= RANGE_CHECKPOINT_BYTES);
    assert.equal(persisted.at(-1)?.downloaded, size);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Last-Modified and validator-free resumes require successful remote boundary samples', async () => {
  for (const validationMethod of ['last-modified', 'boundary-sample'] as const) {
    const fixture = ioFixture();
    fixture.bytes.set(data);
    const cp = await checkpoint();
    const version = validationMethod === 'last-modified' ? 'Tue, 10 Nov 2026 08:00:00 GMT' : undefined;
    const record: RangeResumeRecord = {
      source: {
        url: 'https://fixture.test/video',
        totalBytes: size,
        ranges: [{ start: 0, end: size - 1 }],
        resourceVersion: version,
        validationMethod,
      },
      done: [],
      checkpoints: [cp],
    };
    const samples: number[] = [];
    const valid = await verifyRangeCache({
      record,
      io: fixture.io,
      signal: new AbortController().signal,
      range: { start: 0, end: size - 1, total: size, resourceVersion: version, validationMethod },
      open: (start, end, signal) =>
        openDownloadResponse(record.source.url, {
          signal,
          headers: { Range: `bytes=${start}-${end}`, ...(version ? { 'If-Range': version } : {}) },
          fetchImpl: async (_url, init) => {
            if (version) assert.equal(new Headers(init?.headers).get('if-range'), version);
            samples.push(end - start + 1);
            return new Response(data.slice(start, end + 1), {
              status: 206,
              headers: {
                'content-range': `bytes ${start}-${end}/${size}`,
                'content-length': String(end - start + 1),
                ...(version ? { 'last-modified': version } : {}),
              },
            });
          },
        }),
    });
    assert.equal(valid, true);
    assert.equal(samples.length, 2);
    assert.ok(samples.every(length => length <= 32 * 1024));
    const registry = new RangeResumeRegistry();
    registry.restore('input', record);
    assert.throws(() => registry.begin('input', record.source, size, false), /Range identity/);
    registry.restore('input', record);
    assert.equal(registry.begin('input', record.source, size, valid)?.[0].downloaded, RANGE_CHECKPOINT_BYTES);
  }
});

test('local mutation and remote sample mismatch reject retained bytes before any new write', async () => {
  for (const local of [true, false]) {
    const fixture = ioFixture();
    fixture.bytes.set(data);
    const record: RangeResumeRecord = {
      source: {
        url: 'https://fixture.test/video',
        totalBytes: size,
        ranges: [{ start: 0, end: size - 1 }],
        validationMethod: 'boundary-sample',
      },
      done: [],
      checkpoints: [await checkpoint()],
    };
    if (local) fixture.bytes[17] ^= 1;
    await assert.rejects(
      verifyRangeCache({
        record,
        io: fixture.io,
        signal: new AbortController().signal,
        range: { start: 0, end: size - 1, total: size, validationMethod: 'boundary-sample' },
        open: (start, end, signal) =>
          openDownloadResponse(record.source.url, {
            signal,
            fetchImpl: async () => {
              const bytes = data.slice(start, end + 1);
              bytes[0] ^= 1;
              return new Response(bytes, {
                status: 206,
                headers: { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(bytes.length) },
              });
            },
          }),
      }),
      /Cached checkpoint bytes changed|Remote boundary sample/,
    );
    assert.equal(fixture.writes, 0);
  }
});

test('checkpoint storage failure stops transfer at the first frame instead of fetching uncheckpointed payload', async () => {
  const fixture = ioFixture();
  let opens = 0;
  await assert.rejects(
    fetchCheckpointedRange({
      i: 0,
      range: { start: 0, end: size - 1, total: size, resourceVersion: '"v1"' },
      io: fixture.io,
      signal: new AbortController().signal,
      open: (_start, _end, signal) =>
        openDownloadResponse('https://fixture.test/video', {
          signal,
          fetchImpl: async () => {
            opens++;
            return new Response(data, {
              status: 206,
              headers: { etag: '"v1"', 'content-range': `bytes 0-${size - 1}/${size}`, 'content-length': String(size) },
            });
          },
        }),
      commit: async () => {
        throw new Error('storage unavailable');
      },
    }),
    /Checkpoint could not be persisted/,
  );
  assert.equal(opens, 1);
  assert.equal(fixture.maxWrite, RANGE_CHECKPOINT_BYTES);
});
