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
  profile = await mkdtemp(join(tmpdir(), 'uuget-resume-m1-'));
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
const cacheNames = (key: string) =>
  extensionWorker().evaluate(
    async key =>
      Object.values((await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records)
        .filter((entry: unknown) => (entry as { jobKey: string }).jobKey === key)
        .map((entry: unknown) => (entry as { name: string }).name),
    key,
  );
const assertFilesRemoved = async (names: string[]) => {
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    const files = await page.evaluate(async () => {
      const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
        keys(): AsyncIterableIterator<string>;
      };
      const names: string[] = [];
      for await (const name of root.keys()) names.push(name);
      return names;
    });
    expect(files.some(file => names.some(name => file === name || file.startsWith(`${name}.`)))).toBe(false);
  });
};
const pauseHalf = async (key: string, path: string) => {
  await submit(key, path);
  await expect
    .poll(
      async () => (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
      { timeout: 10_000 },
    )
    .toBe(1);
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(
      async key => chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key, intent: 'pause' } }),
      key,
    );
  });
  await stage(key, 'paused');
  const paused = await progress(key);
  expect(paused.downloadedBytes / paused.estimatedBytes).toBeCloseTo(0.5, 2);
  return paused.chunks.find((chunk: { status: string }) => chunk.status === 'done');
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
const resumeAll = () =>
  withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.getByRole('button', { name: 'Resume all', exact: true }).click();
  });

it('browser restart restores a paused half-file and Resume all requests only missing media intervals', async () => {
  const key = crypto.randomUUID(),
    path = '/restart.mp4';
  const completed = await pauseHalf(key, path);
  await stopBrowser();
  await startBrowser();
  expect((await progress(key)).stage).toBe('paused');
  const before = requests.length;
  allowed.add(path);
  await resumeAll();
  await verifyOutput(key);
  const mediaRequests = requests.slice(before).filter(request => request.path === path && request.method !== 'HEAD');
  expect(mediaRequests.map(request => request.range)).toEqual([`bytes=${completed.end + 1}-${data.length - 1}`]);
  expect(
    requests.filter(request => request.path === path && request.range === `bytes=${completed.start}-${completed.end}`),
  ).toHaveLength(1);
});

it('an abrupt browser crash restores an interrupted task as paused from its durable checkpoint', async () => {
  const key = crypto.randomUUID(),
    path = '/crash.mp4';
  await submit(key, path);
  await expect
    .poll(
      async () => (await progress(key))?.chunks?.filter((chunk: { status: string }) => chunk.status === 'done').length,
      { timeout: 10_000 },
    )
    .toBe(1);
  const completed = (await progress(key)).chunks.find((chunk: { status: string }) => chunk.status === 'done');
  await withNewPage(async page => {
    const session = await page.context().browser()!.newBrowserCDPSession();
    const commandLine = await session.send('Browser.getBrowserCommandLine');
    expect(commandLine.arguments).toContain(`--user-data-dir=${profile}`);
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const browserProcess = processInfo.find(process => process.type === 'browser');
    expect(browserProcess).toBeDefined();
    process.kill(browserProcess!.id, 'SIGKILL');
  }).catch(error => {
    if (!/closed|destroyed/i.test(String(error))) throw error;
  });
  await stopBrowser();
  await startBrowser();
  await stage(key, 'paused');
  const before = requests.length;
  allowed.add(path);
  await resumeAll();
  await verifyOutput(key);
  expect(
    requests
      .slice(before)
      .filter(request => request.path === path && request.method !== 'HEAD')
      .map(request => request.range),
  ).toEqual([`bytes=${completed.end + 1}-${data.length - 1}`]);
});

