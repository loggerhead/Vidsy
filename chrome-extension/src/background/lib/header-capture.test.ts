import { capturedRequestHeaders, findCapturedHeaders, headersForDnr, injectHeadersForDownload } from './header-capture';
import assert from 'node:assert/strict';
import test from 'node:test';

test('findCapturedHeaders matches refreshed query parameters within the same tab', () => {
  capturedRequestHeaders.clear();
  capturedRequestHeaders.set('https://cdn.example/video.m3u8?token=old', {
    timestamp: 1,
    tabId: 7,
    headers: { Referer: 'https://example.com/watch' },
  });

  assert.deepEqual(findCapturedHeaders('https://cdn.example/video.m3u8?token=new', undefined, 7), {
    Referer: 'https://example.com/watch',
  });
  assert.equal(findCapturedHeaders('https://cdn.example/video.m3u8?token=new', undefined, 8), undefined);
});

test('findCapturedHeaders does not reuse an exact URL captured by another tab', () => {
  capturedRequestHeaders.clear();
  capturedRequestHeaders.set('https://cdn.example/video.m3u8', {
    timestamp: 1,
    tabId: 7,
    headers: { Authorization: 'Bearer tab-seven' },
  });

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
