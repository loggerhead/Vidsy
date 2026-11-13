import { extensionUrl, extensionWorker, startBrowser, stopBrowser, withNewPage, withPage } from '../helpers/browser.js';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DownloadJob } from '../../../chrome-extension/src/background/lib/download-runtime';
import type { CacheRecord } from '../../../chrome-extension/src/offscreen/lib/cache-protocol';
import type { Server } from 'node:http';

let server: Server, origin: string, profile: string, data: Buffer;
const previousProfile = process.env.VIDSY_E2E_PROFILE_DIR,
  previousNative = process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD;
const allowed = new Set<string>(),
  expired = new Set<string>();
const requests: { path: string; range?: string }[] = [];
beforeAll(async () => {
  const media = await readFile(resolve(import.meta.dirname, '../../../.media-test/fixtures/direct.mp4'));
  const free = Buffer.alloc(6 * 1024 * 1024);
  free.writeUInt32BE(free.length, 0);
  free.write('free', 4);
  data = Buffer.concat([media, free]);
  server = createServer((request, response) => {
    const address = new URL(request.url!, 'http://fixture');
    const path = address.pathname;
    if (path === '/watch') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Source context</title>');
      return;
    }
    requests.push({ path, range: request.headers.range });
    if (expired.has(path) && address.searchParams.get('token') !== 'new') {
      response.writeHead(403);
      response.end('Expired signature');
      return;
    }
    const stream = path.includes('stream');
    const range = !stream && request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0,
      end = range ? Math.min(Number(range[2] || data.length - 1), data.length - 1) : data.length - 1;
    response.writeHead(range ? 206 : 200, {
      etag: '"m5-v1"',
      'content-type': 'video/mp4',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    let cursor = start;
    const timer = setInterval(() => {
      if (!allowed.has(path) && (stream ? cursor >= 1.5 * 1024 * 1024 : start > 0 && end > start)) return;
      const next = Math.min(cursor + 64 * 1024, end + 1);
      response.write(data.subarray(cursor, next));
      cursor = next;
      if (cursor > end) {
        clearInterval(timer);
        response.end();
      }
    }, 2);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  origin = `http://127.0.0.1:${address.port}`;
  profile = await mkdtemp(join(tmpdir(), 'uuget-resume-m5-'));
  process.env.VIDSY_E2E_PROFILE_DIR = profile;
  process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD = 'true';
  await startBrowser();
  await extensionWorker().evaluate(() =>
    chrome.storage.local.set({
      'media-settings': {
        downloadConcurrency: 1,
        downloadConnectionsPerFile: 1,
        pauseOnMeteredNetwork: true,
        manuallyMetered: false,
      },
    }),
  );
});
afterEach(async () => {
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({
        type: 'offscreen/network-cost',
        payload: { supported: false, metered: false },
      });
      const state = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
      for (const job of Object.values(state?.jobs ?? {}) as { requestId: string; state: string }[])
        if (!['cancelled', 'succeeded'].includes(job.state))
          await chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key: job.requestId, intent: 'cancel' } });
      const settings = (await chrome.storage.local.get('media-settings'))['media-settings'];
      await chrome.storage.local.set({
        'media-settings': { ...settings, manuallyMetered: false, cacheRetentionDays: 7 },
      });
    });
  });
});
afterAll(async () => {
  await stopBrowser();
  if (previousProfile === undefined) delete process.env.VIDSY_E2E_PROFILE_DIR;
  else process.env.VIDSY_E2E_PROFILE_DIR = previousProfile;
  if (previousNative === undefined) delete process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD;
  else process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD = previousNative;
  if (profile) await rm(profile, { recursive: true, force: true });
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});
const progress = (key: string) =>
  extensionWorker().evaluate(
    async key => (await chrome.storage.local.get('media-downloads'))['media-downloads']?.[key],
    key,
  );
const job = (key: string) =>
  extensionWorker().evaluate(async key => {
    const state = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
    return Object.values(state.jobs as Record<string, DownloadJob>).find((job: DownloadJob) => job.requestId === key)!;
  }, key);
