import {
  aiAssert,
  extensionUrl,
  extensionWorker,
  startBrowser,
  stopBrowser,
  withNewPage,
  withPage,
} from '../helpers/browser.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve, sep } from 'node:path';
import type { Server } from 'node:http';

const fixturePath = resolve(
  import.meta.dirname,
  '../../..',
  process.env.VIDSY_MEDIA_FIXTURES ?? '.media-test/fixtures',
  'hls-ts-hevc.ts',
);
const enabled = process.env.VIDSY_MEDIA_REMUX_E2E === 'true';
let server: Server;
let fixturePageUrl: string;

const startFixtureServer = async () => {
  const preparation = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, '../../../tools/media-remux/prepare-test-media.mjs')],
    { encoding: 'utf8' },
  );
  if (preparation.status !== 0) throw new Error(preparation.stderr);
  await stat(fixturePath);
  server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<!doctype html><title>Vidsy HEVC Fixture</title><button id="load">Load media</button><script>document.querySelector("#load").onclick=()=>fetch("/hevc/playlist.m3u8")</script>',
      );
      return;
    }
    if (path === '/hevc/playlist.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXTINF:2.026667,\nsegment.ts\n#EXT-X-ENDLIST\n',
      );
      return;
    }
    if (path !== '/hevc/segment.ts') {
      response.writeHead(404);
      response.end();
      return;
    }
    const data = await readFile(fixturePath);
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range) {
      response.writeHead(200, {
        'content-type': 'video/mp2t',
        'accept-ranges': 'bytes',
        'content-length': data.length,
      });
      response.end(data);
      return;
    }
    const start = Number(range[1]);
    if (start >= data.length) {
      response.writeHead(416, { 'content-range': `bytes */${data.length}` });
      response.end();
      return;
    }
    const end = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1);
    response.writeHead(206, {
      'content-type': 'video/mp2t',
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${data.length}`,
      'content-length': end - start + 1,
    });
    response.end(data.subarray(start, end + 1));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a port');
  fixturePageUrl = `http://127.0.0.1:${address.port}/`;
};

const stopFixtureServer = async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
};

type Detection = { id: string; url: string; kind: string; source: string };
type Progress = { stage: string; error?: string; downloadId?: number };

const findDetection = async (): Promise<Detection | undefined> =>
  extensionWorker().evaluate(async () => {
    const state = (await chrome.storage.session.get('media-detections'))['media-detections'] ?? {};
    return (Object.values(state).flat() as Detection[]).find(item => item.url.includes('/hevc/playlist.m3u8'));
  });

const findProgress = async (): Promise<Progress | undefined> =>
  extensionWorker().evaluate(async () => {
    const state = (await chrome.storage.session.get('media-downloads'))['media-downloads'] ?? {};
    return (Object.values(state) as (Progress & { item?: Detection })[]).find(item =>
      item.item?.url.includes('/hevc/playlist.m3u8'),
    );
  });

describe.skipIf(!enabled)('HEVC media remux', () => {
  beforeAll(async () => {
    await startFixtureServer();
    await startBrowser();
  });
  afterAll(async () => {
    await stopBrowser();
    await stopFixtureServer();
  });

  it('detects HLS, shows progress, and downloads HEVC + AAC', async () => {
    await withPage(async (page, agent) => {
      await page.goto(fixturePageUrl);
      if (process.env.VIDSY_E2E_AI === 'off') await page.getByRole('button', { name: 'Load media' }).click();
      else await agent.aiTap('Load media button');
      await expect.poll(findDetection, { timeout: 15_000 }).toBeTruthy();
    });
    const detection = (await findDetection())!;
    await withNewPage(async (page, agent) => {
      await page.goto(extensionUrl('popup.html'));
      await expect.poll(() => page.locator('body').innerText()).toContain('HLS');
      await aiAssert(agent, 'The Vidsy popup shows a detected HLS media item with a Download button');

      await extensionWorker().evaluate(async item => {
        await chrome.storage.session.set({
          'media-downloads': {
            [item.id]: {
              key: item.id,
              stage: 'download-video',
              downloadedBytes: 23,
              estimatedBytes: 100,
              item,
              startedAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        });
      }, detection);
      await expect.poll(() => page.locator('body').innerText()).toContain('23%');
      expect(await page.getByRole('button', { name: 'Download', exact: true }).count()).toBe(0);
      await extensionWorker().evaluate(async () => chrome.storage.session.set({ 'media-downloads': {} }));
      const downloadButton = page.getByRole('button', { name: 'Download', exact: true }).first();
      await downloadButton.waitFor();
      if (process.env.VIDSY_E2E_AI === 'off') await downloadButton.click();
      else await agent.aiTap('the Download button for the HLS media item');
    });

    await expect
      .poll(
        async () => {
          const progress = await findProgress();
          if (progress?.stage === 'failed') throw new Error(`Extension download failed: ${progress.error}`);
          return progress?.stage;
        },
        { timeout: 60_000, interval: 100 },
      )
      .toBe('success');
    const progress = (await findProgress())!;
    const download = await extensionWorker().evaluate(
      async id => (await chrome.downloads.search({ id }))[0],
      progress.downloadId!,
    );
    const downloadedPath = download.filename;
    const expectedDownloadDirectory = resolve(
      import.meta.dirname,
      '../../..',
      process.env.VIDSY_E2E_DOWNLOAD_DIR ?? '.e2e-downloads',
    );
    expect(downloadedPath.startsWith(`${expectedDownloadDirectory}${sep}`)).toBe(true);
    await expect.poll(async () => (await stat(downloadedPath).catch(() => undefined))?.size ?? 0).toBeGreaterThan(0);
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', downloadedPath],
      { encoding: 'utf8' },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout) as { streams: { codec_type: string; codec_name: string }[] };
    expect(result.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_type: 'video', codec_name: 'hevc' }),
        expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
      ]),
    );
    if (process.env.VIDSY_EXTENSION_E2E_OUTPUT) {
      const output = resolve(import.meta.dirname, '../../..', process.env.VIDSY_EXTENSION_E2E_OUTPUT);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, await readFile(downloadedPath));
    }
    if (process.env.VIDSY_KEEP_E2E_ARTIFACTS !== '1') await unlink(downloadedPath);
  }, 120_000);
});
