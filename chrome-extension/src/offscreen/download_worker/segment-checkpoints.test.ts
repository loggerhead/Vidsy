import { checkpointSegment } from './segment-checkpoints';
import { createDownloadCache } from '../../background/lib/download-cache';
import assert from 'node:assert/strict';
import test from 'node:test';

const block = 1024 * 1024;
const fixture = (mode: 'etag' | 'date' | 'none', base = 123) => {
  const payload = Uint8Array.from({ length: 2 * block + 17 }, (_, i) => i % 251);
  let ledger: unknown,
    local = new Uint8Array(),
    interrupt = true;
  const requests: { start: number; end: number; version?: string }[] = [];
  const cache = createDownloadCache({
    read: async () => ledger,
    write: async value => {
      ledger = value;
    },
  });
  const controller = new AbortController();
  const open = async (start: number, end: number, signal: AbortSignal, version?: string) => {
    requests.push({ start, end, version });
    let cursor = start;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (signal.aborted) {
          stream.error(signal.reason);
          return;
        }
        const next = Math.min(cursor + 64 * 1024, end + 1);
        stream.enqueue(payload.slice(cursor - base, next - base));
        cursor = next;
        if (interrupt && end - start > block && cursor - base >= 1.5 * block) {
          interrupt = false;
          controller.abort(new DOMException('Paused', 'AbortError'));
        }
        if (cursor > end) stream.close();
      },
    });
    return {
      response: new Response(body, {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${end}/${base + payload.length + 100}`,
          'content-length': String(end - start + 1),
          ...(mode === 'etag'
            ? { etag: '"v1"' }
            : mode === 'date'
              ? { 'last-modified': 'Tue, 10 Nov 2026 08:00:00 GMT' }
              : {}),
        },
      }),
      signal,
      touch: () => {},
      dispose: () => {},
    };
  };
  const args = {
    name: 'part',
    jobKey: 'job',
    url: 'https://source.test/segment',
    identity: 'manifest:video:7',
    range: { start: base, end: base + payload.length - 1 },
    signal: controller.signal,
    open,
    cache: cache.command,
    disk: {
      open: async () => {},
      size: () => local.length,
      truncate: () => {
        local = new Uint8Array();
      },
      io: {
        write: (at: number, bytes: Uint8Array) => {
          const next = new Uint8Array(Math.max(local.length, at - base + bytes.length));
          next.set(local);
          next.set(bytes, at - base);
          local = next;
        },
        read: (at: number, length: number) => local.slice(at - base, at - base + length),
        flush: () => {},
      },
    },
  };
  return {
    args,
    controller,
    requests,
    payload,
    get local() {
      return local;
    },
    mutate: () => {
      local[17] ^= 1;
    },
  };
};

for (const mode of ['etag', 'date', 'none'] as const) {
  test(`${mode} segment byte-range resumes at its internal 1 MiB checkpoint after a fresh worker`, async () => {
    const f = fixture(mode);
    await assert.rejects(checkpointSegment(f.args));
    const record = (await f.args.cache({ operation: 'read', name: 'part' })).record!;
    assert.equal(record.ranges!.checkpoints![0].downloaded, block);
    const before = f.requests.length;
    assert.equal(await checkpointSegment({ ...f.args, signal: new AbortController().signal }), true);
    const payloads = f.requests.slice(before).filter(request => request.end - request.start > 32768);
    assert.equal(payloads[0].start, f.args.range.start + block);
    assert.deepEqual(f.local, f.payload);
    if (mode === 'date') assert.equal(payloads[0].version, 'Tue, 10 Nov 2026 08:00:00 GMT');
  });
}

test('segment identity or cached hash mutation cannot append to a retained partial segment', async () => {
  for (const variant of ['identity', 'bytes']) {
    const f = fixture('none');
    await assert.rejects(checkpointSegment(f.args));
    if (variant === 'bytes') f.mutate();
    await assert.rejects(
      checkpointSegment({
        ...f.args,
        signal: new AbortController().signal,
        identity: variant === 'identity' ? 'other-manifest' : f.args.identity,
      }),
    );
  }
});

test('a non-Range segment explicitly selects atomic whole-segment transport', async () => {
  const f = fixture('none');
  assert.equal(
    await checkpointSegment({
      ...f.args,
      open: async () => ({
        response: new Response('full segment'),
        signal: f.controller.signal,
        touch: () => {},
        dispose: () => {},
      }),
    }),
    false,
  );
  assert.equal(f.local.length, 0);
});