const stage = (key: string, expected: string) =>
  expect.poll(async () => (await progress(key))?.stage, { timeout: 20000 }).toBe(expected);
const send = (message: object) =>
  withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    expect((await page.evaluate(message => chrome.runtime.sendMessage(message), message)).ok).toBe(true);
  });
const submit = (key: string, path: string) =>
  send({ type: 'media/download', payload: { key, url: origin + path, title: key, fileName: key, kind: 'video' } });
const half = async (key: string, path: string) => {
  await submit(key, path);
  await expect
    .poll(
      async () => (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
      {
        timeout: 15000,
      },
    )
    .toBe(1);
};
const verify = async (key: string) => {
  await stage(key, 'success');
  const [download] = await extensionWorker().evaluate(
    async id => chrome.downloads.search({ id }),
    (await progress(key)).downloadId,
  );
  expect(await readFile(download.filename)).toEqual(data);
  await unlink(download.filename);
};

it('paused details distinguish visible progress from verified cache, next offset and remaining payload', async () => {
  const key = crypto.randomUUID(),
    path = '/details.mp4';
  await half(key, path);
  await send({ type: 'media/cancel', payload: { key, intent: 'pause' } });
  await stage(key, 'paused');
  const p = await progress(key);
  expect(p.cachedBytes).toBe(Math.ceil(data.length / 2));
  expect(p.nextRangeOffset).toBe(p.cachedBytes);
  expect(p.remainingDownloadBytes).toBe(data.length - p.cachedBytes);
  await withNewPage(async page => {
    await page.goto(extensionUrl(`popup.html?dlKey=${key}#download-details`));
    await expect.poll(() => page.locator('body').innerText()).toContain('Cached media:');
    expect(await page.locator('body').innerText()).toContain(`Next payload byte offset: ${p.nextRangeOffset}`);
    expect(await page.getByRole('button', { name: 'Resume', exact: true }).count()).toBe(1);
  });
});

it('popup Pause all includes queued work and side-panel Resume all preserves configured concurrency', async () => {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  await half(first, '/batch-one.mp4');
  await submit(second, '/batch-two.mp4');
  await stage(second, 'queued');
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.getByRole('button', { name: 'Pause all', exact: true }).click();
  });
  await stage(first, 'paused');
  await stage(second, 'paused');
  expect((await job(second)).attempt).toBe(0);
  expect(requests.filter(request => request.path === '/batch-two.mp4')).toEqual([]);
  allowed.add('/batch-one.mp4');
  allowed.add('/batch-two.mp4');
  await withNewPage(async page => {
    await page.goto(extensionUrl('side-panel.html'));
    await page.getByTitle('Downloads', { exact: true }).click();
    await page.getByRole('button', { name: 'Resume all', exact: true }).click();
  });
  await verify(first);
  await verify(second);
});

it('settings expose cache usage, persistent-storage outcome, update existing TTL and discard only paused files', async () => {
  const key = crypto.randomUUID();
  await half(key, '/cache.mp4');
  await send({ type: 'media/cancel', payload: { key, intent: 'pause' } });
  await stage(key, 'paused');
  await withNewPage(async page => {
    await page.goto(extensionUrl('options.html'));
    await expect.poll(() => page.locator('body').innerText()).toContain('Partial download cache');
    await expect.poll(() => page.locator('body').innerText()).toContain(key);
    expect(await page.locator('body').innerText()).toMatch(/Persistent storage granted|Browser-managed storage/);
    await page.getByLabel('Cache retention days').fill('2');
    await expect
      .poll(async () =>
        extensionWorker().evaluate(async key => {
          const records = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records;
          const record = Object.values(records as Record<string, CacheRecord>).find(
            (record: CacheRecord) => record.jobKey === key,
          )!;
          return record.expiresAt - record.updatedAt;
        }, key),
      )
      .toBe(2 * 86400000);
    await page.getByRole('button', { name: 'Discard paused / failed cache', exact: true }).click();
    await stage(key, 'cancelled');
    await expect
      .poll(async () =>
        extensionWorker().evaluate(async key => {
          const records = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records;
          return Object.values(records as Record<string, CacheRecord>).filter(
            (record: CacheRecord) => record.jobKey === key,
          ).length;
        }, key),
      )
      .toBe(0);
  });
});

