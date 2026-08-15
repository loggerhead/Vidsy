import { sanitizeLogData } from './logger';
import assert from 'node:assert/strict';
import test from 'node:test';

test('sanitizeLogData removes URL credentials, query parameters, and fragments recursively', () => {
  assert.deepEqual(
    sanitizeLogData({
      url: 'https://user:password@cdn.example/video.m3u8?token=secret#fragment',
      nested: {
        message: 'Fetch failed for https://cdn.example/segment.ts?signature=secret#part',
      },
    }),
    {
      url: 'https://cdn.example/video.m3u8',
      nested: {
        message: 'Fetch failed for https://cdn.example/segment.ts',
      },
    },
  );
});

test('sanitizeLogData redacts captured headers and sensitive header-like keys', () => {
  assert.deepEqual(
    sanitizeLogData({
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
      },
      Authorization: 'Bearer another-secret',
      Referer: 'https://example.com/watch?account=secret',
      Origin: 'https://example.com',
      safe: 'visible',
    }),
    {
      headers: '[REDACTED]',
      Authorization: '[REDACTED]',
      Referer: '[REDACTED]',
      Origin: '[REDACTED]',
      safe: 'visible',
    },
  );
});

test('sanitizeLogData never exposes blob URLs or sensitive Error message URL components', () => {
  assert.deepEqual(
    sanitizeLogData({
      blobUrl: 'blob:chrome-extension://extension-id/secret-id',
      error: new Error('Request https://api.example/item?access_token=secret#debug failed'),
    }),
    {
      blobUrl: '[REDACTED_BLOB_URL]',
      error: {
        name: 'Error',
        message: 'Request https://api.example/item failed',
      },
    },
  );
});
