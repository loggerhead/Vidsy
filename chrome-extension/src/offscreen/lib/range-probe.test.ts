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
