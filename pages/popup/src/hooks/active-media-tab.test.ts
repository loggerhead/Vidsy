import { selectMediaPageTab } from './active-media-tab';
import assert from 'node:assert/strict';
import test from 'node:test';

test('prefers the active media page in the popup current window', () => {
  assert.equal(
    selectMediaPageTab(
      [{ id: 7, url: 'https://example.com/watch', active: true }],
      [{ id: 8, url: 'https://other.example/video', active: true }],
      [],
    )?.id,
    7,
  );
});

test('falls back to an active media page when a standalone popup sees only itself', () => {
  assert.equal(
    selectMediaPageTab(
      [{ id: 9, url: 'chrome-extension://extension-id/popup/index.html', active: true }],
      [
        { id: 9, url: 'chrome-extension://extension-id/popup/index.html', active: true },
        { id: 10, url: 'http://127.0.0.1:8080/', active: true },
      ],
      [],
    )?.id,
    10,
  );
});

test('does not select browser or extension internal pages', () => {
  assert.equal(
    selectMediaPageTab(
      [{ id: 1, url: 'chrome://extensions', active: true }],
      [{ id: 2, url: 'chrome-extension://extension-id/popup/index.html', active: true }],
      [],
    ),
    undefined,
  );
});

test('falls back to the most recently accessed media page when the popup owns the active tab', () => {
  assert.equal(
    selectMediaPageTab(
      [{ id: 1, url: 'chrome-extension://extension-id/popup/index.html', active: true }],
      [{ id: 1, url: 'chrome-extension://extension-id/popup/index.html', active: true }],
      [
        { id: 11, url: 'https://older.example/video', lastAccessed: 100 },
        { id: 12, url: 'https://recent.example/video', lastAccessed: 200 },
      ],
    )?.id,
    12,
  );
});