it('extension reload restores retained checkpoints before continuing the same task', async () => {
  const key = crypto.randomUUID(),
    path = '/reload.mp4';
  const completed = await pauseHalf(key, path);
  const extensionId = new URL(extensionUrl('popup.html')).host;
  await withNewPage(async page => {
    await page.goto('chrome://extensions');
    await page.evaluate(() =>
      (
        chrome as unknown as { developerPrivate: { updateProfileConfiguration: (config: object) => void } }
      ).developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }),
    );
    await page.evaluate(
      async id =>
        new Promise<void>((resolve, reject) => {
          (
            chrome as unknown as {
              developerPrivate: { reload: (id: string, options: object, callback: () => void) => void };
            }
          ).developerPrivate.reload(id, { failQuietly: true }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        }),
      extensionId,
    );
  });
  await expect
    .poll(
      async () => {
        try {
          return await extensionWorker().evaluate(() => chrome.runtime.onMessage.hasListeners());
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const before = requests.length;
  expect((await progress(key)).stage).toBe('paused');
  allowed.add(path);
  await resumeAll();
  await verifyOutput(key);
  expect(
    requests
      .slice(before)
      .filter(request => request.path === path && request.method !== 'HEAD')
      .map(request => request.range),
  ).toEqual([`bytes=${completed.end + 1}-${data.length - 1}`]);
});

it('redetection matches the retained content fingerprint and continues its original task identity', async () => {
  const key = crypto.randomUUID(),
    path = '/deduplicate.mp4';
  const completed = await pauseHalf(key, path);
  allowed.add(path);
  const result = await submit(crypto.randomUUID(), path);
  expect(result.key).toBe(key);
  expect(result.resumed).toBe(true);
  await verifyOutput(key);
  expect((await progress(key)).resumeNotice).toContain('Resumed from 50%');
  expect(
    requests.filter(request => request.path === path && request.range === `bytes=${completed.start}-${completed.end}`),
  ).toHaveLength(1);
});

it('TTL removes expired partial files and checkpoints while leaving an actionable reason', async () => {
  const key = crypto.randomUUID(),
    path = '/ttl.mp4';
  await pauseHalf(key, path);
  const names = await cacheNames(key);
  await extensionWorker().evaluate(async key => {
    const ledger = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'];
    for (const record of Object.values(ledger.records) as {
      jobKey: string;
      createdAt: number;
      updatedAt: number;
      expiresAt: number;
    }[])
      if (record.jobKey === key) {
        record.createdAt = Date.now() - 9 * 24 * 60 * 60 * 1000;
        record.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
        record.expiresAt = Date.now() - 24 * 60 * 60 * 1000;
      }
    await chrome.storage.local.set({ 'uuget-download-cache': ledger });
    await chrome.runtime.sendMessage({ type: 'offscreen/collect-download-cache' });
  }, key);
  const records = await extensionWorker().evaluate(
    async () => (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'].records,
  );
  expect(Object.values(records).some((record: unknown) => (record as { jobKey: string }).jobKey === key)).toBe(false);
  expect((await progress(key)).resumeNotice).toContain('expired');
  await assertFilesRemoved(names);
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(
      async key => chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key, intent: 'cancel' } }),
      key,
    );
  });
});

it('capacity LRU removes the oldest paused input set and preserves the newer checkpoint', async () => {
  const old = crypto.randomUUID(),
    newer = crypto.randomUUID();
  await pauseHalf(old, '/lru-old.mp4');
  const oldNames = await cacheNames(old);
  await pauseHalf(newer, '/lru-new.mp4');
  await extensionWorker().evaluate(async key => {
    const ledger = (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'];
    const retained = Object.values(ledger.records).find(
      (entry: unknown) => (entry as { jobKey: string }).jobKey === key,
    ) as { size: number };
    const settings = (await chrome.storage.local.get('media-settings'))['media-settings'];
    await chrome.storage.local.set({ 'media-settings': { ...settings, cacheMaxBytes: retained.size + 1024 } });
    await chrome.runtime.sendMessage({ type: 'offscreen/collect-download-cache' });
  }, newer);
  expect(await cacheNames(old)).toEqual([]);
  expect((await cacheNames(newer)).length).toBeGreaterThan(0);
  await assertFilesRemoved(oldNames);
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(
      async keys => {
        for (const key of keys)
          await chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key, intent: 'cancel' } });
        const settings = (await chrome.storage.local.get('media-settings'))['media-settings'];
        delete settings.cacheMaxBytes;
        await chrome.storage.local.set({ 'media-settings': settings });
      },
      [old, newer],
    );
  });
});

it('cancel after a browser restart immediately removes retained files and the checkpoint ledger', async () => {
  const key = crypto.randomUUID(),
    path = '/cancel.mp4';
  await pauseHalf(key, path);
  const names = await cacheNames(key);
  await stopBrowser();
  await startBrowser();
  await withNewPage(async page => {
    await page.goto(extensionUrl('popup.html'));
    await page.evaluate(
      async key => chrome.runtime.sendMessage({ type: 'media/cancel', payload: { key, intent: 'cancel' } }),
      key,
    );
  });
  await stage(key, 'cancelled');
  const ledger = await extensionWorker().evaluate(
    async () => (await chrome.storage.local.get('uuget-download-cache'))['uuget-download-cache'],
  );
  expect(Object.values(ledger.records).some((record: unknown) => (record as { jobKey: string }).jobKey === key)).toBe(
    false,
  );
  await assertFilesRemoved(names);
});