it('cancel after an interrupted executor restart cleans cache even when its execution identity was lost', async () => {
  const key = crypto.randomUUID();
  await half(key, '/interrupted-clear.mp4');
  const names = await extensionWorker().evaluate(async key => {
    const ledger = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'];
    return Object.values(ledger.records as Record<string, CacheRecord>)
      .filter((record: CacheRecord) => record.jobKey === key)
      .map((record: CacheRecord) => record.name);
  }, key);
  expect(names.length).toBeGreaterThan(0);
  await stopBrowser();
  await startBrowser();
  await stage(key, 'paused');
  expect((await job(key)).executionId).toBeUndefined();
  await send({ type: 'media/cancel', payload: { key, intent: 'cancel' } });
  await stage(key, 'cancelled');
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    const remaining = await page.evaluate(async names => {
      const root = await navigator.storage.getDirectory();
      const files: string[] = [];
      for await (const name of (root as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }).keys())
        files.push(name);
      return files.filter(name => names.includes(name));
    }, names);
    expect(remaining).toEqual([]);
  });
});

it('a paused download associated with its original page survives a complete browser restart', async () => {
  const key = crypto.randomUUID(),
    url = origin + '/source-context.mp4',
    pageUrl = origin + '/watch';
  await withPage(async page => {
    await page.goto(pageUrl);
  });
  const tabId = await extensionWorker().evaluate(async url => (await chrome.tabs.query({ url }))[0].id!, pageUrl);
  await send({
    type: 'media/download',
    payload: {
      key,
      url,
      kind: 'video',
      tabId,
      fileName: key,
      item: { id: key, url, title: key, kind: 'video', tabId, pageUrl, source: 'network', detectedAt: Date.now() },
    },
  });
  await expect
    .poll(
      async () => (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
      {
        timeout: 15000,
      },
    )
    .toBe(1);
  await send({ type: 'media/cancel', payload: { key, intent: 'pause' } });
  await stage(key, 'paused');
  const cached = (await progress(key)).cachedBytes;
  await stopBrowser();
  await startBrowser();
  await stage(key, 'paused');
  expect((await progress(key)).cachedBytes).toBe(cached);
});

it('after browser restart an exact reopened source page renews an expired URL despite a stale tab ID', async () => {
  const key = crypto.randomUUID(),
    path = '/restart-renewal.mp4',
    pageUrl = origin + '/watch';
  await withPage(async page => {
    await page.goto(pageUrl);
  });
  const tabId = await extensionWorker().evaluate(async url => (await chrome.tabs.query({ url }))[0].id!, pageUrl);
  const url = origin + path + '?token=old';
  await send({
    type: 'media/download',
    payload: {
      key,
      url,
      kind: 'video',
      tabId,
      fileName: key,
      item: { id: key, url, title: key, kind: 'video', tabId, pageUrl, source: 'network', detectedAt: Date.now() },
    },
  });
  await expect
    .poll(
      async () => (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
      {
        timeout: 15000,
      },
    )
    .toBe(1);
  await send({ type: 'media/cancel', payload: { key, intent: 'pause' } });
  await stage(key, 'paused');
  const cached = (await progress(key)).cachedBytes;
  // Seed a stale persisted ID deterministically; the browser restart and OPFS reuse are real.
  await extensionWorker().evaluate(async key => {
    const state = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
    const job = Object.values(state.jobs as Record<string, DownloadJob>).find(
      (job: DownloadJob) => job.requestId === key,
    )!;
    job.display.tabId = 999999;
    await chrome.storage.local.set({ 'vidsy-download-runtime': state });
  }, key);
  await stopBrowser();
  await startBrowser();
  await stage(key, 'paused');
  expect((await progress(key)).cachedBytes).toBe(cached);
  expired.add(path);
  allowed.add(path);
  await withPage(async page => {
    await page.goto(pageUrl);
    await page.evaluate(
      url => {
        const video = document.createElement('video');
        video.preload = 'none';
        video.src = url;
        document.body.append(video);
      },
      origin + path + '?token=new',
    );
    const currentTabId = await extensionWorker().evaluate(
      async url => (await chrome.tabs.query({ url }))[0].id!,
      pageUrl,
    );
    expect(currentTabId).not.toBe(999999);
    const before = requests.length;
    await send({ type: 'media/control', payload: { key, intent: 'resume' } });
    await verify(key);
    const renewed = await job(key);
    expect(renewed.display.tabId).toBe(currentTabId);
    expect(renewed.execution.url).toBe(origin + path + '?token=new');
    expect(renewed.diagnostics.filter((event: { event: string }) => event.event === 'source-renewed')).toHaveLength(1);
    const resumedPayload = requests
      .slice(before)
      .filter(request => request.path === path && request.range)
      .map(request => request.range!.match(/^bytes=(\d+)-(\d+)$/)!)
      .filter(Boolean)
      .filter(match => Number(match[2]) - Number(match[1]) + 1 > 32768);
    expect(resumedPayload.length).toBeGreaterThan(0);
    expect(resumedPayload.every(match => Number(match[1]) >= cached)).toBe(true);
  });
});

it('a reported cellular transition pauses valid cache without recovery and explicit Resume allows this connection', async () => {
  const key = crypto.randomUUID(),
    path = '/metered.mp4';
  await half(key, path);
  await send({ type: 'offscreen/network-cost', payload: { supported: true, metered: true } });
  await stage(key, 'paused');
  expect((await job(key)).recovery).toBeUndefined();
  expect((await progress(key)).resumeNotice).toContain('metered');
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.context().setOffline(true);
    await page.context().setOffline(false);
  });
  expect((await job(key)).state).toBe('paused');
  allowed.add(path);
  await send({ type: 'media/control', payload: { key, intent: 'resume' } });
  await verify(key);
});

