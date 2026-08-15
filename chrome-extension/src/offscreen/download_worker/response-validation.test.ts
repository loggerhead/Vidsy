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
