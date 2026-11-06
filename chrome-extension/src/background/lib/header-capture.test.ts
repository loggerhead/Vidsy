import {
  capturedRequestHeaders,
  setupHeaderCapture,
  captureHeaders,
  clearCapturedHeadersForTab,
  findCapturedHeaders,
  findDownloadHeaders,
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

test('unplayed Bilibili renditions get public referrer context without borrowing captured credentials', () => {
  capturedRequestHeaders.clear();
  const target = 'https://upos.example.bilivideo.com/upgcxcode/video.m4s';
  captureHeaders(target, 8, { Cookie: 'other-account', Authorization: 'Bearer other-account' });
  captureHeaders('https://upos.example.bilivideo.com/upgcxcode/other.m4s', 7, { Cookie: 'other-rendition' });
  assert.deepEqual(findDownloadHeaders(target, 7, 'https://www.bilibili.com/video/BV12tpi6uEGq/'), {
    Referer: 'https://www.bilibili.com/',
  });
  const audio = 'https://audio.mcdn.bilivideo.cn:8082/v1/resource/audio.m4s';
  assert.deepEqual(findDownloadHeaders(audio, 7, 'https://www.bilibili.com/video/BV12tpi6uEGq/'), {
    Referer: 'https://www.bilibili.com/',
  });
  captureHeaders(target, 7, { referer: 'https://www.bilibili.com/', Accept: '*/*' });
  assert.deepEqual(findDownloadHeaders(target, 7, 'https://www.bilibili.com/video/BV12tpi6uEGq/'), {
    referer: 'https://www.bilibili.com/',
    Accept: '*/*',
  });
});

test('provider referrer fallback rejects unrelated pages, URLs and lookalike domains', () => {
  capturedRequestHeaders.clear();
  for (const [target, page] of [
    ['https://bilivideo.com.evil.example/video.m4s', 'https://www.bilibili.com/video/BV12tpi6uEGq/'],
    ['https://evilbilivideo.com/video.m4s', 'https://www.bilibili.com/video/BV12tpi6uEGq/'],
    ['https://cdn.bilivideo.com/video.m4s', 'https://www.bilibili.com.evil.example/video/BV12tpi6uEGq/'],
    ['https://cdn.bilivideo.com/video.m4s', 'https://other.example/watch'],
    ['https://cdn.bilivideo.com/video.m4s', 'https://www.bilibili.com/'],
    ['http://cdn.bilivideo.com/video.m4s', 'https://www.bilibili.com/video/BV12tpi6uEGq/'],
  ])
    assert.equal(findDownloadHeaders(target, 7, page), undefined);
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

test('a failed unauthenticated probe cannot replace a successful request context', () => {
  const original = globalThis.chrome;
  let request!: (details: {
      requestId: string;
      url?: string;
      tabId?: number;
      requestHeaders?: Array<{ name: string; value: string }>;
      statusCode?: number;
    }) => void,
    response!: (details: {
      requestId: string;
      url?: string;
      tabId?: number;
      requestHeaders?: Array<{ name: string; value: string }>;
      statusCode?: number;
    }) => void;
  Object.assign(globalThis, {
    chrome: {
      webRequest: {
        onSendHeaders: {
          addListener: (listener: typeof request) => {
            request = listener;
          },
        },
        onResponseStarted: {
          addListener: (listener: typeof response) => {
            response = listener;
          },
        },
        onErrorOccurred: { addListener: () => {} },
      },
    },
  });
  try {
    capturedRequestHeaders.clear();
    setupHeaderCapture();
    const url = 'https://example.test/master.m3u8';
    request({ requestId: 'good', url, tabId: 7, requestHeaders: [{ name: 'Authorization', value: 'Bearer good' }] });
    response({ requestId: 'good', statusCode: 200 });
    request({ requestId: 'bad', url, tabId: 7, requestHeaders: [{ name: 'Accept', value: '*/*' }] });
    response({ requestId: 'bad', statusCode: 401 });
    assert.deepEqual(findCapturedHeaders(url, undefined, 7), { Authorization: 'Bearer good' });
  } finally {
    Object.assign(globalThis, { chrome: original });
  }
});
