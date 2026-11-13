import { createDownloadCache } from '../../background/lib/download-cache';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { WorkerRequest, WorkerResponse } from './messages';

const files = new Map<string, Uint8Array>();
let ledger: unknown;
const cache = createDownloadCache({
  read: async () => ledger,
  write: async value => {
    ledger = value;
  },
});
const root = {
  getFileHandle: async (name: string) => {
    if (!files.has(name)) files.set(name, new Uint8Array());
    return {
      createSyncAccessHandle: async () => ({
        truncate(size: number) {
          const value = new Uint8Array(size);
          value.set(files.get(name)!.subarray(0, size));
          files.set(name, value);
        },
        getSize: () => files.get(name)!.length,
        write(buffer: Uint8Array, options: { at: number }) {
          const value = new Uint8Array(Math.max(files.get(name)!.length, options.at + buffer.length));
          value.set(files.get(name)!);
          value.set(buffer, options.at);
          files.set(name, value);
          return buffer.length;
        },
        read(buffer: Uint8Array, options: { at: number }) {
          const data = files.get(name)!.subarray(options.at, options.at + buffer.length);
          buffer.set(data);
          return data.length;
        },
        flush() {},
        close() {},
      }),
      getFile: async () => new File([new Uint8Array(files.get(name)!).buffer], name),
    };
  },
  removeEntry: async (name: string) => {
    files.delete(name);
  },
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { storage: { getDirectory: async () => root } },
});
let receive!: (event: { data: WorkerRequest }) => void;
const observers = new Set<(message: WorkerResponse) => void>();
Object.assign(globalThis, {
  self: {
    location: { href: 'https://extension.test/download-worker.js' },
    addEventListener: (_type: string, listener: typeof receive) => {
      receive = listener;
    },
    postMessage: (message: WorkerResponse) => {
      if (message.type === 'cache-request') {
        void cache
          .command(message.command)
          .then(response => receive({ data: { type: 'cache-response', cacheId: message.cacheId, response } }));
        return;
      }
      for (const observer of observers) observer(message);
    },
  },
});
await import('./main');
const run = (request: WorkerRequest & { jobId: string }): Promise<WorkerResponse> =>
  new Promise(resolve => {
    const observer = (message: WorkerResponse) => {
      if ('jobId' in message && message.jobId === request.jobId && ['error', 'fetch-done'].includes(message.type)) {
        observers.delete(observer);
        resolve(message);
      }
    };
    observers.add(observer);
    receive({ data: request });
  });
const rangeRequest = (jobId: string, name: string) => ({
  type: 'fetch-ranges' as const,
  jobId,
  jobKey: jobId,
  opfsName: name,
  url: 'https://source.test/video',
  ranges: [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
  ],
  totalBytes: 8,
  stage: 'download-video' as const,
  resourceVersion: '"v1"',
  maxConnections: 2,
});

