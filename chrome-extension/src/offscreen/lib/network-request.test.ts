import { DownloadFailure } from './download-failure';
import { scopeHeaders } from './fetch-headers';
import { automaticallyRecoverable, HttpRequestError, waitForRetry, openDownloadResponse } from './network-request';
import assert from 'node:assert/strict';
import test from 'node:test';

test('cross-origin byte requests retain their Range controls while source credentials stay scoped', async () => {
  const calls: Headers[] = [];
  const request = await openDownloadResponse('https://rendition.test/part', {
    headers: scopeHeaders({ Authorization: 'private-source', range: 'bytes=0-' }, 'https://source.test/master'),
    requestHeaders: { Range: 'bytes=1048576-2097151', 'If-Range': '"v1"' },
    fetchImpl: async (_url, init) => {
      calls.push(new Headers(init?.headers));
      return new Response('sample');
    },
  });
  request.dispose();
  await request.response.body?.cancel();
  assert.equal(calls[0].get('authorization'), null);
  assert.equal(calls[0].get('range'), 'bytes=1048576-2097151');
  assert.equal(calls[0].get('if-range'), '"v1"');
});

test('automatic retry is limited to transient transport errors and preserves worker classification', () => {
  for (const status of [408, 429, 500, 502, 503, 504])
    assert.equal(automaticallyRecoverable(new HttpRequestError(status, 'https://fixture.test/')), true);
  for (const status of [401, 403, 404, 410, 416])
    assert.equal(automaticallyRecoverable(new HttpRequestError(status, 'https://fixture.test/')), false);
  assert.equal(automaticallyRecoverable(new TypeError('Failed to fetch')), true);
  assert.equal(automaticallyRecoverable(new DOMException('timeout', 'TimeoutError')), true);
  assert.equal(automaticallyRecoverable(new Error('Download stalled: no data')), true);
  assert.equal(automaticallyRecoverable(new Error('unknown worker error')), false);
  assert.equal(automaticallyRecoverable(new DOMException('quota', 'QuotaExceededError')), false);
  assert.equal(automaticallyRecoverable(new DownloadFailure('integrity', 'bad bytes', undefined, true)), false);
  assert.equal(automaticallyRecoverable(new DownloadFailure('processing', 'mux', undefined, true)), false);
  assert.equal(automaticallyRecoverable(new DownloadFailure('transport', 'network', undefined, true)), true);
  assert.equal(automaticallyRecoverable(new DownloadFailure('transport', 'HTTP 403', undefined, false)), false);
});

test('cancel interrupts transport backoff before its timer expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const pending = waitForRetry(30_000, controller.signal);
  controller.abort(new DOMException('cancel', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
});
