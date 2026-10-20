import {
  capturedRequestHeaders,
  captureHeaders,
  clearCapturedHeadersForTab,
  findCapturedHeaders,
  headersForDnr,
  injectHeadersForDownload,
  authorizeUrlForDownload,
  releaseUrlForDownload,
  removeHeadersForDownload,
} from './header-capture';
import assert from 'node:assert/strict';
import test from 'node:test';

test('findCapturedHeaders matches refreshed query parameters within the same tab', () => {
  capturedRequestHeaders.clear();
  captureHeaders('https://cdn.example/video.m3u8?token=old', 7, { Referer: 'https://example.com/watch' });

  assert.deepEqual(findCapturedHeaders('https://cdn.example/video.m3u8?token=new', undefined, 7), {
    Referer: 'https://example.com/watch',
  });
  assert.equal(findCapturedHeaders('https://cdn.example/video.m3u8?token=new', undefined, 8), undefined);
});

test('findCapturedHeaders does not reuse an exact URL captured by another tab', () => {
  capturedRequestHeaders.clear();
  captureHeaders('https://cdn.example/video.m3u8', 7, { Authorization: 'Bearer tab-seven' });

  assert.equal(findCapturedHeaders('https://cdn.example/video.m3u8', undefined, 8), undefined);
});

test('headersForDnr excludes browser-generated fetch metadata', () => {
  const originalChrome = globalThis.chrome;
  Object.assign(globalThis, {
    chrome: {
      declarativeNetRequest: {
        HeaderOperation: { SET: 'set' },
      },
    },
  });

  try {
    assert.deepEqual(
      headersForDnr({
        Referer: 'https://example.com/watch',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'User-Agent': 'Captured browser user agent',
      }),
      [
        { header: 'Referer', operation: 'set', value: 'https://example.com/watch' },
        { header: 'User-Agent', operation: 'set', value: 'Captured browser user agent' },
      ],
    );
  } finally {
    Object.assign(globalThis, { chrome: originalChrome });
  }
});

test('injectHeadersForDownload uses a session rule for extension-only tab scope', async () => {
  const originalChrome = globalThis.chrome;
  const calls: chrome.declarativeNetRequest.UpdateRuleOptions[] = [];
  Object.assign(globalThis, {
    chrome: {
      declarativeNetRequest: {
        HeaderOperation: { SET: 'set' },
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
        updateSessionRules: async (options: chrome.declarativeNetRequest.UpdateRuleOptions) => {
          calls.push(options);
        },
        updateDynamicRules: async () => {
          throw new Error('dynamic rules cannot use tabIds');
        },
      },
    },
  });

  try {
    await injectHeadersForDownload(
      'https://cdn.example/video.m3u8',
      { Referer: 'https://example.com/watch' },
      'session-rule-test',
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].addRules?.[0].condition.tabIds, [-1]);
  } finally {
    Object.assign(globalThis, { chrome: originalChrome });
  }
});

test('exact URL grants are isolated, transient grants are bounded and source credentials do not cross origins', async () => {
  const originalChrome = globalThis.chrome;
  const live = new Map<number, chrome.declarativeNetRequest.Rule>();
  let peak = 0;
  Object.assign(globalThis, {
    chrome: {
      declarativeNetRequest: {
        HeaderOperation: { SET: 'set' },
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
        updateSessionRules: async (options: chrome.declarativeNetRequest.UpdateRuleOptions) => {
          for (const id of options.removeRuleIds ?? []) live.delete(id);
          for (const rule of options.addRules ?? []) live.set(rule.id, rule);
          peak = Math.max(peak, live.size);
        },
      },
    },
  });
  try {
    capturedRequestHeaders.clear();
    await injectHeadersForDownload(
      'https://lease.example/master.m3u8?account=A',
      { Authorization: 'Bearer A', Cookie: 'session=A', Referer: 'https://page.example/watch' },
      'lease-job',
      7,
    );
    const initial = [...live.values()][0];
    const match = new RegExp(initial.condition.regexFilter!);
    assert.equal(match.test('https://lease.example/master.m3u8?account=A'), true);
    assert.equal(match.test('https://lease.example/master.m3u8?account=B'), false);
    await authorizeUrlForDownload('lease-job', 'https://untrusted.example/segment.ts', true);
    assert.equal(live.size, 1, 'a source grant cannot authorize a different origin');
    for (let batch = 0; batch < 10; batch++) {
      const urls = Array.from({ length: 4 }, (_, index) => `https://lease.example/segment-${batch}-${index}.ts`);
      await Promise.all(urls.map(url => authorizeUrlForDownload('lease-job', url, true)));
      await Promise.all(urls.map(url => releaseUrlForDownload('lease-job', url)));
      assert.equal(live.size, 1);
    }
    assert.equal(peak, 5);
    await removeHeadersForDownload('lease-job');
    assert.equal(live.size, 0);
  } finally {
    Object.assign(globalThis, { chrome: originalChrome });
  }
});

test('identical CDN URLs keep independent tab credentials and tab cleanup preserves the other account', () => {
  capturedRequestHeaders.clear();
  const url = 'https://cdn.example/video.m3u8';
  captureHeaders(url, 7, { Authorization: 'Bearer A', Cookie: 'A' });
  captureHeaders(url, 8, { Authorization: 'Bearer B', Cookie: 'B' });
  assert.deepEqual(findCapturedHeaders(url, undefined, 7), { Authorization: 'Bearer A', Cookie: 'A' });
  assert.deepEqual(findCapturedHeaders(url, undefined, 8), { Authorization: 'Bearer B', Cookie: 'B' });
  clearCapturedHeadersForTab(8);
  assert.equal(findCapturedHeaders(url, undefined, 8), undefined);
  assert.equal(findCapturedHeaders(url, undefined, 7)?.Authorization, 'Bearer A');
});
