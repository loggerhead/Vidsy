import { extensionUrl, extensionWorker, startBrowser, stopBrowser, withNewPage } from '../helpers/browser.js';
import { injectNextMuxFailure } from '../helpers/mux-failure.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { Server } from 'node:http';

let server: Server;
let origin: string;
const requests: string[] = [];
const fixtures = resolve(import.meta.dirname, '../../../.media-test/fixtures');

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const name = request.url!.slice(1);
    if (name === 'mux-hls.m3u8') {
      requests.push(name);
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhls-ts-h264.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (
      !['direct.mp4', 'separate-video.mp4', 'separate-audio.m4a', 'hls-ts-h264.ts', 'stream.mp4'].includes(name) &&
      !/^dash\/[A-Za-z0-9_.-]+$/.test(name)
    ) {
      response.writeHead(404).end();
      return;
    }
    const data = await readFile(resolve(fixtures, name === 'stream.mp4' ? 'direct.mp4' : name));
    requests.push(name);
    const range = name === 'stream.mp4' ? undefined : request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(Number(range[2] || data.length - 1), data.length - 1) : data.length - 1;
    response.writeHead(range ? 206 : 200, {
      etag: '"mux-fixture-v1"',
      'content-type': 'video/mp4',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}),
    });
    response.end(data.subarray(start, end + 1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  await startBrowser();
});

afterAll(async () => {
  await stopBrowser();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

const progress = (key: string) =>
  extensionWorker().evaluate(
    async key => (await chrome.storage.local.get('media-downloads'))['media-downloads']?.[key],
    key,
  );
const stage = async (key: string, expected: string) =>
  expect
    .poll(
      async () => {
        const item = await progress(key);
        if (item?.stage === 'failed' && expected !== 'failed') throw new Error(item.error);
        return item?.stage;
      },
      { timeout: 20_000 },
    )
    .toBe(expected);

it.each([
  {
    name: 'merged',
    path: 'separate-video.mp4',
    audio: 'separate-audio.m4a',
    kind: 'video',
    outputFormat: 'mp4',
    codecs: ['h264', 'aac'],
  },
  { name: 'HTTP MP3', path: 'direct.mp4', audio: undefined, kind: 'video', outputFormat: 'mp3', codecs: ['mp3'] },
  { name: 'stream MP3', path: 'stream.mp4', audio: undefined, kind: 'video', outputFormat: 'mp3', codecs: ['mp3'] },
  { name: 'HLS', path: 'mux-hls.m3u8', audio: undefined, kind: 'hls', outputFormat: 'mp4', codecs: ['h264', 'aac'] },
  {
    name: 'DASH',
    path: 'dash/manifest.mpd',
    audio: undefined,
    kind: 'dash',
    outputFormat: 'mp4',
    codecs: ['h264', 'aac'],
  },
])(
  'real $name mux failure retains inputs; Retry performs no media requests and delivers validated tracks',
  async mode => {
    await withNewPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      const seed = crypto.randomUUID();
      await page.evaluate(
        async ({ key, url }) =>
          chrome.runtime.sendMessage({ type: 'media/download', payload: { key, url, kind: 'video', fileName: key } }),
        { key: seed, url: `${origin}/direct.mp4` },
      );
      await stage(seed, 'success');
      const [seedDownload] = await extensionWorker().evaluate(
        async id => chrome.downloads.search({ id }),
        (await progress(seed)).downloadId,
      );
      await unlink(seedDownload.filename);

      // Give the real mux one invalid local input through the offscreen worker
      // channel. The stored inputs and the second attempt remain unchanged.
      const cdp = await injectNextMuxFailure(page);
      const key = crypto.randomUUID();
      await page.evaluate(async payload => chrome.runtime.sendMessage({ type: 'media/download', payload }), {
        key,
        url: `${origin}/${mode.path}`,
        audioUrl: mode.audio ? `${origin}/${mode.audio}` : undefined,
        kind: mode.kind,
        outputFormat: mode.outputFormat,
        fileName: key,
      });
      await stage(key, 'failed');
      expect((await progress(key)).error).toContain('completed inputs are retained');
      requests.length = 0;
      await page.evaluate(
        async key => chrome.runtime.sendMessage({ type: 'media/control', payload: { key, intent: 'retry' } }),
        key,
      );
      await stage(key, 'success');
      expect(requests.filter(path => !path.endsWith('.m3u8') && !path.endsWith('.mpd'))).toEqual([]);
      const [download] = await extensionWorker().evaluate(
        async id => chrome.downloads.search({ id }),
        (await progress(key)).downloadId,
      );
      expect((await readFile(download.filename)).byteLength).toBeGreaterThan(0);
      const probe = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,codec_type:format=duration',
          '-of',
          'json',
          download.filename,
        ],
        { encoding: 'utf8' },
      );
      expect(probe.status, probe.stderr).toBe(0);
      const metadata = JSON.parse(probe.stdout);
      expect(Math.abs(Number(metadata.format.duration) - 2)).toBeLessThan(0.5);
      const streams = metadata.streams;
      for (const codec of mode.codecs)
        expect(streams).toEqual(expect.arrayContaining([expect.objectContaining({ codec_name: codec })]));
      await unlink(download.filename);
      await cdp.detach();
    });
  },
);
