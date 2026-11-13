import { extensionUrl, extensionWorker, startBrowser, stopBrowser, withNewPage } from '../helpers/browser.js';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';

let server: Server, origin: string, profile: string, data: Buffer;
const previousProfile = process.env.VIDSY_E2E_PROFILE_DIR;
const previousNativeLoad = process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD;
const allowed = new Set<string>();
const requests: { path: string; range?: string; method?: string }[] = [];

beforeAll(async () => {
  const media = await readFile(resolve(import.meta.dirname, '../../../.media-test/fixtures/direct.mp4'));
  const free = Buffer.alloc(6 * 1024 * 1024);
  free.writeUInt32BE(free.length, 0);
  free.write('free', 4);
  data = Buffer.concat([media, free]);
  server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    requests.push({ path, range: request.headers.range, method: request.method });
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(Number(range[2] || data.length - 1), data.length - 1) : data.length - 1;
    if (path === '/wake.mp4' && start > 0 && !allowed.has(path)) {
      response.destroy();
      return;
    }
    if (path === '/forbidden.mp4' && start > 0) {
      response.writeHead(403);
      response.end();
      return;
    }
    response.writeHead(range ? 206 : 200, {
      etag: '"persistent-v1"',
      'content-type': 'video/mp4',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    if (start === end) {
      response.end(data.subarray(start, end + 1));
      return;
    }
    let cursor = start;
    const timer = setInterval(() => {
      if (start > 0 && !allowed.has(path)) return;
      const next = Math.min(cursor + 64 * 1024, end + 1);
      response.write(data.subarray(cursor, next));
      cursor = next;
      if (cursor > end) {
        clearInterval(timer);
        response.end();
      }
    }, 5);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  profile = await mkdtemp(join(tmpdir(), 'uuget-resume-m2-'));
  process.env.VIDSY_E2E_PROFILE_DIR = profile;
  process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD = 'true';
  await startBrowser();
  await extensionWorker().evaluate(async () =>
    chrome.storage.local.set({ 'media-settings': { downloadConcurrency: 1, downloadConnectionsPerFile: 1 } }),
  );
});

afterAll(async () => {
  await stopBrowser();
  if (previousProfile === undefined) delete process.env.VIDSY_E2E_PROFILE_DIR;
  else process.env.VIDSY_E2E_PROFILE_DIR = previousProfile;
  if (previousNativeLoad === undefined) delete process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD;
  else process.env.VIDSY_E2E_NATIVE_EXTENSION_LOAD = previousNativeLoad;
  if (profile) await rm(profile, { recursive: true, force: true });
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

afterEach(async () => {
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(async () => {
      const runtime = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
      for (const job of Object.values(runtime.jobs) as { requestId: string; state: string }[])
        if (!['succeeded', 'cancelled'].includes(job.state))
          await chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key: job.requestId, intent: 'cancel' } });
    });
  });
});

const progress = (key: string) =>
  extensionWorker().evaluate(
    async key => (await chrome.storage.local.get('media-downloads'))['media-downloads']?.[key],
    key,
  );
const stage = (key: string, expected: string) =>
  expect
    .poll(
      async () => {
        const entry = await progress(key);
        if (entry?.stage === 'failed' && expected !== 'failed') throw new Error(entry.error);
        return entry?.stage;
      },
      { timeout: 15_000 },
    )
    .toBe(expected);
const submit = async (key: string, path: string) => {
  let result!: { key: string; resumed?: boolean; ok: boolean };
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    result = await page.evaluate(
      async ({ key, url }) =>
        chrome.runtime.sendMessage({
          type: 'media/download',
          payload: { key, url, kind: 'video', fileName: key, title: `Persistent ${key}` },
        }),
      { key, url: `${origin}${path}` },
    );
  });
  return result;
};
const verifyOutput = async (key: string) => {
  await stage(key, 'success');
  const [download] = await extensionWorker().evaluate(
    async id => chrome.downloads.search({ id }),
    (await progress(key)).downloadId,
  );
  expect(await readFile(download.filename)).toEqual(data);
  await unlink(download.filename);
};

const job = (key: string) =>
  extensionWorker().evaluate(async key => {
    const state = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
    return (
      Object.values(state.jobs) as {
        requestId: string;
        state: string;
        recovery?: { attempts: number; nextRetryAt: number };
        executionId?: string;
      }[]
    ).find(job => job.requestId === key);
  }, key);
const half = async (key: string, path: string) => {
  await submit(key, path);
  await expect
    .poll(
      async () => (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
      { timeout: 10_000 },
    )
    .toBe(1);
  return (await progress(key)).downloadedBytes;
};

it('30 seconds offline automatically pauses and reconnects without repeating completed media intervals', async () => {
  const key = crypto.randomUUID(),
    path = '/offline.mp4';
  const retained = await half(key, path);
  const completed = (await progress(key)).chunks.find((chunk: { status: string }) => chunk.status === 'done');
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.context().setOffline(true);
    try {
      await expect.poll(async () => (await job(key))?.state, { timeout: 40_000 }).toBe('paused');
      expect((await job(key))?.recovery).toBeTruthy();
      await new Promise(resolve => setTimeout(resolve, 30_000));
      expect((await progress(key)).downloadedBytes).toBeGreaterThanOrEqual(retained);
      allowed.add(path);
    } finally {
      await page.context().setOffline(false);
    }
  });
  await expect.poll(async () => (await progress(key))?.stage, { timeout: 45_000 }).toBe('success');
  expect(
    requests.filter(
      request =>
        request.path === path &&
        request.method !== 'HEAD' &&
        request.range === `bytes=${completed.start}-${completed.end}`,
    ).length,
  ).toBe(1);
  await verifyOutput(key);
}, 120_000);

