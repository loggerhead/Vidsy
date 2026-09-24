import { clearFmp4RangeDetectionsForTab, handleFmp4RangeDetection, parseFmp4InitSegment } from './fmp4-range-detector';
import assert from 'node:assert/strict';
import test from 'node:test';

const ascii = (s: string): number[] => [...s].map(ch => ch.charCodeAt(0));

const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

const box = (type: string, body: number[] = []): number[] => [...u32(body.length + 8), ...ascii(type), ...body];

const fullBox = (type: string, body: number[] = []): number[] => box(type, [0, 0, 0, 0, ...body]);

const tkhd = (width: number, height: number): number[] => {
  // The parser only needs the final width/height fixed-point fields.
  const body = new Array(72).fill(0);
  body.push(...u32(width << 16), ...u32(height << 16));
  return fullBox('tkhd', body);
};

const hdlr = (handler: 'vide' | 'soun'): number[] => fullBox('hdlr', [0, 0, 0, 0, ...ascii(handler), 0, 0, 0, 0]);

const stsd = (codec: string): number[] => fullBox('stsd', [...u32(1), ...box(codec, new Array(24).fill(0))]);

const initSegment = (handler: 'vide' | 'soun', codec: string, width = 0, height = 0): ArrayBuffer => {
  const trak = box('trak', [
    ...(handler === 'vide' ? tkhd(width, height) : []),
    ...box('mdia', [...hdlr(handler), ...box('minf', [...box('stbl', [...stsd(codec)])])]),
  ]);
  const bytes = new Uint8Array([...box('ftyp', [...ascii('isom'), 0, 0, 0, 0]), ...box('moov', [...trak])]);
  return bytes.buffer;
};

const muxedInitSegment = (): ArrayBuffer => {
  const videoTrack = box('trak', [
    ...tkhd(1280, 720),
    ...box('mdia', [...hdlr('vide'), ...box('minf', [...box('stbl', [...stsd('avc1')])])]),
  ]);
  const audioTrack = box('trak', [
    ...box('mdia', [...hdlr('soun'), ...box('minf', [...box('stbl', [...stsd('mp4a')])])]),
  ]);
  return new Uint8Array([
    ...box('ftyp', [...ascii('isom'), 0, 0, 0, 0]),
    ...box('moov', [...videoTrack, ...audioTrack]),
  ]).buffer;
};

test('parseFmp4InitSegment detects a video track with codec and resolution', () => {
  assert.deepEqual(parseFmp4InitSegment(initSegment('vide', 'avc1', 1920, 1080)), {
    kind: 'video',
    codecs: 'avc1',
    width: 1920,
    height: 1080,
  });
});

test('parseFmp4InitSegment detects an audio track with codec', () => {
  assert.deepEqual(parseFmp4InitSegment(initSegment('soun', 'mp4a')), {
    kind: 'audio',
    codecs: 'mp4a',
    width: undefined,
    height: undefined,
  });
});

test('clearing a tab also clears its probed URL identity for the next document', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(initSegment('vide', 'avc1', 1280, 720), {
      status: 206,
      headers: { 'content-type': 'video/mp4' },
    });
  };

  const request = {
    url: 'https://cdn.example/media/video.m4s?token=stable',
    tabId: 42,
    responseHeaders: [{ name: 'Content-Range', value: 'bytes 0-4095/1000000' }],
    mimeType: 'video/mp4',
  };

  try {
    await handleFmp4RangeDetection(request);
    await handleFmp4RangeDetection(request);
    assert.equal(fetches, 1);

    clearFmp4RangeDetectionsForTab(42);
    await handleFmp4RangeDetection(request);
    assert.equal(fetches, 2);
  } finally {
    clearFmp4RangeDetectionsForTab(42);
    globalThis.fetch = originalFetch;
  }
});

test('a ranged video track is emitted without waiting for a separate audio URL', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(initSegment('vide', 'avc1', 1280, 720), {
      status: 206,
      headers: { 'content-type': 'video/mp4' },
    });

  try {
    const result = await handleFmp4RangeDetection({
      url: 'https://cdn.example/asset/video.mp4',
      tabId: 45,
      responseHeaders: [{ name: 'Content-Range', value: 'bytes 0-4095/1000000' }],
      mimeType: 'video/mp4',
    });

    assert.equal(result.handled, true);
    assert.equal(result.candidate?.url, 'https://cdn.example/asset/video.mp4');
    assert.equal(result.candidate?.kind, 'video');
    assert.equal(result.candidate?.audioUrl, undefined);
  } finally {
    clearFmp4RangeDetectionsForTab(45);
    globalThis.fetch = originalFetch;
  }
});

test('an unreadable range response remains unclaimed by the fMP4 detector', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 403 });

  try {
    const result = await handleFmp4RangeDetection({
      url: 'https://cdn.example/media/video.mp4',
      tabId: 46,
      responseHeaders: [{ name: 'Content-Range', value: 'bytes 0-4095/1000000' }],
      mimeType: 'video/mp4',
    });

    assert.deepEqual(result, { handled: false });
  } finally {
    clearFmp4RangeDetectionsForTab(46);
    globalThis.fetch = originalFetch;
  }
});

test('parsed fMP4 track kind overrides generic CDN content types', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    const segment = url.includes('audio') ? initSegment('soun', 'mp4a') : initSegment('vide', 'av01', 1920, 1018);
    return new Response(segment, { status: 206, headers: { 'content-type': 'application/octet-stream' } });
  };

  const responseHeaders = [{ name: 'Content-Range', value: 'bytes 0-4095/1000000' }];
  try {
    await handleFmp4RangeDetection({
      url: 'https://cdn.example/asset/video.m4s',
      tabId: 43,
      responseHeaders,
      mimeType: 'application/octet-stream',
    });
    const result = await handleFmp4RangeDetection({
      url: 'https://cdn.example/asset/audio.m4s',
      tabId: 43,
      responseHeaders,
      mimeType: 'application/octet-stream',
    });

    assert.equal(result.candidate?.mimeType, 'video/mp4');
    assert.equal(result.candidate?.audioMimeType, 'audio/mp4');
    assert.equal(result.candidate?.variants?.[0]?.codecs, 'av01');
  } finally {
    clearFmp4RangeDetectionsForTab(43);
    globalThis.fetch = originalFetch;
  }
});

test('a self-contained ranged MP4 is immediately authoritative', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(muxedInitSegment(), { status: 206, headers: { 'content-type': 'video/mp4' } });

  try {
    const result = await handleFmp4RangeDetection({
      url: 'https://cdn.example/media/complete.mp4',
      tabId: 44,
      responseHeaders: [{ name: 'Content-Range', value: 'bytes 0-4095/2000000' }],
      mimeType: 'video/mp4',
    });

    assert.equal(result.handled, true);
    assert.equal(result.candidate?.url, 'https://cdn.example/media/complete.mp4');
    assert.equal(result.candidate?.kind, 'video');
    assert.deepEqual(result.candidate?.resolution, { width: 1280, height: 720 });
    assert.equal(result.candidate?.audioUrl, undefined);
  } finally {
    clearFmp4RangeDetectionsForTab(44);
    globalThis.fetch = originalFetch;
  }
});