test('local HTTP persistent 403 at 50% retains the first range and Retry fetches only the missing range', async () => {
  let fail = true;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const range = request.headers.range!;
    requests.push(range);
    if (range === 'bytes=4-7' && fail) {
      response.writeHead(403);
      response.end();
      return;
    }
    const offset = range === 'bytes=0-3' ? 0 : 4;
    response.writeHead(206, {
      'content-range': `bytes ${offset}-${offset + 3}/8`,
      etag: '"v1"',
      'content-length': '4',
    });
    response.end(Buffer.from([offset + 1, offset + 2, offset + 3, offset + 4]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = {
    ...rangeRequest('persistent-403', 'failed-range.bin'),
    maxConnections: 1,
    url: `http://127.0.0.1:${address.port}/video`,
  };
  try {
    const failed = await run(request);
    assert.ok(failed.type === 'error');
    assert.equal(failed.failureKind, 'transport');
    assert.match(failed.error, /403/);
    assert.deepEqual([...files.get(request.opfsName)!], [1, 2, 3, 4]);
    requests.length = 0;
    fail = false;
    assert.equal((await run({ ...request, jobId: 'retry-403' })).type, 'fetch-done');
    assert.deepEqual(requests, ['bytes=4-7']);
    assert.deepEqual([...files.get(request.opfsName)!], [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('segments retain atomic completed parts across failure and reuse the complete input without media requests', async () => {
  const original = fetch;
  let fail = true;
  const calls: string[] = [];
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === '/1' && fail) return new Response(null, { status: 403 });
    return new Response(new Uint8Array([path === '/0' ? 1 : 2]), { headers: { 'content-length': '1' } });
  };
  const request = {
    type: 'fetch-segments' as const,
    jobId: 'partial-segments',
    jobKey: 'partial-segments',
    opfsName: 'partial.ts',
    stage: 'download-video' as const,
    maxConnections: 1,
    manifestIdentity: '#EXTM3U\n#EXT-X-ENDLIST',
    segments: [0, 1].map(i => ({ url: `https://source.test/${i}`, sequenceNumber: i })),
  };
  try {
    assert.equal((await run(request)).type, 'error');
    assert.deepEqual([...files.get('partial.ts.part-0')!], [1]);
    assert.equal(files.has('partial.ts.part-1'), false, 'an incomplete part has no durable completion marker');
    fail = false;
    calls.length = 0;
    assert.equal((await run({ ...request, jobId: 'segments-retry' })).type, 'fetch-done');
    assert.ok(calls.length > 0 && calls.every(path => path === '/1'));
    assert.deepEqual([...files.get('partial.ts')!], [1, 2]);
    calls.length = 0;
    assert.equal((await run({ ...request, jobId: 'mux-input-retry' })).type, 'fetch-done');
    assert.deepEqual(calls, []);
    const changed = await run({ ...request, jobId: 'changed-manifest', manifestIdentity: '#EXTM3U\nchanged' });
    assert.ok(changed.type === 'error' && changed.failureKind === 'integrity');
    assert.equal(files.has('partial.ts'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('segment pause cleanup retains its acknowledged internal checkpoint and Retry appends from 1 MiB', async () => {
  const original = fetch;
  const payload = new Uint8Array(3 * 1024 * 1024).fill(37);
  const starts: number[] = [];
  let paused = false;
  globalThis.fetch = async (_url, init) => {
    const [start, end] = new Headers(init?.headers).get('range')!.slice(6).split('-').map(Number);
    starts.push(start);
    let cursor = start;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (init?.signal?.aborted) {
          stream.error(init.signal.reason);
          return;
        }
        const next = Math.min(cursor + 64 * 1024, end + 1);
        stream.enqueue(payload.slice(cursor, next));
        cursor = next;
        if (!paused && end - start > 1024 * 1024 && cursor >= 1.5 * 1024 * 1024) {
          paused = true;
          receive({ data: { type: 'cancel', jobKey: 'segment-paused' } });
        }
        if (cursor > end) stream.close();
      },
    });
    return new Response(body, {
      status: 206,
      headers: {
        etag: '"segment-v1"',
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': String(end - start + 1),
      },
    });
  };
  const request = {
    type: 'fetch-segments' as const,
    jobId: 'segment-paused',
    jobKey: 'segment-paused',
    opfsName: 'paused-segment.bin',
    stage: 'download-video' as const,
    segments: [{ url: 'https://source.test/large', sequenceNumber: 0 }],
  };
  try {
    assert.equal((await run(request)).type, 'error');
    const record = (await cache.command({ operation: 'read', name: 'paused-segment.bin.part-0' })).record!;
    assert.equal(record.ranges!.checkpoints![0].downloaded, 1024 * 1024);
    assert.ok(files.has(record.name));
    starts.length = 0;
    assert.equal((await run({ ...request, jobId: 'segment-retry' })).type, 'fetch-done');
    assert.deepEqual(starts, [0, 1024 * 1024]);
    assert.deepEqual(files.get(request.opfsName), payload);
  } finally {
    globalThis.fetch = original;
  }
});

test('AES-128 checkpoints ciphertext across a reset and publishes only complete decrypted plaintext', async () => {
  const original = fetch;
  const keyBytes = new Uint8Array(16).fill(11),
    iv = new Uint8Array(16).fill(7);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  const plaintext = new Uint8Array(2 * 1024 * 1024 + 17).fill(43);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext));
  const starts: number[] = [];
  let reset = true;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/key')) return new Response(keyBytes);
    const [start, end] = new Headers(init?.headers).get('range')!.slice(6).split('-').map(Number);
    starts.push(start);
    let cursor = start;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        const next = Math.min(cursor + 64 * 1024, end + 1);
        if (reset && end - start > 1024 * 1024 && cursor >= 1.5 * 1024 * 1024) {
          reset = false;
          stream.error(new TypeError('Connection reset'));
          return;
        }
        stream.enqueue(ciphertext.slice(cursor, next));
        cursor = next;
        if (cursor > end) stream.close();
      },
    });
    return new Response(body, {
      status: 206,
      headers: {
        etag: '"ciphertext-v1"',
        'content-range': `bytes ${start}-${end}/${ciphertext.length}`,
        'content-length': String(end - start + 1),
      },
    });
  };
  try {
    const result = await run({
      type: 'fetch-segments',
      jobId: 'encrypted-checkpoint',
      jobKey: 'encrypted-checkpoint',
      opfsName: 'encrypted.bin',
      stage: 'download-video',
      segments: [
        {
          url: 'https://source.test/ciphertext',
          sequenceNumber: 0,
          keyInfo: { method: 'AES-128', uri: 'https://source.test/key', iv },
        },
      ],
    });
    assert.equal(result.type, 'fetch-done');
    assert.deepEqual(starts, [0, 0, 1024 * 1024]);
    assert.deepEqual(files.get('encrypted.bin'), plaintext);
    assert.equal(files.has('encrypted.bin.part-0.wire'), false);
    assert.equal((await cache.command({ operation: 'read', name: 'encrypted.bin.part-0.wire' })).record, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('worker rejects an ignored Range before writing any bytes and aborts siblings', async () => {
  const original = fetch;
  let cancelled = false;
  globalThis.fetch = async (_url, init) => {
    if (new Headers(init?.headers).get('range') === 'bytes=0-3')
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-length': '8' } },
      );
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
        once: true,
      });
    });
  };
  try {
    const result = await run(rangeRequest('invalid-range', 'invalid.bin'));
    assert.equal(result.type, 'error');
    assert.equal(cancelled, true);
    assert.equal(files.has('invalid.bin'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('worker resumes only completed ranges from the retained file with the same strong ETag', async () => {
  const original = fetch;
  let holdSecond = true;
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const range = new Headers(init?.headers).get('range')!;
    calls.push(range);
    if (holdSecond && range === 'bytes=4-7')
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
          once: true,
        }),
      );
    const offset = range === 'bytes=0-3' ? 0 : 4;
    return new Response(new Uint8Array([offset + 1, offset + 2, offset + 3, offset + 4]), {
      status: 206,
      headers: { 'content-range': `bytes ${offset}-${offset + 3}/8`, etag: '"v1"', 'content-length': '4' },
    });
  };
  try {
    const request = rangeRequest('pause-range', 'resume.bin');
    const done = new Promise<void>(resolve => {
      const observer = (message: WorkerResponse) => {
        if (message.type === 'progress' && message.jobId === request.jobId && message.chunks?.[0].status === 'done') {
          observers.delete(observer);
          resolve();
        }
      };
      observers.add(observer);
    });
    const first = run(request);
    await done;
    receive({ data: { type: 'cancel', jobKey: request.jobKey } });
    assert.equal((await first).type, 'error');
    assert.equal(files.has('resume.bin'), true);
    holdSecond = false;
    calls.length = 0;
    assert.equal((await run({ ...request, jobId: 'resumed' })).type, 'fetch-done');
    assert.deepEqual(calls, ['bytes=4-7']);
    assert.deepEqual([...files.get('resume.bin')!], [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    globalThis.fetch = original;
  }
});

test('HLS dispatch applies backpressure and assembles staged parts in source order', async () => {
  const original = fetch;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const calls: number[] = [];
  globalThis.fetch = async url => {
    const index = Number(String(url).split('/').at(-1));
    calls.push(index);
    if (index === 0) await gate;
    return new Response(new Uint8Array([index]), { headers: { 'content-length': '1' } });
  };
  try {
    const pending = run({
      type: 'fetch-segments',
      jobId: 'hls-window',
      jobKey: 'hls-window',
      opfsName: 'segments.ts',
      stage: 'download-video',
      segments: Array.from({ length: 30 }, (_, index) => ({
        url: `https://source.test/${index}`,
        sequenceNumber: index,
      })),
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(
      [...new Set(calls)].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    release();
    assert.equal((await pending).type, 'fetch-done');
    assert.deepEqual(
      [...files.get('segments.ts')!],
      Array.from({ length: 30 }, (_, index) => index),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('worker rejects a bodyless or truncated range even when other parts reach the final file size', async () => {
  const original = fetch;
  try {
    for (const body of [null, new Uint8Array([1, 2])] as const) {
      globalThis.fetch = async (_url, init) => {
        const first = new Headers(init?.headers).get('range') === 'bytes=0-3';
        return new Response(first ? body : new Uint8Array([5, 6, 7, 8]), {
          status: 206,
          headers: { 'content-range': first ? 'bytes 0-3/8' : 'bytes 4-7/8', etag: '"v1"' },
        });
      };
      const name = body === null ? 'bodyless.bin' : 'truncated.bin';
      const result = await run(rangeRequest(name, name));
      assert.equal(result.type, 'error');
      assert.equal(files.has(name), false);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('HLS range parts validate their intervals and assemble only the requested bytes', async () => {
  const original = fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const range = new Headers(init?.headers).get('range')!;
    calls.push(range);
    const [start, end] = range.slice(6).split('-').map(Number);
    return new Response(new Uint8Array(Array.from({ length: end - start + 1 }, (_, i) => start + i + 1)), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/8` },
    });
  };
  try {
    assert.equal(
      (
        await run({
          type: 'fetch-segments',
          jobId: 'hls-ranges',
          jobKey: 'hls-ranges',
          opfsName: 'hls-ranges.mp4',
          stage: 'download-video',
          initUrl: 'https://source.test/one.mp4',
          initRange: { start: 0, end: 1 },
          segments: [
            { url: 'https://source.test/one.mp4', range: { start: 2, end: 4 }, sequenceNumber: 0 },
            { url: 'https://source.test/one.mp4', range: { start: 5, end: 7 }, sequenceNumber: 1 },
          ],
        })
      ).type,
      'fetch-done',
    );
    assert.deepEqual(
      calls.filter(range => !/^bytes=(0-0|2-2|5-5)$/.test(range)),
      ['bytes=0-1', 'bytes=2-4', 'bytes=5-7'],
    );
    assert.deepEqual([...files.get('hls-ranges.mp4')!], [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    globalThis.fetch = original;
  }
});

test('stream download fails after 30 seconds without response headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const original = fetch;
  let started!: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      started();
    });
  try {
    const result = run({
      type: 'fetch-url',
      jobId: 'idle-headers',
      jobKey: 'idle-headers',
      opfsName: 'idle-headers.bin',
      url: 'https://source.test/stalled',
      stage: 'download-audio',
    });
    await ready;
    t.mock.timers.tick(30_000);
    assert.deepEqual(await result, {
      type: 'error',
      jobId: 'idle-headers',
      error:
        'Stream restart required: this source has no byte-offset checkpoint. Retry will download again. Download stalled: no data for 30 seconds',
      failureKind: 'transport',
      retryable: true,
    });
    assert.equal(files.has('idle-headers.bin'), true);
  } finally {
    globalThis.fetch = original;
  }
});

test('stream idle timeout resets on received bytes and bounds a stalled response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const original = fetch;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let onProgress!: () => void;
  const waitForProgress = () =>
    new Promise<void>(resolve => {
      onProgress = resolve;
    });
  const observer = (message: WorkerResponse) => {
    if (message.type === 'progress' && message.jobId === 'idle-body') onProgress();
  };
  observers.add(observer);
  globalThis.fetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          stream = controller;
          init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
          controller.enqueue(new Uint8Array([1]));
        },
      }),
      { headers: { 'content-length': '3' } },
    );
  try {
    const firstByte = waitForProgress();
    const result = run({
      type: 'fetch-url',
      jobId: 'idle-body',
      jobKey: 'idle-body',
      opfsName: 'idle-body.bin',
      url: 'https://source.test/stalled',
      stage: 'download-audio',
    });
    await firstByte;
    t.mock.timers.tick(29_000);
    const nextByte = waitForProgress();
    stream.enqueue(new Uint8Array([2]));
    await nextByte;
    t.mock.timers.tick(29_000);
    assert.equal(files.has('idle-body.bin'), true);
    t.mock.timers.tick(1_000);
    assert.deepEqual(await result, {
      type: 'error',
      jobId: 'idle-body',
      error:
        'Stream restart required: this source has no byte-offset checkpoint. Retry will download again. Download stalled: no data for 30 seconds',
      failureKind: 'transport',
      retryable: true,
    });
    assert.equal(files.has('idle-body.bin'), true);
  } finally {
    globalThis.fetch = original;
    observers.delete(observer);
  }
});

test('three HLS jobs share eight data connections and preserve each file order', async () => {
  const original = fetch;
  let active = 0,
    peak = 0,
    release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  globalThis.fetch = async url => {
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
    const index = Number(new URL(String(url)).pathname.split('/').pop());
    return new Response(new Uint8Array([index]));
  };
  try {
    const jobs = ['a', 'b', 'c'].map(key =>
      run({
        type: 'fetch-segments',
        jobId: `budget-${key}`,
        jobKey: `budget-${key}`,
        opfsName: `budget-${key}.bin`,
        stage: 'download-video',
        maxConnections: 8,
        segments: Array.from({ length: 12 }, (_, i) => ({ url: `https://source.test/${key}/${i}`, sequenceNumber: i })),
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(active, 8);
    release();
    const results = await Promise.all(jobs);
    assert.equal(peak, 8);
    assert.ok(results.every(result => result.type === 'fetch-done'));
    for (const key of ['a', 'b', 'c'])
      assert.deepEqual(
        [...files.get(`budget-${key}.bin`)!],
        Array.from({ length: 12 }, (_, i) => i),
      );
  } finally {
    release();
    globalThis.fetch = original;
  }
});