it('manual metered fallback pauses active work and holds new downloads before network dispatch', async () => {
  const key = crypto.randomUUID(),
    queued = crypto.randomUUID();
  await half(key, '/manual-metered.mp4');
  await withNewPage(async page => {
    await page.goto(extensionUrl('options.html'));
    await page.getByLabel('Current connection is metered').check();
  });
  await stage(key, 'paused');
  await submit(queued, '/held.mp4');
  await stage(queued, 'paused');
  expect(requests.filter(request => request.path === '/held.mp4')).toEqual([]);
  allowed.add('/held.mp4');
  await send({ type: 'media/control', payload: { key: queued, intent: 'resume' } });
  await verify(queued);
});

it('a non-Range source offers Stop; a batch pause explicitly resumes by downloading the whole stream again', async () => {
  const key = crypto.randomUUID(),
    path = '/stream.mp4';
  await submit(key, path);
  await expect
    .poll(async () => (await progress(key))?.downloadedBytes ?? 0, { timeout: 15000 })
    .toBeGreaterThanOrEqual(1.5 * 1024 * 1024);
  await withNewPage(async page => {
    await page.goto(extensionUrl(`popup.html?dlKey=${key}#download-details`));
    expect(await page.getByRole('button', { name: 'Pause', exact: true }).count()).toBe(0);
    await expect
      .poll(() => page.getByRole('button', { name: 'Stop (cannot resume bytes)', exact: true }).count())
      .toBe(1);
  });
  await send({ type: 'media/pause-all' });
  await stage(key, 'paused');
  expect((await progress(key)).cachedBytes).toBe(0);
  await withNewPage(async page => {
    await page.goto(extensionUrl(`popup.html?dlKey=${key}#download-details`));
    await expect
      .poll(() => page.getByRole('button', { name: 'Resume (downloads again)', exact: true }).count())
      .toBe(1);
  });
  const before = requests.length;
  allowed.add(path);
  await send({ type: 'media/control', payload: { key, intent: 'resume' } });
  await verify(key);
  expect(
    requests.slice(before).some(request => request.path === path && request.range === undefined),
    JSON.stringify(requests.slice(before)),
  ).toBe(true);
});