it('cancel while waiting for automatic recovery stops future alarms and deletes cache', async () => {
  const key = crypto.randomUUID(),
    path = '/cancel-auto.mp4';
  await half(key, path);
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.context().setOffline(true);
    try {
      await expect.poll(async () => (await job(key))?.state, { timeout: 40_000 }).toBe('paused');
      const cachedNames = await page.evaluate(async key => {
        const records = Object.values(
          (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records,
        ) as { jobKey: string; name: string }[];
        return records.filter(record => record.jobKey === key).map(record => record.name);
      }, key);
      await page.evaluate(
        async key => chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key, intent: 'cancel' } }),
        key,
      );
      await stage(key, 'cancelled');
      const remaining = await page.evaluate(async () => {
        const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
          keys(): AsyncIterableIterator<string>;
        };
        const names: string[] = [];
        for await (const name of root.keys()) names.push(name);
        return names;
      });
      expect(remaining.some(name => cachedNames.some(cached => name === cached || name.startsWith(`${cached}.`)))).toBe(
        false,
      );
    } finally {
      await page.context().setOffline(false);
    }
    allowed.add(path);
    const before = requests.filter(request => request.path === path).length;
    await new Promise(resolve => setTimeout(resolve, 32_000));
    expect(requests.filter(request => request.path === path).length).toBe(before);
    expect((await job(key))?.recovery).toBeUndefined();
    const names = await page.evaluate(async key => {
      const records = Object.values(
        (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records,
      ) as { jobKey: string; name: string }[];
      return records.filter(record => record.jobKey === key).map(record => record.name);
    }, key);
    expect(names).toEqual([]);
  });
}, 100_000);

it('persistent 403 stays failed and preserves progress without automatic retries', async () => {
  const key = crypto.randomUUID();
  await submit(key, '/forbidden.mp4');
  await stage(key, 'failed');
  expect((await job(key))?.recovery).toBeUndefined();
  expect((await progress(key)).error).toContain('403');
});

it('disconnecting during the final retry leaves a recoverable failure with cached bytes', async () => {
  const key = crypto.randomUUID(),
    path = '/last-retry.mp4';
  const retained = await half(key, path);
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(async key => {
      const value = (await chrome.storage.local.get('vidsy-download-runtime'))['vidsy-download-runtime'];
      const job = (
        Object.values(value.jobs) as {
          requestId: string;
          recovery?: { attempts: number; nextRetryAt: number; reason: string };
        }[]
      ).find(job => job.requestId === key)!;
      job.recovery = { attempts: 5, nextRetryAt: Date.now(), reason: 'Earlier connection failures' };
      await chrome.storage.local.set({ 'vidsy-download-runtime': value });
    }, key);
    await page.context().setOffline(true);
    try {
      await expect.poll(async () => (await job(key))?.state, { timeout: 40_000 }).toBe('failed');
      expect((await progress(key)).downloadedBytes).toBeGreaterThanOrEqual(retained);
      expect((await progress(key)).error).toContain('exhausted');
      expect((await job(key))?.recovery).toBeUndefined();
    } finally {
      await page.context().setOffline(false);
    }
    expect((await job(key))?.state).toBe('failed');
  });
});

it('a persistent recovery alarm restarts a suspended background and continues cached bytes', async () => {
  const key = crypto.randomUUID(),
    path = '/wake.mp4';
  await submit(key, path);
  await expect.poll(async () => (await job(key))?.state, { timeout: 15_000 }).toBe('paused');
  expect((await job(key))?.recovery).toBeTruthy();
  allowed.add(path);
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    const context = page.context();
    const session = await context.newCDPSession(page);
    const old = extensionWorker();
    await expect
      .poll(() => page.evaluate(async () => (await chrome.alarms.get('uuget-download-auto-recovery'))?.periodInMinutes))
      .toBe(0.5);
    let versions: { versionId: string; scriptURL: string; runningStatus: string }[] = [];
    session.on('ServiceWorker.workerVersionUpdated', event => {
      versions = event.versions;
    });
    await session.send('ServiceWorker.enable');
    await expect.poll(() => versions.find(version => version.scriptURL === old.url())?.versionId).toBeTruthy();
    const version = versions.find(version => version.scriptURL === old.url())!;
    await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await session.detach();
    // Storage reads from this already-open extension page do not wake background.
    // Some CDP versions retain the same worker target across stop/start, so use
    // the persisted result rather than relying on Playwright's target-created event.
    await expect
      .poll(
        () =>
          page.evaluate(
            async key => (await chrome.storage.local.get('media-downloads'))['media-downloads']?.[key]?.stage,
            key,
          ),
        { timeout: 75_000 },
      )
      .toBe('success');
  });
  await verifyOutput(key);
}, 95_000);
