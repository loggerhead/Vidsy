import { assertCompleteResponse, assertSuccessfulResponse, expectedResponseBytes } from './response-validation';
import assert from 'node:assert/strict';
import test from 'node:test';

test('expectedResponseBytes accepts only a valid non-negative Content-Length', () => {
  assert.equal(expectedResponseBytes(new Response(null, { headers: { 'content-length': '12' } })), 12);
  assert.equal(expectedResponseBytes(new Response(null, { headers: { 'content-length': '-1' } })), undefined);
  assert.equal(expectedResponseBytes(new Response(null, { headers: { 'content-length': 'unknown' } })), undefined);
  assert.equal(expectedResponseBytes(new Response()), undefined);
});

test('assertCompleteResponse rejects empty and truncated bodies when Content-Length is declared', () => {
  const response = new Response(null, { headers: { 'content-length': '8' } });
  assert.throws(() => assertCompleteResponse(response, 0), /expected 8 bytes, received 0/);
  assert.throws(() => assertCompleteResponse(response, 3), /expected 8 bytes, received 3/);
  assert.doesNotThrow(() => assertCompleteResponse(response, 8));
});

test('assertSuccessfulResponse rejects representative HTTP failures and permits ranges', () => {
  for (const status of [401, 403, 404, 416, 500, 503]) {
    assert.throws(() => assertSuccessfulResponse(new Response(null, { status })), new RegExp(`HTTP ${status}`));
  }
  assert.doesNotThrow(() => assertSuccessfulResponse(new Response(null, { status: 200 })));
  assert.doesNotThrow(() => assertSuccessfulResponse(new Response(null, { status: 206 })));
});

test('Range validation rejects ignored ranges, wrong offsets, changed totals and truncated data', async () => {
  const { assertRangeResponse } = await import('./response-validation');
  const expected = { start: 10, end: 19, total: 100 };
  for (const [status, range] of [
    [200, 'bytes 10-19/100'],
    [206, 'bytes 0-9/100'],
    [206, 'bytes 10-19/101'],
    [206, 'bytes 10-20/100'],
    [206, 'bytes 10-19/*'],
  ] as const) {
    assert.throws(() =>
      assertRangeResponse(new Response(null, { status, headers: { 'content-range': range } }), expected),
    );
  }
  const valid = new Response(null, { status: 206, headers: { 'content-range': 'bytes 10-19/100' } });
  assert.doesNotThrow(() => assertRangeResponse(valid, expected, 10));
  assert.throws(() => assertRangeResponse(valid, expected, 9), /length mismatch/);
  assert.throws(() => assertRangeResponse(valid, expected, 100), /length mismatch/);
});
