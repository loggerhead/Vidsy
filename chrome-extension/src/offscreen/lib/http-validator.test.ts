import { canonicalHttpSource, httpDate, responseValidator } from './http-validator';
import assert from 'node:assert/strict';
import test from 'node:test';

test('validator selection keeps strong ETag priority and uses dates or boundary sampling for weak sources', () => {
  const date = 'Tue, 10 Nov 2026 08:00:00 GMT';
  assert.deepEqual(responseValidator(new Headers({ etag: '"strong"', 'last-modified': date })), {
    resourceVersion: '"strong"',
    validationMethod: 'etag',
  });
  assert.deepEqual(responseValidator(new Headers({ etag: 'W/"weak"', 'last-modified': date })), {
    resourceVersion: date,
    weakEtag: 'W/"weak"',
    validationMethod: 'last-modified',
  });
  assert.equal(responseValidator(new Headers({ etag: 'W/"weak"' })).validationMethod, 'boundary-sample');
  assert.equal(responseValidator(new Headers()).validationMethod, 'boundary-sample');
  assert.equal(httpDate('not a date'), undefined);
});

test('completed HTTP identity survives dictionary order and header case without sharing credentials', () => {
  const first = canonicalHttpSource('https://fixture.test/video', {
    Authorization: 'account-a',
    Origin: 'https://site.test',
  });
  assert.equal(
    first,
    canonicalHttpSource('https://fixture.test/video', { origin: 'https://site.test', authorization: 'account-a' }),
  );
  assert.notEqual(
    first,
    canonicalHttpSource('https://fixture.test/video', { Authorization: 'account-b', Origin: 'https://site.test' }),
  );
});
