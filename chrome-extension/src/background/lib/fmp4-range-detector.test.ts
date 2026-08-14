import { parseFmp4InitSegment } from './fmp4-range-detector';
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
