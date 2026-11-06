import { extractAcfunPresentation, extractDeclaredMediaPresentations } from './media-presentations';
import assert from 'node:assert/strict';
import test from 'node:test';

test('extracts a structured media presentation from an inline page declaration', () => {
  const script = `
    window.pageData = {
      "player": {
        "presentation": "{\\"durationMillis\\":608233,\\"representation\\":[
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

test('generic declarations do not guess the unit of an unqualified duration', () => {
  const representation = [
    { url: 'https://cdn.example/1080.m3u8', width: 1920, height: 1080 },
    { url: 'https://cdn.example/720.m3u8', width: 1280, height: 720 },
  ];
  for (const duration of [29, 29836, 608233]) {
    const script = `window.player = ${JSON.stringify({ duration, representation })};`;
    const [presentation] = extractDeclaredMediaPresentations([script]);
    assert.equal(presentation.duration, undefined);
    assert.equal(presentation.variants.length, 2);
  }
});

test('generic declarations retain only explicitly named time units', () => {
  const representation = [
    { url: 'https://cdn.example/1080.m3u8', width: 1920, height: 1080 },
    { url: 'https://cdn.example/720.m3u8', width: 1280, height: 720 },
  ];
  for (const [field, value, expected] of [
    ['durationSeconds', 29836, 29836],
    ['durationMillis', 29836, 29.836],
    ['durationMs', 29836, 29.836],
  ] as const) {
    const script = `window.player = ${JSON.stringify({ [field]: value, representation })};`;
    assert.equal(extractDeclaredMediaPresentations([script])[0].duration, expected);
  }
});

test('AcFun current-video metadata supplies a cover and millisecond duration', () => {
  const playInfo = {
    adaptationSet: [
      {
        duration: 29836,
        representation: [
          { url: 'https://video.acfun.cn/2160.m3u8', width: 2160, height: 3840, qualityLabel: '2160P' },
          { url: 'https://video.acfun.cn/1080.m3u8', width: 1080, height: 1920, qualityLabel: '1080P' },
        ],
      },
    ],
  };
  const pageInfo = {
    dougaId: '48906318',
    title: 'Your voice in my heart',
    coverUrl: 'https://imgs.aixifan.com/current-video.jpg',
    currentVideoInfo: { durationMillis: 29833, ksPlayJson: JSON.stringify(playInfo) },
  };
  const script = `window.pageInfo = window.videoInfo = ${JSON.stringify(pageInfo)}; window.afterPlayer();`;

  assert.deepEqual(extractAcfunPresentation('https://www.acfun.cn/v/ac48906318', [script]), {
    title: 'Your voice in my heart',
    thumbnail: 'https://imgs.aixifan.com/current-video.jpg',
    duration: 29.833,
    variants: [
      {
        url: 'https://video.acfun.cn/2160.m3u8',
        name: '2160P',
        bandwidth: undefined,
        resolution: { width: 2160, height: 3840 },
        frameRate: undefined,
      },
      {
        url: 'https://video.acfun.cn/1080.m3u8',
        name: '1080P',
        bandwidth: undefined,
        resolution: { width: 1080, height: 1920 },
        frameRate: undefined,
      },
    ],
  });
  assert.equal(extractAcfunPresentation('https://www.acfun.cn/v/ac48906319', [script]), undefined);
});
