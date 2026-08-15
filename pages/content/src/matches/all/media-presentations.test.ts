import { extractDeclaredMediaPresentations } from './media-presentations';
import assert from 'node:assert/strict';
import test from 'node:test';

test('extracts a structured media presentation from an inline page declaration', () => {
  const script = `
    window.pageData = {
      "player": {
        "presentation": "{\\"duration\\":608233,\\"representation\\":[
          {\\"url\\":\\"https://cdn.example/video-1080.m3u8\\",\\"width\\":1920,\\"height\\":1080,\\"frameRate\\":50,\\"avgBitrate\\":5017,\\"qualityLabel\\":\\"1080P60\\"},
          {\\"url\\":\\"https://cdn.example/video-720.m3u8\\",\\"width\\":1280,\\"height\\":720,\\"frameRate\\":30,\\"avgBitrate\\":1095,\\"qualityLabel\\":\\"720P\\"}
        ]}"
      }
    };
  `;

  assert.deepEqual(extractDeclaredMediaPresentations([script]), [
    {
      duration: 608.233,
      variants: [
        {
          url: 'https://cdn.example/video-1080.m3u8',
          name: '1080P60',
          bandwidth: 5_017_000,
          resolution: { width: 1920, height: 1080 },
          frameRate: 50,
        },
        {
          url: 'https://cdn.example/video-720.m3u8',
          name: '720P',
          bandwidth: 1_095_000,
          resolution: { width: 1280, height: 720 },
          frameRate: 30,
        },
      ],
    },
  ]);
});

test('ignores unrelated arrays containing URLs', () => {
  assert.deepEqual(
    extractDeclaredMediaPresentations([
      `window.data = {"links":[{"url":"https://example.com/page-a"},{"url":"https://example.com/page-b"}]};`,
    ]),
    [],
  );
});
