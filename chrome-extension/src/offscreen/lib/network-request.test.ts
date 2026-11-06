import { openDownloadResponse } from './network-request';
import assert from 'node:assert/strict';
import test from 'node:test';

test('active body reception extends idle deadline without extending overall deadline', async () => {
  const request = await openDownloadResponse('https://example.test/file', {
    idleMs: 50,
    totalMs: 220,
    fetchImpl: async (_url, init) => {
      assert.ok(init?.signal);
      return new Response('bytes');
    },
  });
  try {
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      request.touch();
    }
    assert.equal(request.signal.aborted, false);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(request.signal.aborted, true);
    assert.match(String(request.signal.reason), /no data/);
  } finally {
    request.dispose();
  }
});

test('refreshes isolated authorization at redirect destination before retry', async () => {
  const authorized: string[] = [],
    fetched: string[] = [];
  const request = await openDownloadResponse('https://source.test/list', {
    authorizeUrl: async url => {
      authorized.push(url);
    },
    fetchImpl: async url => {
      fetched.push(String(url));
      const response = new Response('body', { status: fetched.length === 1 ? 403 : 200 });
      Object.defineProperty(response, 'url', { value: 'https://target.test/list' });
      return response;
    },
  });
  request.dispose();
  assert.deepEqual(fetched, ['https://source.test/list', 'https://target.test/list']);
  assert.deepEqual(authorized, ['https://source.test/list', 'https://target.test/list']);
  assert.equal(request.response.status, 200);
});
