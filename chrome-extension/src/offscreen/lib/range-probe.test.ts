import { probeRangeSupport } from './range-probe';
import assert from 'node:assert/strict';
import test from 'node:test';

test('range probe cancels a full response without buffering its body', async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  let buffered = false;
  globalThis.fetch = async () => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-length': '9999999999', 'content-type': 'video/mp4' } },
    );
    response.arrayBuffer = async () => {
      buffered = true;
      throw new Error('Must not buffer');
    };
    return response;
  };
  try {
    const probe = await probeRangeSupport('https://example.test/video', new AbortController().signal);
    assert.equal(probe.supportsRange, false);
    assert.equal(probe.totalBytes, 9999999999);
    assert.equal(cancelled, true);
    assert.equal(buffered, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('retained strong-validator checkpoints use HEAD and expose changed identity without downloading cached media', async () => {
  const original = fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    return new Response(null, { headers: { etag: '"new"', 'content-length': '8', 'content-type': 'video/mp4' } });
  };
  try {
    const probe = await probeRangeSupport('https://fixture/video', new AbortController().signal, undefined, {
      url: 'https://fixture/video',
      resourceVersion: '"old"',
      totalBytes: 8,
    });
    assert.equal(probe.resourceVersion, '"new"');
    assert.deepEqual(methods, ['HEAD']);
  } finally {
    globalThis.fetch = original;
  }
});

test('HTTP failure during checkpoint validation does not become a streaming fallback', async () => {
  const original = fetch;
  globalThis.fetch = async () => new Response(null, { status: 403 });
  try {
    await assert.rejects(
      probeRangeSupport('https://fixture/video', new AbortController().signal, undefined, {
        url: 'https://fixture/video',
        resourceVersion: '"old"',
        totalBytes: 8,
      }),
      /403/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
