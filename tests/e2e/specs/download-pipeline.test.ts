import { extensionUrl, extensionWorker, startBrowser, stopBrowser, withNewPage } from '../helpers/browser.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFile, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import type { Server } from 'node:http';

const root = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(root, '.media-test/fixtures');
let server: Server;
let origin: string;
const requests: string[] = [];
const rangeCalls = new Map<string, string[]>();
let allowFlaky = false;
let holdResume = true;
let holdDetails = true;
let holdMerged = true;
let requireDashAuth = false;
const activeJobs = new Map<string, number>();
let maxActiveJobs = 0;
const crossOriginAuth: (string | undefined)[] = [];
const transports = new Map<string, string[]>();

describe('durable download pipeline', () => {
  beforeAll(async () => {
    const prepare = spawnSync(process.execPath, [resolve(root, 'tools/media-remux/prepare-test-media.mjs')], {
      encoding: 'utf8',
    });
    if (prepare.status !== 0) throw new Error(prepare.stderr);
    server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url!, 'http://localhost');
        const path = requestUrl.pathname;
        const hlsRanges = path.startsWith('/hls-ranges');
        const hlsParts = hlsRanges
          ? await Promise.all(
              ['init.mp4', 'segment-00.m4s', 'segment-01.m4s'].map(name =>
                readFile(resolve(fixtureRoot, 'hls-fmp4', name)),
              ),
            )
          : undefined;
        if (hlsParts && path.endsWith('.m3u8')) {
          const [init, first, second] = hlsParts;
          response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
          const media = path.includes('ignored') ? 'hls-ranges-ignored.mp4' : 'hls-ranges.mp4';
          response.end(
            `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="${media}",BYTERANGE="${init.length}@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:${first.length}@${init.length}\n${media}\n#EXTINF:1,\n#EXT-X-BYTERANGE:${second.length}\n${media}\n#EXT-X-ENDLIST\n`,
          );
          return;
        }
        if (path === '/watch') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<!doctype html><title>Credential fixture</title><p>Credential source</p>');
          return;
        }
        if (
          path === '/auth.mp4' &&
          request.headers.authorization !== `Bearer ${requestUrl.searchParams.get('account')}`
        ) {
          response.writeHead(401);
          response.end();
          return;
        }
        requests.push(path);
        if (requireDashAuth && path.startsWith('/dash') && request.headers.authorization !== 'Bearer D') {
          response.writeHead(401);
          response.end();
          return;
        }
        if (path === '/flaky.mp4' && !allowFlaky) {
          response.writeHead(503);
          response.end();
          return;
        }
        if (path === '/cross/master.m3u8') {
          if (request.headers.authorization !== 'Bearer source') {
            response.writeHead(401);
            response.end();
            return;
          }
          response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
          response.end(
            `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nhttp://localhost:${new URL(origin).port}/cross/variant.m3u8\n`,
          );
          return;
        }
        if (path.startsWith('/cross/')) crossOriginAuth.push(request.headers.authorization);
        if (path === '/cross/variant.m3u8') {
          response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
          response.end('#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n');
          return;
        }
        const large = [
          '/resume.mp4',
          '/restart.mp4',
          '/cancel.mp4',
          '/auth.mp4',
          '/concurrent.mp4',
          '/ignored.mp4',
          '/delivery.mp4',
          '/details.mp4',
          '/merged-resume-video.mp4',
        ].includes(path);
        const file = resolve(
          fixtureRoot,
          path === '/merged-resume-video.mp4'
            ? 'separate-video.mp4'
            : large || path === '/flaky.mp4'
              ? 'direct.mp4'
              : path === '/cross/segment.ts'
                ? 'hls-ts-h264.ts'
                : path === '/dash-layout/manifest.mpd'
                  ? 'dash/manifest.mpd'
                  : `.${path}`,
        );
        if (!file.startsWith(`${fixtureRoot}/`)) {
          response.writeHead(400);
          response.end();
          return;
        }
        let data = hlsParts ? Buffer.concat(hlsParts) : await readFile(file);
        if (path === '/dash-layout/manifest.mpd')
          data = Buffer.from(
            data
              .toString()
              .replace('<ProgramInformation>', `<BaseURL>${origin}/</BaseURL><ProgramInformation>`)
              .replace('<Period id="0" start="PT0.0S">', '<Period id="0" start="PT0.0S"><BaseURL>dash/</BaseURL>')
              .replace('d="12288" r="1"', 'd="12288" r="-1"'),
          );
        if (large) {
          const free = Buffer.alloc(6 * 1024 * 1024);
          free.writeUInt32BE(free.length, 0);
          free.write('free', 4);
          data = Buffer.concat([data, free]);
        }
        if (request.headers.range) rangeCalls.set(path, [...(rangeCalls.get(path) ?? []), request.headers.range]);
        const mime =
          {
            '.mp4': 'video/mp4',
            '.m4a': 'audio/mp4',
            '.m3u8': 'application/vnd.apple.mpegurl',
            '.mpd': 'application/dash+xml',
            '.ts': 'video/mp2t',
          }[extname(file)] ?? 'application/octet-stream';
        transports.set(path, [...(transports.get(path) ?? []), request.headers.range ?? 'full']);
        let range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        if ((path === '/ignored.mp4' && range?.[2] !== '0') || path === '/hls-ranges-ignored.mp4') range = undefined;
        const start = range ? Number(range[1]) : 0;
        const end = range ? Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1) : data.length - 1;
        response.writeHead(range ? 206 : 200, {
          'content-type': mime,
          'accept-ranges': 'bytes',
          etag: '"fixture-v1"',
          'content-length': end - start + 1,
          ...(range ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}),
        });
        if (!large || end === start) response.end(data.subarray(start, end + 1));
        else {
          const job = path === '/concurrent.mp4' ? requestUrl.searchParams.get('job') : undefined;
          if (job) {
            activeJobs.set(job, (activeJobs.get(job) ?? 0) + 1);
            maxActiveJobs = Math.max(maxActiveJobs, activeJobs.size);
          }
          let cursor = start;
          const timer = setInterval(
            () => {
              if (
                start > 0 &&
                ((path === '/resume.mp4' && holdResume) ||
                  (path === '/details.mp4' && holdDetails) ||
                  (path === '/merged-resume-video.mp4' && holdMerged))
              )
                return;
              const next = Math.min(cursor + 64 * 1024, end + 1);
              response.write(data.subarray(cursor, next));
              cursor = next;
              if (cursor > end) {
                clearInterval(timer);
                response.end();
              }
            },
            start === 0 ? 5 : 35,
          );
          response.on('close', () => {
            clearInterval(timer);
            if (job) {
              const count = activeJobs.get(job)! - 1;
              if (count) activeJobs.set(job, count);
              else activeJobs.delete(job);
            }
          });
        }
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    origin = `http://127.0.0.1:${address.port}`;
    await startBrowser();
  }, 90_000);
  afterEach(async () => {
    // A failed assertion must not leave a gated source occupying the next test's slots.
    await withNewPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      await page.evaluate(async () => {
        const runtime = (await chrome.storage.session.get('vidsy-download-runtime'))['vidsy-download-runtime'];
        for (const job of Object.values(runtime?.jobs ?? {}) as { requestId: string; state: string }[]) {
          if (!['succeeded', 'failed', 'cancelled'].includes(job.state))
            await chrome.runtime.sendMessage({
              type: 'media/cancel',
              payload: { key: job.requestId, intent: 'cancel' },
            });
        }
      });
    });
  });
  afterAll(async () => {
    await stopBrowser();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  for (const scenario of [
    { name: 'HTTP', kind: 'video', path: '/direct.mp4' },
    { name: 'HLS', kind: 'hls', path: '/hls-fmp4/playlist.m3u8' },
    { name: 'DASH', kind: 'dash', path: '/dash/manifest.mpd' },
    { name: 'separate audio/video', kind: 'video', path: '/separate-video.mp4', audio: '/separate-audio.m4a' },
  ]) {
    it(`downloads and validates ${scenario.name} through the production queue`, async () => {
      const key = crypto.randomUUID();
      await withNewPage(async page => {
        await page.goto(extensionUrl('popup.html'));
        const result = await page.evaluate(
          async ({ key, origin, scenario }) =>
            chrome.runtime.sendMessage({
              type: 'media/download',
              payload: {
                key,
                url: `${origin}${scenario.path}`,
                kind: scenario.kind,
                title: `Fixture ${scenario.name}`,
                fileName: `fixture-${key}`,
                audioUrl: scenario.audio ? `${origin}${scenario.audio}` : undefined,
                item: {
                  id: `media-${key}`,
                  url: `${origin}${scenario.path}`,
                  kind: scenario.kind,
                  title: `Fixture ${scenario.name}`,
                  pageUrl: `${origin}/watch`,
                  mimeType: 'video/mp4',
                  source: 'element',
                  detectedAt: Date.now(),
                },
              },
            }),
          { key, origin, scenario },
        );
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.queued).toBe(true);
      });
      await expect
        .poll(
          async () =>
            extensionWorker().evaluate(async key => {
              const progress = (await chrome.storage.session.get('media-downloads'))['media-downloads']?.[key];
              if (progress?.stage === 'failed') throw new Error(progress.error);
              return progress?.stage;
            }, key),
          { timeout: 60_000, interval: 100 },
        )
        .toBe('success');
      const progress = await extensionWorker().evaluate(
        async key => (await chrome.storage.session.get('media-downloads'))['media-downloads'][key],
        key,
      );
      expect(progress.item.title).toBe(`Fixture ${scenario.name}`);
      expect(progress.item.pageUrl).toBe(`${origin}/watch`);
      expect(progress.item.audioUrl).toBe(scenario.audio ? `${origin}${scenario.audio}` : undefined);
      const [download] = await extensionWorker().evaluate(
        async id => chrome.downloads.search({ id }),
        progress.downloadId,
      );
      expect((await stat(download.filename)).size).toBeGreaterThan(0);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', download.filename], {
        encoding: 'utf8',
      });
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout).streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ codec_type: 'video', codec_name: 'h264' }),
          expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
        ]),
      );
      await unlink(download.filename);
    }, 75_000);
  }
  for (const ignored of [false, true]) {
    it(
      ignored
        ? 'rejects an ignored HLS initialization range'
        : 'assembles a single-resource HLS playlist using exact byte ranges',
      async () => {
        const key = crypto.randomUUID();
        const path = ignored ? '/hls-ranges-ignored.m3u8' : '/hls-ranges.m3u8';
        await withNewPage(async page => {
          await page.goto(extensionUrl('popup.html'));
          const result = await page.evaluate(
            async ({ key, url }) =>
              chrome.runtime.sendMessage({ type: 'media/download', payload: { key, url, kind: 'hls', fileName: key } }),
            { key, url: `${origin}${path}` },
          );
          expect(result.ok, JSON.stringify(result)).toBe(true);
        });
        await expectStage(key, ignored ? 'failed' : 'success');
        if (!ignored) {
          const value = await progress(key);
          const [download] = await extensionWorker().evaluate(
            async id => chrome.downloads.search({ id }),
            value.downloadId,
          );
          const parts = await Promise.all(
            ['init.mp4', 'segment-00.m4s', 'segment-01.m4s'].map(name =>
              readFile(resolve(fixtureRoot, 'hls-fmp4', name)),
            ),
          );
          expect(await readFile(download.filename)).toEqual(Buffer.concat(parts));
          expect(transports.get('/hls-ranges.mp4')!.every(range => range !== 'full')).toBe(true);
          await unlink(download.filename);
        }
      },
    );
  }

  const submit = async (key: string, path: string, audioPath?: string) =>
    withNewPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      const result = await page.evaluate(
        async ({ key, url, audioUrl }) =>
          chrome.runtime.sendMessage({
            type: 'media/download',
            payload: { key, url, audioUrl, kind: 'video', fileName: key, title: `Control ${key}` },
          }),
        { key, url: `${origin}${path}`, audioUrl: audioPath ? `${origin}${audioPath}` : undefined },
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  const progress = (key: string) =>
    extensionWorker().evaluate(
      async key => (await chrome.storage.session.get('media-downloads'))['media-downloads']?.[key],
      key,
    );
  const control = async (key: string, type: string, intent: string) =>
    withNewPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      const result = await page.evaluate(async payload => chrome.runtime.sendMessage(payload), {
        type,
        payload: { key, intent },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  const uiControl = async (key: string, intent: 'Pause' | 'Resume' | 'Retry', path = 'popup.html') =>
    withNewPage(async page => {
      await page.goto(extensionUrl(path));
      await page.getByTitle('Downloads', { exact: true }).click();
      const row = page.locator('div.group').filter({ has: page.getByTitle(`Control ${key}`, { exact: true }) });
      if (intent === 'Pause') await row.getByTitle('Pause (remembers intent to resume)').click();
      else await row.getByRole('button', { name: intent, exact: true }).click();
    });
  const expectStage = async (key: string, stage: string) =>
    expect
      .poll(
        async () => {
          const item = await progress(key);
          if (item?.stage === 'failed' && stage !== 'failed') throw new Error(item.error);
          return item?.stage;
        },
        { timeout: 30_000, interval: 30 },
      )
      .toBe(stage);
  const removeOutput = async (key: string) => {
    const item = await progress(key);
    const [download] = await extensionWorker().evaluate(async id => chrome.downloads.search({ id }), item.downloadId);
    await unlink(download.filename);
  };

  it('rechecks an unknown start outcome after both start and inventory transport failures', async () => {
    const key = crypto.randomUUID();
    await extensionWorker().evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      Reflect.set(globalThis, '__vidsy_original_send_message', original);
      let rejectStart = true;
      let rejectInventory = false;
      Object.assign(chrome.runtime, {
        sendMessage: (message: { type?: string }, ...rest: unknown[]) => {
          if (message.type === 'offscreen/start-execution' && rejectStart) {
            rejectStart = false;
            rejectInventory = true;
            return Promise.reject(new Error('Injected startup transport failure'));
          }
          if (message.type === 'offscreen/executions' && rejectInventory) {
            rejectInventory = false;
            return Promise.reject(new Error('Injected inventory transport failure'));
          }
          return Reflect.apply(original, chrome.runtime, [message, ...rest]);
        },
      });
    });
    try {
      await submit(key, '/direct.mp4');
      await expect
        .poll(() => extensionWorker().evaluate(async () => Boolean(await chrome.alarms.get('vidsy-download-recovery'))))
        .toBe(true);
      const state = await extensionWorker().evaluate(async key => {
        const data = (await chrome.storage.session.get('vidsy-download-runtime'))['vidsy-download-runtime'];
        return Object.values(data.jobs).find((job: unknown) => (job as { requestId: string }).requestId === key) as {
          state: string;
          attempt: number;
        };
      }, key);
      expect(state.state).toBe('starting');
      expect(state.attempt).toBe(1);
      await extensionWorker().evaluate(async () => {
        await chrome.alarms.create('vidsy-download-recovery', { when: Date.now() + 100 });
      });
      await expectStage(key, 'success');
      const attempt = await extensionWorker().evaluate(async key => {
        const data = (await chrome.storage.session.get('vidsy-download-runtime'))['vidsy-download-runtime'];
        return (
          Object.values(data.jobs).find((job: unknown) => (job as { requestId: string }).requestId === key) as {
            attempt: number;
          }
        ).attempt;
      }, key);
      expect(attempt).toBe(2);
      await removeOutput(key);
    } finally {
      await extensionWorker().evaluate(() => {
        const original = Reflect.get(globalThis, '__vidsy_original_send_message');
        if (typeof original === 'function') Object.assign(chrome.runtime, { sendMessage: original });
      });
    }
  });

  it('pause and resume preserve completed byte ranges', async () => {
    await extensionWorker().evaluate(async () =>
      chrome.storage.local.set({ 'media-settings': { downloadConcurrency: 1, downloadConnectionsPerFile: 2 } }),
    );
    const key = crypto.randomUUID();
    await submit(key, '/resume.mp4');
    await expect
      .poll(async () => (await progress(key))?.chunks?.some((chunk: { status: string }) => chunk.status === 'done'), {
        timeout: 10_000,
        interval: 20,
      })
      .toBe(true);
    const completed = (await progress(key)).chunks.filter((chunk: { status: string }) => chunk.status === 'done');
    await uiControl(key, 'Pause');
    await expectStage(key, 'paused');
    holdResume = false;
    await uiControl(key, 'Resume', 'side-panel.html');
    await expectStage(key, 'success');
    for (const chunk of completed)
      expect(
        rangeCalls.get('/resume.mp4')!.filter(value => value === `bytes=${chunk.start}-${chunk.end}`),
      ).toHaveLength(1);
    await removeOutput(key);
  });

  it('resumes separate video and audio without refetching completed track ranges', async () => {
    const key = crypto.randomUUID();
    const audioBefore = rangeCalls.get('/separate-audio.m4a')?.length ?? 0;
    await submit(key, '/merged-resume-video.mp4', '/separate-audio.m4a');
    await expect
      .poll(() =>
        rangeCalls
          .get('/merged-resume-video.mp4')
          ?.find(range => range.startsWith('bytes=0-') && range !== 'bytes=0-0'),
      )
      .toBeTruthy();
    const firstVideoRange = rangeCalls
      .get('/merged-resume-video.mp4')!
      .find(range => range.startsWith('bytes=0-') && range !== 'bytes=0-0')!;
    const firstChunkSize = Number(firstVideoRange.split('-')[1]) + 1;
    const audioSize = (await stat(resolve(fixtureRoot, 'separate-audio.m4a'))).size;
    await expect
      .poll(async () => (await progress(key))?.downloadedBytes ?? 0, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(firstChunkSize + audioSize);
    await control(key, 'media/cancel', 'pause');
    await expectStage(key, 'paused');
    const audioRanges = rangeCalls
      .get('/separate-audio.m4a')!
      .slice(audioBefore)
      .filter(range => range !== 'bytes=0-0');
    expect(audioRanges).toHaveLength(1);
    holdMerged = false;
    await control(key, 'media/control', 'resume');
    await expectStage(key, 'success');
    expect(rangeCalls.get('/merged-resume-video.mp4')!.filter(range => range === firstVideoRange)).toHaveLength(1);
    expect(
      rangeCalls
        .get('/separate-audio.m4a')!
        .slice(audioBefore)
        .filter(range => range !== 'bytes=0-0'),
    ).toEqual(audioRanges);
    const item = await progress(key);
    const [download] = await extensionWorker().evaluate(async id => chrome.downloads.search({ id }), item.downloadId);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', download.filename], {
      encoding: 'utf8',
    });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout).streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_type: 'video', codec_name: 'h264' }),
        expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
      ]),
    );
    await removeOutput(key);
  });

  it('a failed request can retry, and a fresh request can download the same URL again', async () => {
    const key = crypto.randomUUID();
    await submit(key, '/flaky.mp4');
    await expectStage(key, 'failed');
    allowFlaky = true;
    await uiControl(key, 'Retry');
    await expectStage(key, 'success');
    const firstId = (await progress(key)).downloadId;
    const again = crypto.randomUUID();
    await submit(again, '/flaky.mp4');
    await expectStage(again, 'success');
    expect((await progress(again)).downloadId).not.toBe(firstId);
    await removeOutput(key);
    await removeOutput(again);
  });

  it('cancels queued work before network dispatch and removes cancelled partial files', async () => {
    const running = crypto.randomUUID();
    const queued = crypto.randomUUID();
    await submit(running, '/cancel.mp4');
    await expect.poll(async () => (await progress(running))?.stage, { timeout: 10_000 }).toBe('download-video');
    const before = requests.filter(path => path === '/direct.mp4').length;
    await submit(queued, '/direct.mp4');
    await expectStage(queued, 'queued');
    await control(queued, 'media/cancel', 'cancel');
    await expectStage(queued, 'cancelled');
    expect(requests.filter(path => path === '/direct.mp4').length).toBe(before);
    await control(running, 'media/cancel', 'cancel');
    await expectStage(running, 'cancelled');
    await withNewPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      await expect
        .poll(
          async () =>
            page.evaluate(async key => {
              const root = await navigator.storage.getDirectory();
              const names: string[] = [];
              for await (const name of (
                root as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }
              ).keys())
                names.push(name);
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
              const owner = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
              return names.some(name => name.includes(owner));
            }, running),
          { timeout: 5000 },
        )
        .toBe(false);
    });
  });

  const restartBackground = async () => {
    await withNewPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      const session = await page.context().newCDPSession(page);
      await session.send('ServiceWorker.enable');
      const oldWorker = extensionWorker();
      const marker = crypto.randomUUID();
      await oldWorker.evaluate(marker => Reflect.set(globalThis, '__vidsy_test_restart', marker), marker);
      const { targetInfos } = await session.send('Target.getTargets');
      const target = targetInfos.find(target => target.type === 'service_worker' && target.url === oldWorker.url());
      if (!target) throw new Error('Background target missing');
      await session.send('Target.closeTarget', { targetId: target.targetId });
      await session.detach();
      await page.evaluate(async () => chrome.runtime.sendMessage({ type: 'media/get-tab-id' }));
      await expect
        .poll(async () => extensionWorker().evaluate(() => Reflect.get(globalThis, '__vidsy_test_restart')), {
          timeout: 5000,
        })
        .toBeUndefined();
    });
  };

  it('reattaches to a running offscreen execution after the background stops', async () => {
    const key = crypto.randomUUID();
    await submit(key, '/restart.mp4');
    await expect.poll(async () => (await progress(key))?.stage, { timeout: 10_000 }).toBe('download-video');
    await restartBackground();
    await expectStage(key, 'success');
    const job = await extensionWorker().evaluate(
      async key =>
        Object.values((await chrome.storage.session.get('vidsy-download-runtime'))['vidsy-download-runtime'].jobs).find(
          (job: unknown) => (job as { requestId: string }).requestId === key,
        ) as { attempt: number },
      key,
    );
    expect(job.attempt).toBe(1);
    const calls = rangeCalls.get('/restart.mp4')!;
    expect(new Set(calls).size).toBe(calls.length);
    await removeOutput(key);
  });

  it('isolates captured credentials for concurrent requests on the same CDN', async () => {
    await extensionWorker().evaluate(async () =>
      chrome.storage.local.set({ 'media-settings': { downloadConcurrency: 2, downloadConnectionsPerFile: 2 } }),
    );
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await withNewPage(async sourceA => {
      await sourceA.goto(`${origin}/watch?account=A`);
      await sourceA.evaluate(async origin => {
        const response = await fetch(`${origin}/auth.mp4?account=A`, { headers: { Authorization: 'Bearer A' } });
        await response.body?.cancel();
      }, origin);
      await withNewPage(async sourceB => {
        await sourceB.goto(`${origin}/watch?account=B`);
        await sourceB.evaluate(async origin => {
          const response = await fetch(`${origin}/auth.mp4?account=B`, { headers: { Authorization: 'Bearer B' } });
          await response.body?.cancel();
        }, origin);
        await withNewPage(async popup => {
          await popup.goto(extensionUrl('popup.html'));
          for (const [key, account] of [
            [first, 'A'],
            [second, 'B'],
          ]) {
            const result = await popup.evaluate(
              async ({ key, origin, account }) => {
                const [tab] = await chrome.tabs.query({ url: `${origin}/watch?account=${account}` });
                return chrome.runtime.sendMessage({
                  type: 'media/download',
                  payload: {
                    key,
                    url: `${origin}/auth.mp4?account=${account}`,
                    tabId: tab.id,
                    kind: 'video',
                    fileName: key,
                  },
                });
              },
              { key, origin, account },
            );
            expect(result.ok, JSON.stringify(result)).toBe(true);
          }
          await expectStage(second, 'queued');
          await restartBackground();
          await expectStage(first, 'success');
          await expectStage(second, 'success');
          expect(
            await popup.evaluate(
              async () => (await chrome.declarativeNetRequest.getSessionRules()).filter(rule => rule.id >= 1000).length,
            ),
          ).toBe(0);
        });
      });
    });
    await removeOutput(first);
    await removeOutput(second);
  });

  it('limits actual concurrent public downloads to the configured two jobs', async () => {
    const keys = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const key of keys) await submit(key, `/concurrent.mp4?job=${key}`);
    await expectStage(keys[2], 'queued');
    for (const key of keys) {
      await expectStage(key, 'success');
      await removeOutput(key);
    }
    expect(maxActiveJobs).toBe(2);
  });

  it('falls back safely when a server ignores a Range request', async () => {
    const key = crypto.randomUUID();
    await submit(key, '/ignored.mp4');
    await expectStage(key, 'success');
    const item = await progress(key);
    expect(item.transferMode).toBe('stream');
    expect(item.fallbackReason).toContain('Invalid Range');
    expect(transports.get('/ignored.mp4')!.filter(value => value === 'full')).toHaveLength(1);
    const [download] = await extensionWorker().evaluate(async id => chrome.downloads.search({ id }), item.downloadId);
    const free = Buffer.alloc(6 * 1024 * 1024);
    free.writeUInt32BE(free.length, 0);
    free.write('free', 4);
    expect(await readFile(download.filename)).toEqual(
      Buffer.concat([await readFile(resolve(fixtureRoot, 'direct.mp4')), free]),
    );
    await unlink(download.filename);
  });

  it('does not forward source credentials to a cross-origin HLS rendition', async () => {
    const key = crypto.randomUUID();
    await withNewPage(async source => {
      await source.goto(`${origin}/watch?account=cross`);
      await source.evaluate(async origin => {
        const response = await fetch(`${origin}/cross/master.m3u8`, { headers: { Authorization: 'Bearer source' } });
        await response.body?.cancel();
      }, origin);
      await withNewPage(async popup => {
        await popup.goto(extensionUrl('popup.html'));
        const result = await popup.evaluate(
          async ({ key, origin }) => {
            const [tab] = await chrome.tabs.query({ url: `${origin}/watch?account=cross` });
            return chrome.runtime.sendMessage({
              type: 'media/download',
              payload: { key, url: `${origin}/cross/master.m3u8`, tabId: tab.id, kind: 'hls', fileName: key },
            });
          },
          { key, origin },
        );
        expect(result.ok, JSON.stringify(result)).toBe(true);
        await expectStage(key, 'success');
        expect(crossOriginAuth.length).toBeGreaterThan(0);
        expect(crossOriginAuth.every(value => value === undefined)).toBe(true);
      });
    });
    await removeOutput(key);
  });
  it('pauses during delayed browser acceptance and resumes from the retained artifact', async () => {
    const key = crypto.randomUUID();
    await extensionWorker().evaluate(async () => {
      await chrome.storage.session.remove('native-delivery-held');
      const search = chrome.downloads.search.bind(chrome.downloads);
      Reflect.set(globalThis, '__vidsy_original_download_search', search);
      let held = false;
      // Inject only IPC latency, preserving the real downloads API result.
      Object.assign(chrome.downloads, {
        search: async (query: chrome.downloads.DownloadQuery) => {
          if (!held && query.url?.startsWith('^blob:')) {
            held = true;
            await chrome.storage.session.set({ 'native-delivery-held': true });
            await new Promise<void>(resolve => Reflect.set(globalThis, '__vidsy_release_delivery', resolve));
          }
          return search(query);
        },
      });
    });
    try {
      await submit(key, '/delivery.mp4');
      await expect
        .poll(
          async () =>
            extensionWorker().evaluate(
              async () => (await chrome.storage.session.get('native-delivery-held'))['native-delivery-held'],
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      await expectStage(key, 'finalize');
      const count = transports.get('/delivery.mp4')!.length;
      await control(key, 'media/cancel', 'pause');
      await expectStage(key, 'paused');
      const staleCommand = await extensionWorker().evaluate(async key => {
        const response = await chrome.runtime.sendMessage({ type: 'offscreen/executions' });
        return response.records.find((record: { command: { requestId: string } }) => record.command.requestId === key)
          .command;
      }, key);
      await withNewPage(async page => {
        await page.goto(extensionUrl('popup.html'));
        await page.evaluate(
          async command =>
            chrome.runtime.sendMessage({
              type: 'offscreen/execution-event',
              payload: { command, type: 'progress', progress: { stage: 'download-video', downloadedBytes: 1 } },
            }),
          staleCommand,
        );
      });
      await expectStage(key, 'paused');
      await restartBackground();
      await expectStage(key, 'paused');
      await control(key, 'media/control', 'resume');
      await expectStage(key, 'success');
      expect(transports.get('/delivery.mp4')!.length).toBe(count);
      await removeOutput(key);
    } finally {
      await extensionWorker().evaluate(() => {
        Reflect.get(globalThis, '__vidsy_release_delivery')?.();
        const original = Reflect.get(globalThis, '__vidsy_original_download_search');
        if (typeof original === 'function') Object.assign(chrome.downloads, { search: original });
      });
    }
  });
  it('releases a finalizing task when its browser download record is missing', async () => {
    const key = crypto.randomUUID();
    await extensionWorker().evaluate(() => {
      const original = chrome.downloads.search.bind(chrome.downloads);
      Reflect.set(globalThis, '__vidsy_missing_search', original);
      Object.assign(chrome.downloads, {
        search: (query: { id?: number; url?: string }) =>
          query.id === undefined ? original(query) : Promise.resolve([]),
      });
    });
    try {
      await submit(key, '/direct.mp4');
      await expectStage(key, 'failed');
      expect((await progress(key)).error).toContain('Browser download record unavailable');
    } finally {
      await extensionWorker().evaluate(() => {
        const original = Reflect.get(globalThis, '__vidsy_missing_search');
        if (typeof original === 'function') Object.assign(chrome.downloads, { search: original });
      });
    }
    const downloadId = (await progress(key)).downloadId;
    const [download] = await extensionWorker().evaluate(async id => chrome.downloads.search({ id }), downloadId);
    if (download?.filename) await unlink(download.filename).catch(() => undefined);
    const next = crypto.randomUUID();
    await submit(next, '/direct.mp4');
    await expectStage(next, 'success');
    await removeOutput(next);
  });

  it('clears terminal task records without blocking the next download', async () => {
    const key = crypto.randomUUID();
    await submit(key, '/direct.mp4');
    await expectStage(key, 'success');
    const before = (await progress(key)).downloadId;
    await removeOutput(key);
    await withNewPage(async page => {
      await page.goto(extensionUrl('popup.html'));
      await page.evaluate(
        async key => chrome.runtime.sendMessage({ type: 'media/clear-downloads', payload: { keys: [key] } }),
        key,
      );
    });
    expect(await progress(key)).toBeUndefined();
    expect(
      await extensionWorker().evaluate(
        async key =>
          Object.values(
            (await chrome.storage.session.get('vidsy-download-runtime'))['vidsy-download-runtime'].jobs,
          ).some((job: unknown) => (job as { requestId: string }).requestId === key),
        key,
      ),
    ).toBe(false);
    await submit(key, '/direct.mp4');
    await expectStage(key, 'success');
    expect((await progress(key)).downloadId).not.toBe(before);
    await removeOutput(key);
  });
  for (const dashPath of ['/dash/manifest.mpd', '/dash-layout/manifest.mpd']) {
    it(`downloads an authenticated DASH template with padded segment numbers: ${dashPath}`, async () => {
      const key = crypto.randomUUID();
      requireDashAuth = true;
      try {
        await withNewPage(async source => {
          await source.goto(`${origin}/watch?account=DASH`);
          await source.evaluate(
            async ({ origin, dashPath }) => {
              const response = await fetch(`${origin}${dashPath}?account=D`, {
                headers: { Authorization: 'Bearer D' },
              });
              await response.body?.cancel();
            },
            { origin, dashPath },
          );
          await withNewPage(async popup => {
            await popup.goto(extensionUrl('popup.html'));
            const response = await popup.evaluate(
              async ({ key, origin, dashPath }) => {
                const [tab] = await chrome.tabs.query({ url: `${origin}/watch?account=DASH` });
                return chrome.runtime.sendMessage({
                  type: 'media/download',
                  payload: {
                    key,
                    url: `${origin}${dashPath}?account=D`,
                    kind: 'dash',
                    tabId: tab.id,
                    fileName: key,
                  },
                });
              },
              { key, origin, dashPath },
            );
            expect(response.ok, JSON.stringify(response)).toBe(true);
            await expectStage(key, 'success');
          });
        });
        await removeOutput(key);
      } finally {
        requireDashAuth = false;
      }
    });
  }
  it('standalone controls resume the same task and create a fresh identity after cancellation', async () => {
    const first = crypto.randomUUID();
    await submit(first, '/details.mp4');
    await expect
      .poll(async () => (await progress(first))?.chunks?.some((chunk: { status: string }) => chunk.status === 'done'), {
        timeout: 10_000,
      })
      .toBe(true);
    await withNewPage(async page => {
      await page.goto(extensionUrl(`popup.html?dlKey=${first}#download-details`));
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await expectStage(first, 'paused');
      holdDetails = false;
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await expectStage(first, 'success');
      expect(new URL(page.url()).searchParams.get('dlKey')).toBe(first);
    });
    await removeOutput(first);
    holdDetails = true;
    const cancelled = crypto.randomUUID();
    await submit(cancelled, '/details.mp4');
    await expect
      .poll(
        async () => (await progress(cancelled))?.chunks?.some((chunk: { status: string }) => chunk.status === 'done'),
        { timeout: 10_000 },
      )
      .toBe(true);
    await withNewPage(async page => {
      await page.goto(extensionUrl(`popup.html?dlKey=${cancelled}#download-details`));
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expectStage(cancelled, 'cancelled');
      holdDetails = false;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get('dlKey')).not.toBe(cancelled);
      const next = new URL(page.url()).searchParams.get('dlKey')!;
      expect(next).toBeTruthy();
      await expectStage(next, 'success');
      expect((await progress(next)).item.url).toBe(`${origin}/details.mp4`);
      await removeOutput(next);
    });
  });
  it('popup, side panel and options clear history through the background writer', async () => {
    for (const path of ['popup.html', 'side-panel.html', 'options.html']) {
      const key = crypto.randomUUID();
      await submit(key, '/direct.mp4');
      await expectStage(key, 'success');
      await removeOutput(key);
      await withNewPage(async page => {
        await page.goto(extensionUrl(path === 'popup.html' ? 'popup.html#history' : path));
        if (path === 'options.html') await page.getByRole('button', { name: 'History', exact: true }).click();
        else if (path !== 'popup.html') await page.getByTitle('History', { exact: true }).click();
        await page.getByRole('button', { name: 'Clear all', exact: true }).click();
        await expect
          .poll(() =>
            extensionWorker().evaluate(async () => (await chrome.storage.local.get('media-history'))['media-history']),
          )
          .toEqual([]);
      });
    }
  });
});
